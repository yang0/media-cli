import path from 'node:path';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { accountStateFields, bumpAccountUsage, chooseAccount, listAccountPoolStatus, loadAccountPool, loadPoolDayState, markAccountBlocked } from './accounts/pool.js';
import { parseArgs, usage } from './args.js';
import { CdpClient, evaluate, findOrCreateTarget, pageSnapshot, uiSnapshot, waitForComposer, waitForConcreteChatUrl, waitForPageReady } from './cdp.js';
import { attachFiles, prepareImageComposer, prepareVideoComposer, sendCharacterContext, submitPrompt, waitForResponseText } from './chat/compose.js';
import { imageGenerationUiSnapshot, isAccountRestrictedError, lastReplySnapshot, parseRemainingQuota } from './chat/reply.js';
import { DEFAULT_ACCOUNT_POOL, DEFAULT_SESSION, DEFAULT_SESSION_STATE, DEFAULT_VIDEO_DURATION, DOLA_CHAT_HOME } from './config.js';
import { DolaCliError } from './errors.js';
import { clearImageHook, collectDomImages, collectHookImages, imageDebugSnapshot, installImageHook, installNetworkImageCapture } from './media/capture.js';
import { downloadImages, recoverPendingDownload, waitForDownloadItems } from './media/download.js';
import { normalizeImageKey } from './media/urls.js';
import { loadBatchPrompts, loadPrompt } from './prompts.js';
import { detectDolaLoginState, isChatHomeUrl, normalizeSession, openAccountSession, startFreshChat } from './session.js';
import { accountDayKey, askRequired, inferCompletedOutput, normalizeFiles, readJsonFile, sleep, writeJsonFile } from './utils.js';
import { activateLatestVideoPlayer, ensureVideoGenerationMode, hoverLatestVideoCard, openLatestVideoMoreMenu, selectVideoOptions } from './video/mode.js';
import { installVideoRequestPatch } from './video/patch.js';
import { collectDomVideos, installVideoResolveHelpers } from './video/resolve.js';

export async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return usage();

  const sessionStateFile = path.resolve(args.sessionState || DEFAULT_SESSION_STATE);
  const savedState = await readJsonFile(sessionStateFile);
  const accountPoolFile = path.resolve(args.accountPool || DEFAULT_ACCOUNT_POOL);
  if (args.listAccounts) {
    const status = await listAccountPoolStatus(accountPoolFile, savedState);
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  let accountPool = await loadAccountPool(accountPoolFile);
  const accountDay = accountDayKey();
  const poolDayState = loadPoolDayState(savedState, accountDay);
  // Pre-mark accounts with unusable cookie files so chooseAccount can skip them.
  for (const account of accountPool) {
    if (account.health && account.health.ok === false) {
      markAccountBlocked(poolDayState, account.id, account.health.error || "invalid-cookies");
    }
  }
  const pendingRecoverySession = args.resume && savedState?.inFlight?.sessionUrl
    ? savedState.inFlight.sessionUrl
    : "";
  let activeAccount = chooseAccount(
    accountPool,
    poolDayState,
    args.accountId || savedState?.accountId || "",
    { requireHealthyCookies: true }
  );
  if (activeAccount) {
    // An explicit --cdp is useful when a temporary/debug Chrome instance is
    // running on a non-default port. Pool entries provide the fallback only.
    if (!args.cdpExplicit) args.cdp = activeAccount.cdp;
    // Image + video both stay on /chat (avoid /chat/create-image gallery traffic).
    args.session = pendingRecoverySession
      || (args.newChat ? DOLA_CHAT_HOME : (activeAccount.session || args.session || savedState?.lastSessionUrl));
    console.log(`[dola-cli] using account ${activeAccount.id} (usage today: ${Number(poolDayState.usage[activeAccount.id]) || 0})`);
  }
  if (!args.session && !args.newChat && args.resume && savedState?.lastSessionUrl) {
    args.session = savedState.lastSessionUrl;
    console.log(`[dola-cli] resuming remembered session ${args.session}`);
  }
  if (!args.session && !args.newChat && !args.resume) {
    args.autoSession = true;
    args.session = DOLA_CHAT_HOME;
    console.log(`[dola-cli] no session specified; reusing an open Dola chat or creating one`);
  }
  if (args.newChat && !pendingRecoverySession) args.session = DOLA_CHAT_HOME;
  if (activeAccount && !args.newChat && !args.session) {
    throw new Error(`Account ${activeAccount.id} needs a session URL, or use --new-chat.`);
  }
  if (!args.session) args.session = await askRequired(`Dola chat session URL or id (required, example ${DEFAULT_SESSION}): `);

  let sessionUrl = normalizeSession(args.session);
  const allPromptEntries = args.dryRun || args.debugUi || args.debugImages || args.debugVideoMenu || args.downloadLastVideo
    ? []
    : args.batchPromptFile
      ? await loadBatchPrompts(args.batchPromptFile)
      : [{ text: await loadPrompt(args), line: null }];
  const promptEntries = allPromptEntries.filter(item => {
    const line = typeof item === "string" ? null : item.line;
    if (line === null) return true;
    if (args.fromLine !== undefined && line < args.fromLine) return false;
    if (args.toLine !== undefined && line > args.toLine) return false;
    return true;
  });
  const files = args.dryRun || args.debugUi || args.debugImages || args.debugVideoMenu ? [] : await normalizeFiles(args.files);
  const characterImage = args.dryRun || args.debugUi || args.debugImages || args.debugVideoMenu
    ? []
    : args.characterImage
      ? await normalizeFiles([args.characterImage])
      : [];
  if (!args.dryRun && !args.debugUi && !args.debugImages && !args.debugVideoMenu && !args.downloadLastVideo && !promptEntries.length) throw new Error("prompt is required.");
  const outputDir = path.resolve(args.out);
  const inferredCompleted = args.resume ? await inferCompletedOutput(outputDir) : [];
  const savedCompleted = args.resume && Array.isArray(savedState?.completed) ? savedState.completed : [];
  const completedByLine = new Map();
  for (const item of [...inferredCompleted, ...savedCompleted]) {
    if (item?.line && item?.file) completedByLine.set(Number(item.line), item);
  }
  if (args.resume && savedState?.batchPromptFile && path.resolve(savedState.batchPromptFile) !== path.resolve(args.batchPromptFile)) {
    throw new Error(`--resume state belongs to a different batch prompt file: ${savedState.batchPromptFile}`);
  }
  if (args.resume && savedState?.characterImage && path.resolve(savedState.characterImage) !== path.resolve(args.characterImage)) {
    throw new Error(`--resume state belongs to a different character image: ${savedState.characterImage}`);
  }
  if (args.resume && savedState?.accountPoolFile && path.resolve(savedState.accountPoolFile) !== accountPoolFile) {
    throw new Error(`--resume state belongs to a different account pool: ${savedState.accountPoolFile}`);
  }

  console.log(`[dola-cli] connecting CDP ${args.cdp}`);
  const opened = await openAccountSession(
    args.cdp,
    sessionUrl,
    // Force a dedicated tab for new video chats so we do not attach to an old image thread.
    Boolean(args.newChat || ((activeAccount) && !args.videoGen && !args.autoSession)),
    args.resume,
    activeAccount,
    Boolean(!args.newChat && (args.videoGen || args.autoSession))
  );
  let client = opened.client;
  let currentUrl = opened.currentUrl;
  const poolState = () => accountStateFields(accountPoolFile, activeAccount, poolDayState);

  await waitForPageReady(client).catch(() => {});
  await waitForComposer(client, 45000).catch(() => {});
  if (activeAccount?.cookieFile) {
    const login = await detectDolaLoginState(client);
    if (login.hasLoginPrompt && !login.looksLoggedIn) {
      console.log(`[dola-cli] warning: account ${activeAccount.id} may not be logged in after cookie inject`);
    } else if (login.looksLoggedIn) {
      console.log(`[dola-cli] account ${activeAccount.id} login looks active`);
    }
  }
  const before = await pageSnapshot(client).catch(() => ({ url: currentUrl, title: "", textTail: "", inputCount: 0, fileInputCount: 0 }));
  console.log(`[dola-cli] session ${currentUrl}`);
  if (args.newChat && !args.debugImages && !args.debugVideoMenu && !args.downloadLastVideo) {
    await startFreshChat(client).catch(error => {
      console.log(`[dola-cli] fresh chat helper failed (${error.message}); continuing on current session`);
    });
    currentUrl = await evaluate(client, "location.href").catch(() => currentUrl);
    await waitForComposer(client, 30000).catch(() => {});
    console.log(`[dola-cli] fresh chat ready ${currentUrl}`);
  }
  if (args.videoGen) {
    await installVideoRequestPatch(client, args);
    await installVideoResolveHelpers(client);
  }
  if (args.debugUi) {
    if (args.videoGen) {
      await ensureVideoGenerationMode(client);
      await selectVideoOptions(client, args);
    }
    console.log(JSON.stringify({ ui: await uiSnapshot(client), generation: await imageGenerationUiSnapshot(client) }, null, 2));
    client.close();
    return;
  }
  if (args.debugImages) {
    const debugRecords = [];
    installNetworkImageCapture(client, debugRecords);
    if (args.videoGen) {
      await activateLatestVideoPlayer(client);
      await hoverLatestVideoCard(client);
      await sleep(1000);
    }
    console.log(JSON.stringify({ images: await imageDebugSnapshot(client), lastReply: await lastReplySnapshot(client), captured: debugRecords }, null, 2));
    client.close();
    return;
  }
  if (args.debugVideoMenu) {
    await activateLatestVideoPlayer(client);
    await hoverLatestVideoCard(client);
    await openLatestVideoMoreMenu(client);
    console.log(JSON.stringify({ ui: await uiSnapshot(client), page: await pageSnapshot(client) }, null, 2));
    client.close();
    return;
  }
  if (args.downloadLastVideo) {
    await activateLatestVideoPlayer(client);
    const videos = await collectDomVideos(client);
    if (!videos.length) throw new DolaCliError("VIDEO_GENERATION_NO_VIDEO", "No downloadable video was found in the current Dola chat.");
    const downloaded = await downloadImages(videos.slice(-args.count), outputDir, { ...args, hashNaming: true });
    console.log(JSON.stringify({ sessionUrl: currentUrl, videoGeneration: true, downloaded }, null, 2));
    client.close();
    return;
  }
  if (args.dryRun) {
    console.log(JSON.stringify({ sessionUrl, currentUrl, page: before }, null, 2));
    client.close();
    return;
  }

  // Reseller-aligned prep:
  //   video: 视频生成 → duration/size → attach 0–n refs → (later) prompt → send
  //   image: 图像生成 → attach 0–n refs → (later) prompt → send
  //   plain chat: optional attach only
  await waitForComposer(client, 45000).catch(() => {});
  let attached = [];
  if (args.videoGen) {
    attached = await prepareVideoComposer(client, args, files);
    args.modePrepared = true;
  } else if (args.imageGen) {
    attached = await prepareImageComposer(client, args, files);
    args.modePrepared = true;
  } else if (files.length) {
    attached = await attachFiles(client, files);
  }
  console.log(
    `[dola-cli] composer ready: video=${Boolean(args.videoGen)} image=${Boolean(args.imageGen)}`
    + ` refs=${attached.length} duration=${args.duration || "-"} ratio=${args.aspectRatio || "-"}`
  );
  const capturedRecords = [];
  installNetworkImageCapture(client, capturedRecords);

  const results = [];
  const seenHashes = new Map();
  let forceCharacterContext = false;
  const switchRestrictedAccount = async (error, lineNumber) => {
    if (!accountPool.length || !activeAccount || !isAccountRestrictedError(error)) return false;
    const reason = error?.code || "restricted";
    if (accountPool.length === 1) {
      markAccountBlocked(poolDayState, activeAccount.id, reason);
      await writeJsonFile(sessionStateFile, {
        ...(savedState || {}),
        ...poolState(),
        version: 1,
        lastSessionUrl: currentUrl,
        failedLine: lineNumber,
        updatedAt: new Date().toISOString(),
      });
      console.log(`[dola-cli] single-account pool; marked ${activeAccount.id} as ${reason}, cannot switch`);
      return false;
    }
    markAccountBlocked(poolDayState, activeAccount.id, reason);
    await writeJsonFile(sessionStateFile, {
      ...(savedState || {}),
      ...poolState(),
      version: 1,
      lastSessionUrl: currentUrl,
      failedLine: lineNumber,
      updatedAt: new Date().toISOString(),
    });
    if (accountPoolFile) accountPool = await loadAccountPool(accountPoolFile);
    let nextAccount;
    try {
      nextAccount = chooseAccount(accountPool, poolDayState, "", { requireHealthyCookies: true });
    } catch (poolError) {
      throw poolError;
    }
    console.log(`[dola-cli] account ${activeAccount.id} blocked (${reason}); switching to ${nextAccount.id}`);
    try { client.close(); } catch {}
    capturedRecords.length = 0;
    activeAccount = nextAccount;
    if (!args.cdpExplicit) args.cdp = activeAccount.cdp;
    // Always open a clean Dola home tab when rotating accounts to avoid mixing sessions.
    sessionUrl = normalizeSession(DOLA_CHAT_HOME);
    const nextOpened = await openAccountSession(args.cdp, sessionUrl, true, false, activeAccount, false);
    client = nextOpened.client;
    currentUrl = nextOpened.currentUrl;
    await waitForPageReady(client).catch(() => {});
    await waitForComposer(client, 45000).catch(() => {});
    await startFreshChat(client).catch(() => {});
    currentUrl = await evaluate(client, "location.href").catch(() => currentUrl);
    const login = await detectDolaLoginState(client);
    if (login.hasLoginPrompt && !login.looksLoggedIn) {
      markAccountBlocked(poolDayState, activeAccount.id, "login-failed");
      await writeJsonFile(sessionStateFile, {
        ...(savedState || {}),
        ...poolState(),
        version: 1,
        lastSessionUrl: currentUrl,
        failedLine: lineNumber,
        updatedAt: new Date().toISOString(),
      });
      // Recurse once into another account if possible.
      return switchRestrictedAccount(
        new DolaCliError("ACCOUNT_COOKIE_INVALID", `Account ${activeAccount.id} cookie login failed.`, { accountId: activeAccount.id }),
        lineNumber
      );
    }
    await installImageHook(client);
    if (args.videoGen) {
      await installVideoRequestPatch(client, args);
      await installVideoResolveHelpers(client);
    }
    installNetworkImageCapture(client, capturedRecords);
    forceCharacterContext = Boolean(args.characterImage);
    console.log(`[dola-cli] switched to account ${activeAccount.id}; session ${currentUrl}`);
    return true;
  };
  for (const [index, promptEntry] of promptEntries.entries()) {
    const promptText = typeof promptEntry === "string" ? promptEntry : promptEntry.text;
    const lineNumber = typeof promptEntry === "string" ? index + 1 : promptEntry.line;
    const completed = completedByLine.get(lineNumber);
    if (args.resume && completed?.file && await access(completed.file, fsConstants.R_OK).then(() => true).catch(() => false)) {
      if (completed.hash) seenHashes.set(completed.hash, { line: lineNumber, file: completed.file });
      console.log(`[dola-cli] resume skip line ${lineNumber}: ${completed.file}`);
      results.push({ index: index + 1, line: lineNumber, prompt: promptText, skipped: true, downloaded: [{ ...completed }] });
      continue;
    }
    if (args.resume && savedState?.inFlight?.line === lineNumber && !completed) {
      console.log(`[dola-cli] recovering interrupted line ${lineNumber} before submitting again`);
      const recoveredItems = await recoverPendingDownload(client, capturedRecords, savedState.inFlight, {
        ...args,
        count: 1,
        promptText,
        // Images may fall back to watermarked; video keeps no-watermark preference unless --allow-watermark.
        watermarkFallback: !args.videoGen,
      });
      if (recoveredItems) {
        const recoveredDownloaded = await downloadImages(recoveredItems, path.resolve(args.out), {
          ...args,
          lineNumber,
          hashNaming: true,
          watermarkFallback: !args.videoGen,
          seenHashes,
        });
        for (const item of recoveredDownloaded) {
          completedByLine.set(Number(lineNumber), {
            line: lineNumber,
            hash: item.hash,
            shortHash: item.shortHash,
            file: item.file,
            prompt: promptText,
          });
        }
        await writeJsonFile(sessionStateFile, {
          ...(savedState || {}),
          ...poolState(),
          version: 1,
          lastSessionUrl: currentUrl,
          batchPromptFile: path.resolve(args.batchPromptFile),
          characterImage: args.characterImage ? path.resolve(args.characterImage) : "",
          characterPrompt: args.characterPrompt || "",
          characterBatchSize: args.characterBatchSize || null,
          completed: [...completedByLine.values()].filter(item => item.line && item.file),
          inFlight: null,
          updatedAt: new Date().toISOString(),
        });
        results.push({ index: index + 1, line: lineNumber, prompt: promptText, recovered: true, downloaded: recoveredDownloaded });
        continue;
      }
      const recoveryAnswer = await askRequired(
        `[dola-cli] 涓柇鐨勭 ${lineNumber} 鏉″湪鍘熶細璇濅腑娌℃湁纭鍒板浘鐗囥€傝妫€鏌?Dola 椤甸潰锛涚‘璁ょ‘瀹炴病鏈夊浘鐗囪杈撳叆 yes锛岄〉闈㈡湁鍥剧墖璇疯緭鍏?no: `
      );
      if (!/^(y|yes|\u662f|\u6ca1\u6709|\u65e0\u56fe|\u786e\u8ba4)$/i.test(recoveryAnswer.trim())) {
        throw new DolaCliError("IMAGE_GENERATION_UNCONFIRMED", `Could not confirm an image for interrupted line ${lineNumber}.`, {
          failedLine: lineNumber,
          userConfirmedPageHasImage: true,
        });
      }
      console.log(`[dola-cli] confirmed no image for interrupted line ${lineNumber}; opening a fresh chat session`);
      await client.send("Page.navigate", { url: DOLA_CHAT_HOME });
      await waitForPageReady(client);
      await sleep(3000);
      currentUrl = await evaluate(client, "location.href").catch(() => DOLA_CHAT_HOME);
      await installImageHook(client);
      if (args.videoGen) {
        await installVideoRequestPatch(client, args);
        await installVideoResolveHelpers(client);
      }
      capturedRecords.length = 0;
      installNetworkImageCapture(client, capturedRecords);
      forceCharacterContext = Boolean(args.characterImage);
    }
    let attempt = 0;
    while (true) {
      try {
      const firstProcessedPrompt = results.every(item => item.skipped);
      if (args.characterImage && (index % args.characterBatchSize === 0 || (args.newChat && firstProcessedPrompt) || attempt > 0 || forceCharacterContext)) {
        console.log(`[dola-cli] refreshing character context before prompt ${index + 1}/${promptEntries.length}`);
        await sendCharacterContext(client, characterImage[0], args.characterPrompt, args);
        forceCharacterContext = false;
      }

      // Keep pre-submit work minimal after large reference uploads (heavy DOM freezes CDP).
      await clearImageHook(client).catch(() => {});
      const beforeResponse = args.videoGen
        ? { textTail: "" }
        : await pageSnapshot(client).catch(() => ({ textTail: "" }));
      const beforeImageRecords = args.videoGen
        ? [...capturedRecords]
        : [
          ...capturedRecords,
          ...(await collectHookImages(client).catch(() => [])),
          ...(await collectDomImages(client).catch(() => [])),
        ];
      const beforeImageUrls = new Set(beforeImageRecords.map(item => item.url));
      const beforeImageKeys = new Set(
        beforeImageRecords
          .map(item => normalizeImageKey(item.key || item.url))
          .filter(Boolean)
      );
      const beforeGenerationUi = args.videoGen
        ? null
        : ((args.imageGen)
          ? await imageGenerationUiSnapshot(client).catch(() => null)
          : null);
      capturedRecords.length = 0;

      await writeJsonFile(sessionStateFile, {
        ...(savedState || {}),
        ...poolState(),
        version: 1,
        lastSessionUrl: currentUrl,
        completed: [...completedByLine.values()].filter(item => item.line && item.file),
        inFlight: {
          line: lineNumber,
          prompt: promptText,
          sessionUrl: currentUrl,
          accountId: activeAccount?.id || "",
          beforeUrls: [...beforeImageUrls],
          beforeImageKeys: [...beforeImageKeys],
        },
        updatedAt: new Date().toISOString(),
      }).catch(() => {});

      if (args.batchPromptFile) console.log(`[dola-cli] batch prompt ${lineNumber ?? index + 1}/${promptEntries.length}`);
      console.log("[dola-cli] step: fill prompt + submit");
      // Mode + refs already prepared; only fill prompt and send.
      const submit = await submitPrompt(client, promptText, { ...args, modePrepared: true, ensureMode: false });
      console.log(`[dola-cli] submitted via ${submit.method} (${submit.selector})`);
      if (activeAccount) bumpAccountUsage(poolDayState, activeAccount.id, 1);
      const finalUrl = args.newChat || isChatHomeUrl(sessionUrl)
        ? await waitForConcreteChatUrl(client, currentUrl)
        : await evaluate(client, "location.href").catch(() => currentUrl);
      await writeJsonFile(sessionStateFile, {
        ...(savedState || {}),
        ...poolState(),
        version: 1,
        lastSessionUrl: finalUrl,
        completed: [...completedByLine.values()].filter(item => item.line && item.file),
        inFlight: {
          line: lineNumber,
          prompt: promptText,
          sessionUrl: finalUrl,
          accountId: activeAccount?.id || "",
          beforeUrls: [...beforeImageUrls],
          beforeImageKeys: [...beforeImageKeys],
        },
        updatedAt: new Date().toISOString(),
      });

      const finalSnapshot = args.noWait || ((args.imageGen || args.videoGen) && !args.noDownload)
        ? await pageSnapshot(client)
        : await waitForResponseText(client, beforeResponse.textTail || "", args);
      // Soft quota tracking from reply text for proactive rotation on next job.
      try {
        const replyText = (await lastReplySnapshot(client).catch(() => null))?.text
          || finalSnapshot?.textTail
          || "";
        const remaining = parseRemainingQuota(replyText);
        if (remaining !== null && activeAccount) {
          console.log(`[dola-cli] account ${activeAccount.id} remaining quota hint: ${remaining}`);
          if (remaining <= 0) {
            markAccountBlocked(poolDayState, activeAccount.id, "IMAGE_GENERATION_QUOTA_EXHAUSTED");
            await writeJsonFile(sessionStateFile, {
              ...(savedState || {}),
              ...poolState(),
              version: 1,
              lastSessionUrl: finalUrl,
              updatedAt: new Date().toISOString(),
            });
            console.log(`[dola-cli] account ${activeAccount.id} marked exhausted after remaining=0`);
          }
        }
      } catch {}
      const downloaded = (args.imageGen || args.videoGen) && !args.noWait && !args.noDownload
        ? await downloadImages(
          await waitForDownloadItems(client, beforeImageUrls, capturedRecords, {
            ...args,
            beforeImageKeys,
            beforeGenerationUi,
            // Video: wait for get_play_info no-watermark URLs; do not settle on preview streams.
            watermarkFallback: args.videoGen ? Boolean(args.allowWatermark) : true,
            promptText,
          }),
          path.resolve(args.out),
          {
            ...args,
            lineNumber,
            hashNaming: true,
            watermarkFallback: args.videoGen ? Boolean(args.allowWatermark) : Boolean(args.characterImage),
            seenHashes,
          }
        )
        : [];

      results.push({
        index: index + 1,
        line: lineNumber,
        finalUrl,
        prompt: promptText,
        submit,
        downloaded,
        page: finalSnapshot,
      });
      for (const item of downloaded || []) {
        if (lineNumber && item.file) {
          completedByLine.set(Number(lineNumber), {
            line: lineNumber,
            hash: item.hash,
            shortHash: item.shortHash,
            file: item.file,
            prompt: promptText,
          });
        }
      }
      if (args.batchPromptFile) {
        const completedForState = new Map(completedByLine);
        for (const item of results) {
          for (const downloaded of item.downloaded || []) {
            if (item.line && downloaded.file) {
              completedForState.set(Number(item.line), {
                line: item.line,
                hash: downloaded.hash,
                shortHash: downloaded.shortHash,
                file: downloaded.file,
                prompt: item.prompt,
              });
            }
          }
        }
        const state = {
          ...poolState(),
          version: 1,
          lastSessionUrl: finalUrl,
          batchPromptFile: path.resolve(args.batchPromptFile),
          characterImage: args.characterImage ? path.resolve(args.characterImage) : "",
          characterPrompt: args.characterPrompt || "",
          characterBatchSize: args.characterBatchSize || null,
          completed: [...completedForState.values()]
            .filter(item => item.line && item.file),
          inFlight: null,
          updatedAt: new Date().toISOString(),
        };
        await writeJsonFile(sessionStateFile, state);
      } else {
        await writeJsonFile(sessionStateFile, { ...poolState(), version: 1, lastSessionUrl: finalUrl, inFlight: null, updatedAt: new Date().toISOString() });
      }
      currentUrl = finalUrl;
      break;
      } catch (error) {
        if (await switchRestrictedAccount(error, lineNumber)) {
          attempt = 0;
          continue;
        }
        const missingImage = ["IMAGE_GENERATION_TIMEOUT", "IMAGE_GENERATION_NO_CLEAN_IMAGE"].includes(error.code);
        if (missingImage && args.batchPromptFile) {
          const answer = await askRequired(
            `[dola-cli] 绗?${lineNumber} 鏉″凡鎻愪氦锛屼絾绋嬪簭娌℃湁纭鏈€鍚庡洖澶嶄腑鐨勫浘鐗囥€傝妫€鏌?Dola 椤甸潰锛涚‘璁ら〉闈㈢‘瀹炴病鏈夊浘鐗囪杈撳叆 yes锛岄〉闈㈡湁鍥剧墖璇疯緭鍏?no: `
          );
          if (!/^(y|yes|\u662f|\u6ca1\u6709|\u65e0\u56fe|\u786e\u8ba4)$/i.test(answer.trim())) {
            error.details = {
              ...(error.details || {}),
              failedLine: lineNumber,
              userConfirmedPageHasImage: true,
            };
            throw error;
          }
        }
        const retryable = args.batchPromptFile && [
          "IMAGE_GENERATION_TIMEOUT",
          "IMAGE_GENERATION_NO_CLEAN_IMAGE",
          "DOLA_CLI_ERROR",
          "ECONNRESET",
        ].includes(error.code || "DOLA_CLI_ERROR");
        if (retryable && attempt < args.maxRetries) {
          attempt += 1;
          console.log(`[dola-cli] retrying line ${lineNumber} (${attempt}/${args.maxRetries}) in a new Dola tab`);
          client.close();
          capturedRecords.length = 0;
          const retryTarget = await findOrCreateTarget(args.cdp, DOLA_CHAT_HOME, true);
          client = new CdpClient(retryTarget.webSocketDebuggerUrl);
          await client.connect();
          await client.send("Runtime.enable");
          await client.send("Page.enable");
          await client.send("Network.enable");
          await client.send("Page.bringToFront").catch(() => {});
          currentUrl = await evaluate(client, "location.href").catch(() => DOLA_CHAT_HOME);
          await waitForPageReady(client);
          await sleep(3000);
          await installImageHook(client);
          if (args.videoGen) {
            await installVideoRequestPatch(client, args);
            await installVideoResolveHelpers(client);
            await prepareVideoComposer(client, args, files);
            args.modePrepared = true;
          } else if (args.imageGen) {
            await prepareImageComposer(client, args, files);
            args.modePrepared = true;
          } else if (files.length) {
            await attachFiles(client, files);
          }
          installNetworkImageCapture(client, capturedRecords);
          continue;
        }
        if (args.characterImage) {
          const details = { ...(error.details || {}), failedLine: lineNumber, failedPrompt: promptText };
          if (error instanceof DolaCliError) {
            error.details = details;
          } else {
            throw new DolaCliError(error.code || "DOLA_CLI_ERROR", error.message || String(error), details);
          }
        }
        throw error;
      }
    }
  }

  const output = args.batchPromptFile
    ? {
      sessionUrl,
      attached,
      imageGeneration: true,
      batchPromptFile: path.resolve(args.batchPromptFile),
      ...(args.characterImage ? {
        characterImage: path.resolve(args.characterImage),
        characterBatchSize: args.characterBatchSize,
      } : {}),
      ...(accountPoolFile ? {
        ...poolState(),
      } : {}),
      submitted: results.filter(item => !item.skipped).length,
      skipped: results.filter(item => item.skipped).length,
      results,
    }
    : {
      sessionUrl,
      attached,
      ...(accountPoolFile ? {
        ...poolState(),
      } : {}),
      submitted: true,
      imageGeneration: Boolean(args.imageGen),
      videoGeneration: Boolean(args.videoGen),
      ...(args.videoGen ? {
        duration: args.duration || DEFAULT_VIDEO_DURATION,
        model: args.model || "",
        aspectRatio: args.aspectRatio || "",
        completionPatch: true,
      } : {}),
      ...results[0],
    };
  console.log(JSON.stringify(output, null, 2));
  client.close();
}
