import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveRuntimeConfig } from "../../src/runtime/config.js";

describe("resolveRuntimeConfig", () => {
  it("prefers explicit options over env", () => {
    const config = resolveRuntimeConfig(
      {
        cookieFile: "./cookies.txt",
        outputDir: "./artifacts",
        pollIntervalMs: "1500",
      },
      {
        JIMENG_COOKIE_FILE: "./ignored.txt",
      },
      "/workspace",
    );

    expect(config.cookieFile).toBe(path.resolve("/workspace", "./cookies.txt"));
    expect(config.outputDir).toBe(path.resolve("/workspace", "./artifacts"));
    expect(config.pollIntervalMs).toBe(1500);
  });

  it("uses sane defaults", () => {
    const config = resolveRuntimeConfig({}, {}, "/workspace");

    expect(config.baseUrl).toBe("https://jimeng.jianying.com");
    expect(config.outputDir).toBe(path.resolve("/workspace", "downloads"));
    expect(config.pollTimeoutMs).toBe(600000);
  });
});
