import { loadCookieHeaderFromFile } from "../auth/cookie-file.js";
import { requestJson, type RequestJsonOptions } from "../http/request.js";
import { requireCookieFile, resolveRuntimeConfig, type RuntimeConfig, type RuntimeOptions } from "./config.js";

export interface Runtime {
  config: RuntimeConfig;
  getCookieHeader(): Promise<string>;
  getCookieValue(name: string): Promise<string | undefined>;
  requestJson<T>(pathName: string, options?: Omit<RequestJsonOptions, "cookieHeader" | "userAgent">): Promise<T>;
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const config = resolveRuntimeConfig(options);
  let cachedCookieHeader: string | undefined;

  async function getCookieHeader(): Promise<string> {
    if (cachedCookieHeader) {
      return cachedCookieHeader;
    }

    cachedCookieHeader = await loadCookieHeaderFromFile(requireCookieFile(config), config.baseUrl);
    return cachedCookieHeader;
  }

  async function getCookieValue(name: string): Promise<string | undefined> {
    const header = await getCookieHeader();
    const entries = header.split(/;\s*/u).map((part) => {
      const separatorIndex = part.indexOf("=");
      return separatorIndex === -1
        ? [part, ""]
        : [part.slice(0, separatorIndex), part.slice(separatorIndex + 1)];
    });
    const match = entries.find(([key]) => key === name);
    return match?.[1];
  }

  return {
    config,
    getCookieHeader,
    getCookieValue,
    async requestJson<T>(pathName: string, requestOptions: Omit<RequestJsonOptions, "cookieHeader" | "userAgent"> = {}): Promise<T> {
      return requestJson<T>(config.baseUrl, pathName, {
        ...requestOptions,
        cookieHeader: await getCookieHeader(),
        userAgent: config.userAgent,
      });
    },
  };
}
