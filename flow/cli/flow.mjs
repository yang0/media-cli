#!/usr/bin/env node
import puppeteer from 'puppeteer-core';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fs from 'fs';
import path from 'path';
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
    default: 9222,
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

async function clearAndTypePrompt(page, prompt) {
  log('Filling prompt...');
  const textbox = await page.$('[role="textbox"]');
  if (!textbox) throw new Error('Prompt textbox not found');

  await textbox.click();
  await humanDelay();

  // Select all and replace
  await page.evaluate(() => {
    const el = document.querySelector('[role="textbox"]');
    if (el) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });
  await new Promise(r => setTimeout(r, 200));

  await textbox.type(prompt, { delay: 5 });
  log('Prompt entered:', prompt);
}

async function clickByText(page, text) {
  const clicked = await page.evaluate((t) => {
    const xpath = `//*[contains(text(), '${t}')]`;
    const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const el = result.singleNodeValue;
    if (el) {
      el.click();
      return true;
    }
    return false;
  }, text);
  return clicked;
}

async function addReferenceImage(page, ref, source) {
  log('Opening media picker...');
  const addBtn = await page.$('button[class*="sc-253cad92"]');
  if (!addBtn) throw new Error('Add media button not found');
  await addBtn.click();
  await humanDelay();
  await humanDelay();
  await saveDebug(page, 'media-picker-open');

  if (source === 'uploaded') {
    log('Selecting uploaded content tab...');
    const ok = await clickByText(page, '上传的内容');
    if (!ok) throw new Error('Could not open "Uploaded content" tab');
    await humanDelay();
    await humanDelay();
    await saveDebug(page, 'uploaded-tab');

    log(`Selecting reference image: ${ref}`);
    const clicked = await page.evaluate((name) => {
      const xpath = `//div[contains(text(), '${name}')]`;
      const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const el = result.singleNodeValue;
      if (el) {
        el.click();
        return true;
      }
      return false;
    }, ref);
    if (!clicked) throw new Error(`Reference image "${ref}" not found in uploaded content`);
    await humanDelay();
    await saveDebug(page, 'reference-selected');

    log('Adding reference to prompt...');
    const added = await clickByText(page, '添加到提示');
    if (!added) throw new Error('Could not click "Add to prompt"');
    await humanDelay();
    await humanDelay();
    await saveDebug(page, 'reference-added');
  } else {
    log('Uploading reference file:', ref);
    if (!fs.existsSync(ref)) throw new Error(`Reference file not found: ${ref}`);

    // Open "Upload media" tab
    const ok = await clickByText(page, '上传媒体');
    if (!ok) throw new Error('Could not open "Upload media" tab');
    await humanDelay();
    await humanDelay();

    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) throw new Error('File input not found');
    await fileInput.uploadFile(path.resolve(ref));
    await humanDelay();
    await humanDelay();
    await humanDelay();
    await saveDebug(page, 'file-uploaded');

    const added = await clickByText(page, '添加到提示');
    if (!added) throw new Error('Could not click "Add to prompt" after upload');
    await humanDelay();
    await humanDelay();
    await saveDebug(page, 'reference-added');
  }
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
  await settingsBtn.click();
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

async function clickCreate(page) {
  log('Preparing to click create...');
  // Dismiss any open popups/tooltips
  await page.keyboard.press('Escape');
  await humanDelay();

  // Wait for the page to be relatively idle
  try {
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 });
  } catch {}

  const createBtn = await page.$('button[class*="sc-26b30722-5"]');
  if (!createBtn) throw new Error('Create button not found');

  log('Clicking create...');
  try {
    await createBtn.click({ delay: 50 });
  } catch (err) {
    log('Puppeteer click failed, trying JS click:', err.message);
    await page.evaluate((cls) => {
      const btn = document.querySelector(`button[class*="${cls}"]`);
      if (btn) btn.click();
    }, 'sc-26b30722-5');
  }
  log('Create clicked.');
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

    browser = await connectBrowser(argv.port);
    const page = await getFlowPage(browser, argv.projectUrl);
    await saveDebug(page, 'page-ready');

    const savedPaths = [];
    for (let i = 0; i < finalPrompts.length; i++) {
      const path = await generateOne(page, finalPrompts[i], i, finalPrompts.length);
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
