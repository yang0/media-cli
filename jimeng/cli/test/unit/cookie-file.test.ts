import { describe, expect, it } from "vitest";

import { buildCookieHeader, parseNetscapeCookieFile } from "../../src/auth/cookie-file.js";

const sampleCookies = `# Netscape HTTP Cookie File
jimeng.jianying.com\tFALSE\t/\tFALSE\t0\t_tea_web_id\t123
.jianying.com\tTRUE\t/\tFALSE\t0\tsessionid\tabc
example.com\tFALSE\t/\tFALSE\t0\tother\tvalue
`;

describe("parseNetscapeCookieFile", () => {
  it("parses valid cookie lines", () => {
    const cookies = parseNetscapeCookieFile(sampleCookies);

    expect(cookies).toHaveLength(3);
    expect(cookies[0]?.name).toBe("_tea_web_id");
    expect(cookies[1]?.includeSubdomains).toBe(true);
  });

  it("builds a cookie header for matching domains only", () => {
    const cookies = parseNetscapeCookieFile(sampleCookies);
    const header = buildCookieHeader(cookies, "https://jimeng.jianying.com/ai-tool/generate?workspace=0");

    expect(header).toContain("_tea_web_id=123");
    expect(header).toContain("sessionid=abc");
    expect(header).not.toContain("other=value");
  });
});
