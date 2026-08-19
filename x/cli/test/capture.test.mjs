import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { handleCapture, parseCaptureArgs } from "../src/commands/capture.mjs";
import { captureTweet, buildPrepareScript, CLEANUP_CAPTURE_SCRIPT, TweetCaptureError } from "../src/lib/tweet-capture.mjs";
import { parseTweetReference } from "../src/lib/tweet-input.mjs";

test("accepts X hosts and numeric IDs, canonicalizing to i/status", () => {
  assert.deepEqual(parseTweetReference("1234567890"), {
    sourceUrl: "1234567890",
    canonicalUrl: "https://x.com/i/status/1234567890",
    tweetId: "1234567890",
  });
  const ref = parseTweetReference("https://www.twitter.com/user/status/1234567890?s=20#reply");
  assert.equal(ref.tweetId, "1234567890");
  assert.equal(ref.canonicalUrl, "https://x.com/i/status/1234567890");
  assert.equal(ref.sourceUrl, "https://www.twitter.com/user/status/1234567890?s=20#reply");
  assert.equal(parseTweetReference("mobile.x.com/i/status/42").tweetId, "42");
});

test("rejects non-X, non-status URLs", () => {
  for (const input of ["https://example.com/status/123", "https://x.com/home", "https://x.com/i/likes/123", "abc"]) {
    assert.throws(() => parseTweetReference(input));
  }
});

test("parses capture options and defaults", () => {
  assert.deepEqual(parseCaptureArgs(["123"]), {
    input: "123",
    options: { port: 9221, width: 598, wait: 5, cutStats: false, outputDir: null },
  });
  assert.deepEqual(parseCaptureArgs(["https://x.com/a/status/1", "--port", "9333", "--width", "500", "--wait", "2", "--cut-stats", "--output-dir", "out"]), {
    input: "https://x.com/a/status/1",
    options: { port: 9333, width: 500, wait: 2, cutStats: true, outputDir: "out" },
  });
  assert.throws(() => parseCaptureArgs(["1", "--width", "0"]));
  assert.throws(() => parseCaptureArgs(["1", "--wat"]));
});

test("prepare script only selects exact target article and clips an isolated node", () => {
  const script = buildPrepareScript({ tweetId: "987", width: 598, cutStats: true });
  assert.match(script, /article\[data-testid=\\?"tweet/);
  assert.match(script, /TARGET_ID/);
  assert.match(script, /hrefMatchesTarget/);
  assert.match(script, /data-x-cli-capture-root/);
  assert.match(script, /position: "absolute"/);
  assert.match(script, /document\.documentElement\?\.scrollHeight/);
  assert.match(script, /rect\.top \+ window\.scrollY/);
  assert.doesNotMatch(script, /position: "fixed"/);
  assert.match(CLEANUP_CAPTURE_SCRIPT, /data-x-cli-capture-root/);
  assert.doesNotMatch(script, /document\.body\.innerHTML/);
  // Browser parser check catches accidental template-string JS syntax errors.
  assert.doesNotThrow(() => new Function(`return ${script}`));
});

class FakeCdp {
  constructor({ prepare = { ok: true, authorHandle: "alice", width: 598, height: 804, clip: { x: 0, y: 120, width: 598, height: 804 } }, prepareSequence = null } = {}) {
    this.prepare = prepare;
    this.prepareSequence = prepareSequence;
    this.calls = [];
  }

  async send(method, params = {}, sessionId) {
    this.calls.push({ method, params, sessionId });
    if (method === "Target.createTarget") return { targetId: "target-1" };
    if (method === "Target.attachToTarget") return { sessionId: "session-1" };
    if (method === "Runtime.evaluate") {
      const evaluations = this.calls.filter((call) => call.method === "Runtime.evaluate").length - 1;
      const value = this.prepareSequence?.[Math.min(evaluations, this.prepareSequence.length - 1)] || this.prepare;
      return { result: { value } };
    }
    if (method === "Page.captureScreenshot") return { data: Buffer.from("fake-png").toString("base64") };
    return {};
  }
}

test("capture uses a CDP clip, writes no full-page request, and closes only its target", async () => {
  const cdp = new FakeCdp();
  const result = await captureTweet({
    cdp,
    reference: parseTweetReference("123"),
    cutStats: true,
  });
  assert.equal(result.authorHandle, "alice");
  const screenshot = cdp.calls.find((call) => call.method === "Page.captureScreenshot");
  assert.deepEqual(screenshot.params.clip, { x: 0, y: 120, width: 598, height: 804, scale: 1 });
  assert.equal(screenshot.params.captureBeyondViewport, true);
  assert.equal(screenshot.params.format, "png");
  assert.equal(cdp.calls.at(-1).method, "Target.closeTarget");
  assert.equal(cdp.calls.at(-1).params.targetId, "target-1");
});

test("target selection failures become typed errors and still clean up the temporary target", async () => {
  const cdp = new FakeCdp({ prepare: { ok: false, code: "target-not-found", error: "未找到目标" } });
  await assert.rejects(() => captureTweet({ cdp, reference: parseTweetReference("456") }), (error) => {
    assert.ok(error instanceof TweetCaptureError);
    assert.equal(error.code, "target-not-found");
    return true;
  });
  assert.equal(cdp.calls.at(-1).method, "Target.closeTarget");
});

test("retries target-not-found once after reload, but does not retry other errors", async () => {
  const success = { ok: true, authorHandle: "alice", width: 598, height: 804, clip: { x: 0, y: 120, width: 598, height: 804 } };
  const lateArticle = new FakeCdp({ prepareSequence: [
    { ok: false, code: "target-not-found", error: "未找到目标" },
    success,
  ] });
  const result = await captureTweet({ cdp: lateArticle, reference: parseTweetReference("789") });
  assert.equal(result.authorHandle, "alice");
  assert.equal(lateArticle.calls.filter((call) => call.method === "Page.reload").length, 1);
  assert.equal(lateArticle.calls.filter((call) => call.method === "Page.captureScreenshot").length, 1);

  const unavailable = new FakeCdp({ prepare: { ok: false, code: "unavailable", error: "已删除" } });
  await assert.rejects(() => captureTweet({ cdp: unavailable, reference: parseTweetReference("790") }), /已删除/);
  assert.equal(unavailable.calls.filter((call) => call.method === "Page.reload").length, 0);
});

test("successful command writes PNG and manifest", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "x-cli-capture-"));
  const fakeCdp = new FakeCdp();
  const result = await handleCapture(["123", "--output-dir", outputDir], {
    connect: async () => fakeCdp,
    capture: async () => ({
      png: Buffer.from("fake-png"), authorHandle: "alice", width: 598, height: 804,
      sha256: "test-sha", cutStats: false,
    }),
  });
  assert.equal(result.ok, true);
  const manifest = JSON.parse(await fs.readFile(path.join(outputDir, "manifest.json"), "utf8"));
  assert.equal(manifest.tweet_id, "123");
  assert.equal(manifest.author_handle, "alice");
  assert.equal(manifest.image, "images/x-123.png");
  assert.equal(await fs.readFile(path.join(outputDir, "images", "x-123.png"), "utf8"), "fake-png");
  await fs.rm(outputDir, { recursive: true, force: true });
});

test("failed command writes an error manifest and returns exit code 2", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "x-cli-capture-error-"));
  const previous = process.exitCode;
  process.exitCode = undefined;
  const result = await handleCapture(["123", "--output-dir", outputDir], {
    connect: async () => { throw new Error("CDP down"); },
  });
  assert.equal(result.ok, false);
  assert.equal(process.exitCode, 2);
  const manifest = JSON.parse(await fs.readFile(path.join(outputDir, "manifest.json"), "utf8"));
  assert.equal(manifest.tweet_id, "123");
  assert.equal(manifest.error, "CDP down");
  assert.equal(manifest.error_code, "cdp-unavailable");
  process.exitCode = previous;
  await fs.rm(outputDir, { recursive: true, force: true });
});
