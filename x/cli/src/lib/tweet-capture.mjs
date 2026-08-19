import crypto from "node:crypto";

export class TweetCaptureError extends Error {
  constructor(message, code = "capture-failed") {
    super(message);
    this.name = "TweetCaptureError";
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * This is intentionally a string sent to Runtime.evaluate. Keeping the DOM
 * selection and isolation in one browser-side function makes the exact
 * article requirement easy to audit and keeps the Node side independent of
 * X's private API responses.
 */
export function buildPrepareScript({ tweetId, width = 598, wait = 5, cutStats = false }) {
  const id = JSON.stringify(String(tweetId));
  const targetWidth = Number(width);
  const initialWait = Math.max(0, Number(wait) || 0) * 1000;
  const hideStats = Boolean(cutStats);
  return `
(async () => {
  const TARGET_ID = ${id};
  const TARGET_HREF = "/status/" + TARGET_ID + "(?:[/?#]|$)";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const hrefMatchesTarget = (href) => {
    try { return new RegExp(TARGET_HREF, "i").test(new URL(href, location.href).pathname); }
    catch { return false; }
  };
  const findTargetArticle = () => Array.from(document.querySelectorAll("article[data-testid=\\"tweet\\"], article"))
    .find((article) => Array.from(article.querySelectorAll("a[href]"))
      .some((anchor) => hrefMatchesTarget(anchor.getAttribute("href") || anchor.href || "")));
  const pageText = () => (document.body?.innerText || "").toLowerCase();
  const challengePresent = () => Boolean(
    document.querySelector("input[name=\\"challenge\\"], iframe[src*=\\"challenge\\"], [data-testid=\\"challenge\\"]") ||
    /captcha|verify you are human|验证|登录以继续/.test(pageText())
  );
  await sleep(${initialWait});

  let target = findTargetArticle();
  const deadline = Date.now() + 18000;
  while (!target && Date.now() < deadline) {
    await sleep(400);
    target = findTargetArticle();
  }
  if (!target) {
    if (challengePresent()) return { ok: false, code: "auth-or-challenge", error: "X 页面要求登录、验证或验证码" };
    if (/doesn't exist|does not exist|post unavailable|account suspended|私密|删除|不存在/.test(pageText())) {
      return { ok: false, code: "unavailable", error: "目标推文不存在、已删除、私密或当前账号无权查看" };
    }
    return { ok: false, code: "target-not-found", error: "未找到与目标 status ID 精确匹配的推文 article" };
  }

  // Trigger X's lazy media loading before cloning the article. A clone does
  // not inherit the loaded bitmap, so currentSrc is copied explicitly below.
  const sourceImages = Array.from(target.querySelectorAll("img"));
  for (const image of sourceImages) {
    image.scrollIntoView({ block: "center", inline: "nearest" });
    const lazySrc = image.currentSrc || image.getAttribute("data-src") || image.getAttribute("data-original") || image.getAttribute("src");
    if (lazySrc && !/^data:image\\/gif;base64,R0lGODlhAQABA/.test(lazySrc)) image.src = lazySrc;
    await sleep(80);
  }
  await Promise.all(sourceImages.map((image) => image.complete
    ? Promise.resolve()
    : new Promise((resolve) => { image.addEventListener("load", resolve, { once: true }); image.addEventListener("error", resolve, { once: true }); setTimeout(resolve, 4000); })));
  await sleep(250);

  const authorAnchor = Array.from(target.querySelectorAll("a[href]"))
    .find((anchor) => {
      try {
        const path = new URL(anchor.href, location.href).pathname;
        return /^\\/[^/]+\\/status\\/\\d+/.test(path) && hrefMatchesTarget(anchor.href);
      } catch { return false; }
    });
  let authorHandle = null;
  if (authorAnchor) {
    try { authorHandle = new URL(authorAnchor.href, location.href).pathname.split("/")[1] || null; }
    catch { authorHandle = null; }
  }

  const host = document.createElement("div");
  host.setAttribute("data-x-cli-capture-root", "true");
  // Keep the isolated node in document coordinates. A fixed overlay combined
  // with captureBeyondViewport can make Chrome paint the original page in
  // the first viewport and the clone only below it. Putting it after the
  // page and capturing its document clip gives the compositor one layer.
  const captureTop = Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0) + 64;
  Object.assign(host.style, {
    position: "absolute", left: "0", top: captureTop + "px", width: "${targetWidth}px",
    margin: "0", padding: "0", background: "#ffffff", zIndex: "2147483647",
    overflow: "visible", boxSizing: "border-box"
  });
  const clone = target.cloneNode(true);
  clone.setAttribute("data-x-cli-capture-target", TARGET_ID);
  Object.assign(clone.style, { width: "${targetWidth}px", maxWidth: "none", margin: "0", position: "static", boxSizing: "border-box" });
  const cloneImages = Array.from(clone.querySelectorAll("img"));
  cloneImages.forEach((image, index) => {
    const original = sourceImages[index];
    const source = original?.currentSrc || original?.getAttribute("src") || original?.getAttribute("data-src");
    if (source && !/^data:image\\/gif;base64,R0lGODlhAQABA/.test(source)) {
      image.src = source;
      image.removeAttribute("srcset");
      image.removeAttribute("sizes");
    }
  });
  clone.querySelectorAll("[data-testid=\\"caret\\"], button[aria-label*=\\"More\\"], [aria-label*=\\"More options\\"], [role=\\"menu\\"]")
    .forEach((node) => node.remove());
  ${hideStats ? 'clone.querySelectorAll(\'[role="group"], [data-testid="reply"], [data-testid="retweet"], [data-testid="like"], [data-testid="bookmark"]\').forEach((node) => node.remove());' : ""}
  host.appendChild(clone);
  document.body.appendChild(host);
  host.scrollIntoView({ block: "start", inline: "nearest" });
  await Promise.all(cloneImages.map((image) => image.complete
    ? Promise.resolve()
    : new Promise((resolve) => { image.addEventListener("load", resolve, { once: true }); image.addEventListener("error", resolve, { once: true }); setTimeout(resolve, 4000); })));
  if (document.fonts?.ready) await document.fonts.ready.catch(() => {});
  await sleep(150);
  const rect = host.getBoundingClientRect();
  const height = Math.ceil(Math.max(rect.height, host.scrollHeight));
  if (!height || !rect.width) {
    host.remove();
    return { ok: false, code: "empty-article", error: "目标推文 article 没有可截图内容" };
  }
  return {
    ok: true,
    authorHandle,
    width: Math.ceil(rect.width),
    height,
    // Convert the viewport rect back to document coordinates. Chrome uses
    // document coordinates for a clip when captureBeyondViewport is enabled.
    clip: { x: Math.max(0, rect.left + window.scrollX), y: Math.max(0, rect.top + window.scrollY), width: Math.ceil(rect.width), height },
    host: true
  };
})()`;
}

export const CLEANUP_CAPTURE_SCRIPT = `(() => {
  document.querySelectorAll('[data-x-cli-capture-root="true"]').forEach((node) => node.remove());
  return true;
})()`;

export function readCdpValue(response) {
  if (response?.exceptionDetails) {
    throw new TweetCaptureError("页面脚本执行失败", "page-script-error");
  }
  // cdp.send() resolves to the command result. Runtime.evaluate therefore
  // has one `result` wrapper here (`{ result: { value } }`), not two.
  return response?.result?.value;
}

async function evaluate(cdp, expression, sessionId) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, sessionId);
  return readCdpValue(response);
}

export async function captureTweet({ cdp, reference, width = 598, wait = 5, cutStats = false }) {
  if (!cdp || typeof cdp.send !== "function") throw new TweetCaptureError("未提供 CDP 连接", "cdp-unavailable");
  let targetId;
  let sessionId;
  try {
    const created = await cdp.send("Target.createTarget", { url: reference.canonicalUrl });
    targetId = created?.targetId;
    if (!targetId) throw new TweetCaptureError("CDP 未能创建推文标签页", "cdp-unavailable");
    const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    sessionId = attached?.sessionId;
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.navigate", { url: reference.canonicalUrl }, sessionId).catch(() => {});

    const prepareScript = buildPrepareScript({ tweetId: reference.tweetId, width, wait, cutStats });
    let prepared = await evaluate(cdp, prepareScript, sessionId);
    // X can finish mounting the status article just after the initial page
    // load. Retry only this narrow, recoverable state once; auth challenges,
    // deleted/private posts, and script/CDP errors must retain their original
    // failure semantics and must not cause repeated navigation.
    if (!prepared?.ok && prepared?.code === "target-not-found") {
      await cdp.send("Page.reload", { ignoreCache: true }, sessionId).catch(() => {});
      prepared = await evaluate(cdp, prepareScript, sessionId);
    }
    if (!prepared?.ok) throw new TweetCaptureError(prepared?.error || "无法定位目标推文", prepared?.code || "capture-failed");

    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      // Chrome 151 requires ScreenshotClip.scale even though older CDP
      // versions treated it as optional.
      clip: { ...prepared.clip, scale: 1 },
    }, sessionId);
    if (!shot?.data) throw new TweetCaptureError("CDP 未返回截图数据", "capture-failed");
    const png = Buffer.from(shot.data, "base64");
    return {
      png,
      authorHandle: prepared.authorHandle || null,
      width: prepared.width,
      height: prepared.height,
      cutStats: Boolean(cutStats),
      sha256: crypto.createHash("sha256").update(png).digest("hex"),
    };
  } catch (error) {
    if (error instanceof TweetCaptureError) throw error;
    const message = typeof error === "string" ? error : error?.message || "CDP 截图失败";
    throw new TweetCaptureError(message, "cdp-error");
  } finally {
    if (sessionId) await cdp.send("Runtime.evaluate", { expression: CLEANUP_CAPTURE_SCRIPT, returnByValue: true }, sessionId).catch(() => {});
    if (targetId) await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}
