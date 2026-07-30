#!/usr/bin/env node
import puppeteer from 'puppeteer-core';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 <prompt> [options]\n       $0 --batch <file> [options]')
  .positional('prompt', {
    describe: 'Image generation prompt (ignored when --batch is used)',
    type: 'string',
  })
  .option('batch', {
    alias: 'b',
    describe: 'Path to a prompt file. Each line is a prompt. After an empty line, the remaining lines are treated as a global suffix appended to each prompt.',
    type: 'string',
  })
  .option('ref', {
    alias: 'r',
    describe: 'Reference image name (uploaded) or file path',
    default: 'avatar.png',
    type: 'string',
  })
  .option('ref-source', {
    describe: 'Where to get the reference image: uploaded (project assets) or file (local path to upload)',
    choices: ['uploaded', 'file'],
    default: 'uploaded',
    type: 'string',
  })
  .option('video', {
    describe: 'Generate an image-to-video clip instead of an image',
    type: 'boolean',
    default: false,
  })
  .option('duration', {
    describe: 'Video duration in seconds',
    choices: [4, 6, 8, 10],
    default: 8,
    type: 'number',
  })
  .option('aspect', {
    describe: 'Aspect ratio',
    default: '16:9',
    type: 'string',
  })
  .option('count', {
    describe: 'Number of images, e.g. 1x, 2x, 4x',
    default: '1x',
    type: 'string',
  })
  .option('model', {
    describe: 'Model name',
    default: 'Nano Banana 2',
    type: 'string',
  })
  .option('port', {
    describe: 'Chrome DevTools Protocol port',
    default: 9221,
    type: 'number',
  })
  .option('output', {
    alias: 'o',
    describe: 'Output directory for downloaded images',
    default: './downloads',
    type: 'string',
  })
  .option('timeout', {
    describe: 'Maximum time to wait for generation (ms)',
    default: 300000,
    type: 'number',
  })
  .option('project-url', {
    describe: 'Google Flow project URL',
    default: 'https://labs.google/fx/zh/tools/flow/project/1d49f864-c38c-4365-b144-1d4e7d7d2ca2',
    type: 'string',
  })
  .option('debug', {
    describe: 'Save screenshots and DOM dumps on errors',
    default: false,
    type: 'boolean',
  })
  .help()
  .argv;

const DEBUG_DIR = path.join(__dirname, 'debug');

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function humanDelay() {
  const ms = Math.floor(1000 + Math.random() * 2000);
  return new Promise(r => setTimeout(r, ms));
}

async function selectVideoMode(page) {
  log('Switching to video mode...');
  let tab = await page.$('[role="tab"][aria-controls$="VIDEO"]');
  if (!tab) {
    const settingsButton = await page.$('button[class*="sc-93abd9dc"]');
    const current = settingsButton
      ? await settingsButton.evaluate(el => (el.innerText || el.textContent || '').trim())
      : '';
    if (/视频|video/i.test(current)) {
      log('Video mode is already selected.');
      return;
    }
    if (settingsButton) {
      log('Opening media settings to expose the video mode selector...');
      await settingsButton.evaluate(el => el.click());
      await humanDelay();
      await humanDelay();
      tab = await page.$('[role="tab"][aria-controls$="VIDEO"]');
    }
  }
  if (!tab) throw new Error('Flow video mode tab not found');
  await tab.evaluate(el => el.click());
  await humanDelay();
  await humanDelay();
  await page.waitForSelector('[role="textbox"]', { timeout: 30000 });
  log('Video mode selected.');
}

function parsePromptFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Prompt file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split(/\r?\n/);

  const prompts = [];
  const globalLines = [];
  let reachedGlobal = false;

  for (const line of lines) {
    if (line.trim() === '') {
      reachedGlobal = true;
      continue;
    }
    if (reachedGlobal) {
      globalLines.push(line);
    } else {
      prompts.push(line);
    }
  }

  const globalSuffix = globalLines.join(' ').trim();
  const cleanPrompts = prompts.map(p => p.trim()).filter(p => p.length > 0);

  if (cleanPrompts.length === 0) {
    throw new Error('No prompts found in file');
  }

  return { prompts: cleanPrompts, globalSuffix };
}

async function saveDebug(page, name) {
  if (!argv.debug) return;
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const ssPath = path.join(DEBUG_DIR, `${name}.png`);
  await page.screenshot({ path: ssPath, fullPage: false });
  log('Debug screenshot:', ssPath);
}

async function dumpDOM(page, name) {
  if (!argv.debug) return;
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const elements = await page.evaluate(() => {
    const results = [];
    const all = document.querySelectorAll('button, input, textarea, [role="button"], [role="textbox"], [role="combobox"], [role="listbox"], select, label, [role="menuitem"], [role="dialog"]');
    all.forEach((el) => {
      const text = (el.textContent || '').trim().slice(0, 160);
      const aria = el.getAttribute('aria-label') || '';
      const placeholder = el.getAttribute('placeholder') || '';
      const role = el.getAttribute('role') || el.tagName.toLowerCase();
      const type = el.type || '';
      const visible = el.offsetParent !== null;
      if (visible && (text || aria || placeholder || type === 'file')) {
        results.push({ tag: el.tagName.toLowerCase(), role, type, text, aria, placeholder });
      }
    });
    return results;
  });
  const dumpPath = path.join(DEBUG_DIR, `${name}.json`);
  fs.writeFileSync(dumpPath, JSON.stringify(elements, null, 2), 'utf-8');
  log('Debug DOM dump:', dumpPath);
}

async function connectBrowser(port) {
  log(`Connecting to Chrome on port ${port}...`);
  const browser = await puppeteer.connect({
    browserURL: `http://localhost:${port}`,
    defaultViewport: null,
    protocolTimeout: 300000,
  });
  log('Connected.');
  return browser;
}

async function getFlowPage(browser, url) {
  const pages = await browser.pages();
  let page = pages.find(p => p.url().includes('labs.google/fx'));
  if (!page) {
    log('Opening new Flow tab...');
    page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  } else {
    log('Reusing existing Flow tab:', page.url());
    if (!page.url().includes(url.split('/').pop())) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
    }
    await page.bringToFront();
  }
  await new Promise(r => setTimeout(r, 3000));
  return page;
}

async function clearAndTypePrompt(page, prompt, typingDelayMs = 5) {
  log('Filling prompt...');
  await page.waitForSelector('[role="textbox"]', { visible: true, timeout: 30000 });
  await page.focus('[role="textbox"]');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await new Promise(r => setTimeout(r, 250));
  await page.keyboard.type(prompt, { delay: typingDelayMs });
  log('Prompt entered:', prompt);
}

async function clickByText(page, text) {
  const found = await page.evaluate(targetText => {
    document.querySelectorAll('[data-flow-cli-target]').forEach(el => {
      el.removeAttribute('data-flow-cli-target');
    });
    const elements = [...document.querySelectorAll('button, [role="tab"], [role="option"], [role="menuitem"]')];
    const element = elements.find(el => {
      const rect = el.getBoundingClientRect();
      const label = (el.innerText || el.textContent || '').trim();
      return rect.width > 0 && rect.height > 0 && !el.disabled && label.includes(targetText);
    });
    if (!element) return false;
    element.setAttribute('data-flow-cli-target', 'true');
    return true;
  }, text);
  if (!found) return false;
  await page.focus('[data-flow-cli-target="true"]');
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    document.querySelector('[data-flow-cli-target="true"]')?.removeAttribute('data-flow-cli-target');
  });
  return true;
}

async function waitForEnabledButton(page, text, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const buttons = await page.$$('button');
    for (const button of buttons) {
      const state = await button.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return {
          text: (el.innerText || el.textContent || '').trim(),
          visible: rect.width > 0 && rect.height > 0,
          disabled: Boolean(el.disabled),
        };
      });
      if (state.visible && !state.disabled && state.text.includes(text)) return button;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`Button "${text}" did not become enabled within ${timeoutMs}ms`);
}

async function addReferenceImage(page, ref, source) {
  log('Opening media picker...');
  const addBtn = await page.$('button[aria-haspopup="dialog"][class*="sc-253cad92"]');
  if (!addBtn) throw new Error('Add media button not found');
  await addBtn.evaluate(el => el.click());
  await humanDelay();
  await humanDelay();
  const dialog = await page.$('[role="dialog"]');
  if (!dialog) throw new Error('Flow media picker did not open');
  await saveDebug(page, 'media-picker-open');

  if (source === 'uploaded') {
    log('Selecting uploaded content tab...');
    const ok = await clickByText(page, '上传的内容');
    if (!ok) throw new Error('Could not open "Uploaded content" tab');
    await humanDelay();
    await humanDelay();
    await saveDebug(page, 'uploaded-tab');

    log(`Selecting reference image: ${ref}`);
    const options = await dialog.$$('[role="option"]');
    let selected = false;
    for (const option of options) {
      const text = await option.evaluate(el => (el.innerText || el.textContent || '').trim());
      if (text.includes(ref)) {
        await option.evaluate(el => el.click());
        selected = true;
        break;
      }
    }
    if (!selected) throw new Error(`Reference image "${ref}" not found in uploaded content`);
    await humanDelay();
    await saveDebug(page, 'reference-selected');
  } else {
    log('Uploading reference file:', ref);
    if (!fs.existsSync(ref)) throw new Error(`Reference file not found: ${ref}`);
    const fileInput = await page.$('input[type="file"][accept="image/*"]');
    if (!fileInput) throw new Error('File input not found');
    await fileInput.uploadFile(path.resolve(ref));
    log('Waiting for Flow to process the uploaded image...');
    await saveDebug(page, 'file-uploaded');
  }

  if (await page.$('[role="dialog"]')) {
    const addToPrompt = await waitForEnabledButton(page, '添加到提示');
    await addToPrompt.evaluate(el => el.click());
    await page.waitForFunction(
      () => !document.querySelector('[role="dialog"]'),
      { timeout: 30000 },
    );
  }
  await humanDelay();
  await page.waitForSelector('[class*="sc-5c3af813"] img[src*="media.getMediaUrlRedirect"]', {
    timeout: 30000,
  });
  log('Reference image attached to the prompt.');
  await saveDebug(page, 'reference-added');
}

async function setSettings(page, model, aspect, count) {
  const settingsBtn = await page.$('button[class*="sc-93abd9dc"]');
  if (!settingsBtn) {
    log('Settings button not found, skipping (current defaults will be used)');
    return;
  }

  const currentText = await page.evaluate(el => el.textContent, settingsBtn);
  log('Current settings:', currentText);

  // If current settings already match, don't open the menu
  const aspectMap = { '16:9': 'crop_16_9', '1:1': 'crop_square', '9:16': 'crop_9_16', '4:3': 'crop_4_3', '3:4': 'crop_3_4' };
  const aspectIcon = aspectMap[aspect] || aspect;
  const expected = `${model}${aspectIcon}${count}`;
  if (currentText.replace(/\s+/g, '').includes(expected.replace(/\s+/g, ''))) {
    log('Settings already match target.');
    return;
  }

  log('Opening settings...');
  await page.focus('button[class*="sc-93abd9dc"]');
  await page.keyboard.press('Enter');
  await humanDelay();
  await humanDelay();
  await saveDebug(page, 'settings-open');
  await dumpDOM(page, 'settings-open');

  // Try to select model
  const modelClicked = await clickByText(page, model);
  if (modelClicked) log('Selected model:', model);

  // Try to select aspect/count by text or data attribute
  const aspectClicked = await clickByText(page, aspect);
  if (aspectClicked) log('Selected aspect:', aspect);

  const countClicked = await clickByText(page, count);
  if (countClicked) log('Selected count:', count);

  // Close settings by clicking outside or pressing Escape
  await page.keyboard.press('Escape');
  await humanDelay();
}

async function setVideoSettings(page, duration, aspect, count) {
  const settingsBtn = await page.$('button[class*="sc-93abd9dc"]');
  if (!settingsBtn) {
    log('Video settings button not found, keeping Flow defaults.');
    return;
  }

  const uiCount = /^(\d+)x$/i.test(count) ? `x${count.slice(0, -1)}` : count;
  log(`Setting video options: ${duration}s, ${aspect}, ${uiCount}...`);
  await page.focus('button[class*="sc-93abd9dc"]');
  await page.keyboard.press('Enter');
  await humanDelay();
  await humanDelay();
  await saveDebug(page, 'video-settings-open');
  await dumpDOM(page, 'video-settings-open');

  const durationClicked = await clickByText(page, `${duration}s`);
  if (!durationClicked) {
    throw new Error(`Could not select video duration ${duration}s`);
  }
  log('Selected video duration:', `${duration}s`);
  await humanDelay();

  const countClicked = await clickByText(page, uiCount);
  if (countClicked) {
    log('Selected video count:', uiCount);
    await humanDelay();
  }

  const aspectClicked = await clickByText(page, aspect);
  if (aspectClicked) {
    log('Selected video aspect:', aspect);
    await humanDelay();
  }

  await page.keyboard.press('Escape');
  await humanDelay();
}

async function clickCreate(page) {
  log('Preparing to click create...');
  // Dismiss any open popups/tooltips
  await page.keyboard.press('Escape');
  await humanDelay();

  // Wait for the page to be relatively idle
  try {
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 });
  } catch {}

  const createButtons = await page.$$('button');
  let createBtn = null;
  for (const button of createButtons) {
    const text = await button.evaluate(el => (el.innerText || el.textContent || '').trim());
    const visible = await button.isVisible().catch(() => false);
    const className = await button.evaluate(el => String(el.className || ''));
    const isSubmitButton = /arrow_forward/i.test(text) || className.includes('sc-5c3af813');
    if (visible && /(?:创建|Create)/i.test(text) && !(await button.evaluate(el => el.disabled))) {
      if (isSubmitButton && !className.includes('sc-253cad92')) createBtn = button;
    }
  }
  if (!createBtn) {
    const pageText = await page.evaluate(() => document.body.innerText || '');
    if (/点数不足|insufficient.+credits?/i.test(pageText)) {
      throw new Error('Google Flow 点数不足，无法提交视频生成。请降低时长/数量或充值后重试。');
    }
    throw new Error('Video submit button not found or is disabled');
  }

  log('Clicking create...');
  await createBtn.evaluate(el => el.click());
  log('Create clicked.');
}

function setupGenerationCapture(page) {
  const requests = [];
  const responses = [];
  const requestHandler = request => {
    const url = request.url();
    if (request.method() === 'POST' && /(?:api|generate|create|media|asset|project)/i.test(url)) {
      requests.push({ url, time: Date.now() });
    }
  };
  const responseHandler = response => {
    const url = response.url();
    if (/(?:api|generate|create|media|asset|project)/i.test(url)) {
      responses.push({ url, status: response.status(), time: Date.now() });
    }
  };
  page.on('request', requestHandler);
  page.on('response', responseHandler);
  return {
    requests,
    responses,
    stop: () => {
      page.off('request', requestHandler);
      page.off('response', responseHandler);
    },
  };
}

function setupImageCapture(page) {
  const captured = [];
  const handler = (response) => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';
    if (url.includes('media.getMediaUrlRedirect') || contentType.startsWith('image/')) {
      captured.push({ url, contentType, time: Date.now() });
    }
  };
  page.on('response', handler);
  return { captured, stop: () => page.off('response', handler) };
}

function setupVideoCapture(page) {
  const captured = [];
  const handler = (response) => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';
    if (contentType.startsWith('video/') || /(?:\.mp4|\.webm|media|getMediaUrlRedirect)/i.test(url)) {
      captured.push({ url, contentType, time: Date.now() });
    }
  };
  page.on('response', handler);
  return { captured, stop: () => page.off('response', handler) };
}

async function waitForGeneration(page, timeoutMs) {
  log('Waiting for generation to complete...');
  const start = Date.now();

  // The result card appears at the top of the media grid and shows a progress percentage.
  // Wait until the progress text disappears and an image is visible in the first card.
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 2000));

    const state = await page.evaluate(() => {
      const firstCard = document.querySelector('[class*="sc-"]'); // broad
      // Find cards that contain a percentage like 10%, 76%, etc.
      const allText = document.body.innerText;
      const progressMatch = allText.match(/(\d+)%/);
      const progress = progressMatch ? parseInt(progressMatch[1], 10) : null;

      // Try to find a result image in the first media card
      const cards = document.querySelectorAll('div[role="button"]');
      let newImageSrc = null;
      for (const card of cards) {
        const img = card.querySelector('img');
        if (img && img.src && img.src.startsWith('http')) {
          newImageSrc = img.src;
          break;
        }
      }
      return { progress, newImageSrc };
    });

    if (state.progress !== null) {
      log(`Generation progress: ${state.progress}%`);
    }

    if (state.newImageSrc && state.progress === null) {
      log('Generation complete.');
      return state.newImageSrc;
    }
  }

  throw new Error(`Generation did not complete within ${timeoutMs}ms`);
}

async function waitForVideoGeneration(page, capture, timeoutMs, baselineUrls = new Set()) {
  log('Waiting for video generation to complete...');
  const start = Date.now();
  let lastProgress = '';

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 2500));
    const state = await page.evaluate(() => {
      const urls = [];
      for (const video of document.querySelectorAll('video')) {
        for (const url of [video.currentSrc, video.src, ...Array.from(video.querySelectorAll('source')).map(s => s.src)]) {
          if (url && /^https?:/i.test(url)) urls.push(url);
        }
      }
      const progress = (document.body.innerText || '').match(/(\d+)%/);
      return { urls: [...new Set(urls)], progress: progress ? progress[0] : '' };
    });

    if (state.progress && state.progress !== lastProgress) {
      log(`Video generation progress: ${state.progress}`);
      lastProgress = state.progress;
    }

    const freshUrls = state.urls.filter(url => !baselineUrls.has(url));
    if (freshUrls.length) {
      log('Video element is ready.');
      return freshUrls[freshUrls.length - 1];
    }

    const captured = capture.captured
      .filter(item => /video\//i.test(item.contentType) || /(?:\.mp4|\.webm)/i.test(item.url))
      .sort((a, b) => b.time - a.time);
    if (captured.length) {
      log('Video response captured.');
      return captured[0].url;
    }
  }

  throw new Error(`Video generation did not complete within ${timeoutMs}ms`);
}

function extFromContentType(ct) {
  if (!ct) return '.png';
  const type = ct.toLowerCase().split(';')[0].trim();
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  };
  return map[type] || '.png';
}

async function downloadImage(page, imageUrl, outputDir, basenamePrefix = '') {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const tmpDir = path.join(__dirname, '.tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const basename = `${basenamePrefix}flow-${Date.now()}`;
  const tmpPath = path.join(tmpDir, `${basename}.tmp`);
  let contentType = 'image/png';

  log('Downloading image from:', imageUrl);

  let response;
  try {
    response = await page.evaluate(async (url) => {
      const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get('content-type') || 'image/png';
      const blob = await res.blob();
      const reader = new FileReader();
      const dataUrl = await new Promise((resolve, reject) => {
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      return { dataUrl, contentType: ct };
    }, imageUrl);
  } catch (err) {
    log('Page-context fetch failed:', err.message);
  }

  if (response && response.dataUrl && response.dataUrl.startsWith('data:')) {
    contentType = response.contentType || contentType;
    const base64 = response.dataUrl.split(',')[1];
    fs.writeFileSync(tmpPath, Buffer.from(base64, 'base64'));
  } else {
    // Fallback: use Node fetch with cookies extracted via CDP
    const cookies = await page.cookies(imageUrl);
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const nodeRes = await fetch(imageUrl, {
      headers: { Cookie: cookieStr },
      redirect: 'follow',
    });
    if (!nodeRes.ok) throw new Error(`Download failed: HTTP ${nodeRes.status}`);
    contentType = nodeRes.headers.get('content-type') || contentType;
    const buffer = Buffer.from(await nodeRes.arrayBuffer());
    fs.writeFileSync(tmpPath, buffer);
  }

  // Move to target directory with correct extension
  const outPath = path.join(outputDir, `${basename}${extFromContentType(contentType)}`);
  fs.renameSync(tmpPath, outPath);
  log('Saved:', outPath);
  return outPath;
}

async function downloadVideo(page, videoUrl, outputDir, basenamePrefix = '') {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const tmpDir = path.join(__dirname, '.tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const basename = `${basenamePrefix}flow-video-${Date.now()}`;
  const tmpPath = path.join(tmpDir, `${basename}.tmp`);
  let contentType = 'video/mp4';
  log('Downloading video from:', videoUrl);

  const cookies = await page.cookies(videoUrl);
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const nodeRes = await fetch(videoUrl, {
    headers: { Cookie: cookieStr, Referer: 'https://labs.google/' },
    redirect: 'follow',
  });
  if (!nodeRes.ok) throw new Error(`Video download failed: HTTP ${nodeRes.status}`);
  contentType = nodeRes.headers.get('content-type') || contentType;
  fs.writeFileSync(tmpPath, Buffer.from(await nodeRes.arrayBuffer()));

  const extension = contentType.toLowerCase().includes('webm') ? '.webm' : '.mp4';
  const outPath = path.join(outputDir, `${basename}${extension}`);
  fs.renameSync(tmpPath, outPath);
  log('Saved:', outPath);
  return outPath;
}

function runFfmpeg(args) {
  return execFileSync('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function readRgbThumbnail(inputPath) {
  return runFfmpeg([
    '-v', 'error', '-i', inputPath,
    '-vf', 'scale=32:32:force_original_aspect_ratio=decrease,pad=32:32:(ow-iw)/2:(oh-ih)/2:color=black',
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ]);
}

function compareReferenceFrame(referencePath, videoPath, outputDir, basenamePrefix = '') {
  const framePath = path.join(outputDir, `${basenamePrefix}flow-video-first-frame.jpg`);
  runFfmpeg(['-y', '-v', 'error', '-i', videoPath, '-frames:v', '1', '-q:v', '2', framePath]);
  const reference = readRgbThumbnail(referencePath);
  const frame = readRgbThumbnail(videoPath);
  const size = Math.min(reference.length, frame.length);
  let total = 0;
  for (let i = 0; i < size; i++) total += Math.abs(reference[i] - frame[i]);
  const similarity = Math.max(0, 1 - total / size / 255);
  log(`Reference first-frame similarity: ${(similarity * 100).toFixed(1)}% (首帧: ${framePath})`);
  if (similarity < 0.75) {
    throw new Error(`Video first frame is unrelated to the reference image (similarity ${(similarity * 100).toFixed(1)}%). Saved frame: ${framePath}`);
  }
  return { framePath, similarity };
}

async function generateOne(page, prompt, index, total) {
  const prefix = total > 1 ? `${String(index + 1).padStart(3, '0')}-` : '';
  log(`\n[${index + 1}/${total}] Generating: ${prompt}`);

  // Refresh the page for a clean state on each generation (important for batch reliability)
  log('Refreshing page for clean state...');
  await page.goto(argv.projectUrl, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForSelector('[role="textbox"]', { timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));
  await saveDebug(page, `${prefix}page-ready`);

  await clearAndTypePrompt(page, prompt);
  await humanDelay();
  await addReferenceImage(page, argv.ref, argv.refSource);
  await humanDelay();
  await setSettings(page, argv.model, argv.aspect, argv.count);
  await humanDelay();

  const capture = setupImageCapture(page);
  await clickCreate(page);

  await saveDebug(page, `${prefix}after-create-click`);
  const firstImageUrl = await waitForGeneration(page, argv.timeout);
  await saveDebug(page, `${prefix}generation-complete`);

  // Prefer the most recent captured image URL, fallback to the DOM src
  const imageUrl = capture.captured.length
    ? capture.captured.sort((a, b) => b.time - a.time)[0].url
    : firstImageUrl;
  capture.stop();

  const savedPath = await downloadImage(page, imageUrl, argv.output, prefix);
  log(`[${index + 1}/${total}] Saved:`, savedPath);
  return savedPath;
}

async function generateVideoOne(page, prompt, index, total) {
  const prefix = total > 1 ? `${String(index + 1).padStart(3, '0')}-` : '';
  log(`\n[${index + 1}/${total}] Generating image-to-video: ${prompt}`);

  log('Refreshing page for clean state...');
  await page.goto(argv.projectUrl, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForSelector('[role="textbox"]', { timeout: 30000 });
  await new Promise(r => setTimeout(r, 2500));
  await selectVideoMode(page);
  await saveDebug(page, `${prefix}video-page-ready`);

  await clearAndTypePrompt(page, prompt, 35 + Math.floor(Math.random() * 46));
  await humanDelay();
  await setVideoSettings(page, argv.duration, argv.aspect, argv.count);
  await humanDelay();
  await addReferenceImage(page, argv.ref, argv.refSource);
  await humanDelay();

  const baselineVideoUrls = new Set(await page.evaluate(() => {
    const urls = [];
    for (const video of document.querySelectorAll('video')) {
      for (const url of [video.currentSrc, video.src, ...Array.from(video.querySelectorAll('source')).map(s => s.src)]) {
        if (url && /^https?:/i.test(url)) urls.push(url);
      }
    }
    return [...new Set(urls)];
  }));
  const generation = setupGenerationCapture(page);
  const capture = setupVideoCapture(page);
  await clickCreate(page);
  await saveDebug(page, `${prefix}video-after-create-click`);
  await new Promise(r => setTimeout(r, 1500));
  if (!generation.requests.length) {
    generation.stop();
    capture.stop();
    throw new Error('Create click did not produce a generation request; no new video was submitted.');
  }
  log(`Generation request detected: ${generation.requests[generation.requests.length - 1].url}`);
  const videoUrl = await waitForVideoGeneration(page, capture, argv.timeout, baselineVideoUrls);
  generation.stop();
  capture.stop();
  await saveDebug(page, `${prefix}video-generation-complete`);

  const savedPath = await downloadVideo(page, videoUrl, argv.output, prefix);
  if (argv.refSource === 'file') {
    compareReferenceFrame(argv.ref, savedPath, argv.output, prefix);
  } else {
    log('Skipping automatic first-frame comparison because the reference is a project asset name.');
  }
  log(`[${index + 1}/${total}] Saved:`, savedPath);
  return savedPath;
}

async function main() {
  let browser;
  try {
    // Validate input
    let prompts = [];
    let globalSuffix = '';

    if (argv.batch) {
      const parsed = parsePromptFile(argv.batch);
      prompts = parsed.prompts;
      globalSuffix = parsed.globalSuffix;
      log(`Loaded ${prompts.length} prompt(s) from ${argv.batch}`);
      if (globalSuffix) log('Global suffix:', globalSuffix);
    } else {
      const singlePrompt = Array.isArray(argv._) && argv._.length ? argv._.join(' ') : '';
      if (!singlePrompt) {
        console.error('Error: Please provide a prompt or use --batch <file>');
        process.exit(1);
      }
      prompts = [singlePrompt];
    }

    // Build final prompts with global suffix
    const finalPrompts = prompts.map(p => globalSuffix ? `${p} ${globalSuffix}` : p);

    if (argv.video && argv.refSource === 'uploaded' && fs.existsSync(argv.ref)) {
      log('Local reference path detected; using --ref-source file for video generation.');
      argv.refSource = 'file';
    }
    if (argv.video && !fs.existsSync(argv.ref) && argv.refSource === 'file') {
      throw new Error(`Video reference file not found: ${argv.ref}`);
    }

    browser = await connectBrowser(argv.port);
    const page = await getFlowPage(browser, argv.projectUrl);
    await saveDebug(page, 'page-ready');

    const savedPaths = [];
    for (let i = 0; i < finalPrompts.length; i++) {
      const path = argv.video
        ? await generateVideoOne(page, finalPrompts[i], i, finalPrompts.length)
        : await generateOne(page, finalPrompts[i], i, finalPrompts.length);
      savedPaths.push(path);
      if (i < finalPrompts.length - 1) {
        log('Moving to next prompt...');
        await humanDelay();
        await humanDelay();
      }
    }

    log('\nAll done. Files:');
    savedPaths.forEach(p => log(' -', p));
  } catch (err) {
    console.error('Error:', err.message);
    if (browser) {
      try {
        const pages = await browser.pages();
        const page = pages.find(p => p.url().includes('labs.google/fx'));
        if (page) await saveDebug(page, 'error');
      } catch {}
    }
    process.exit(1);
  } finally {
    if (browser) await browser.disconnect();
  }
}

main();
