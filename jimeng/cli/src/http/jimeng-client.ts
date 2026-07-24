import { createHash } from "node:crypto";

import { AppError } from "../runtime/errors.js";
import type { Runtime } from "../runtime/create-runtime.js";
import type {
  AccountInfoResponse,
  CreditBalance,
  CreditInfoResponse,
  GenerateSubmitData,
  GenerationKind,
  JimengEnvelope,
  JimengHistoryListResponse,
  JimengHistoryRecord,
  JimengLocalItemResponse,
} from "../types/jimeng.js";

const ASSISTANT_AID = 513695;
const WEB_VERSION = "7.5.0";
const DRAFT_VERSION = "3.3.9";
const PLATFORM_CODE = "7";
const APP_VERSION = "8.4.0";
const APP_SDK_VERSION = "48.0.0";

const DEFAULT_IMAGE_INFO = {
  width: 2048,
  height: 2048,
  format: "webp",
  image_scene_list: [
    { scene: "normal", width: 2400, height: 2400, uniq_key: "2400", format: "webp" },
    { scene: "normal", width: 1080, height: 1080, uniq_key: "1080", format: "webp" },
    { scene: "normal", width: 720, height: 720, uniq_key: "720", format: "webp" },
    { scene: "normal", width: 480, height: 480, uniq_key: "480", format: "webp" },
    { scene: "normal", width: 360, height: 360, uniq_key: "360", format: "webp" },
  ],
};

function isEnvelope<T>(value: unknown): value is JimengEnvelope<T> {
  return typeof value === "object" && value !== null && ("ret" in value || "errmsg" in value || "data" in value);
}

function unwrapEnvelope<T>(value: JimengEnvelope<T> | T): T {
  if (!isEnvelope<T>(value)) {
    return value;
  }

  if (value.ret !== undefined && value.ret !== "0") {
    throw new AppError(value.errmsg ?? "Jimeng API request failed", 1, value);
  }

  if (value.data === undefined) {
    throw new AppError("Jimeng API response did not include data", 1, value);
  }

  return value.data;
}

export class JimengClient {
  public constructor(private readonly runtime: Runtime) {}

  private async buildSignedHeaders(pathName: string, referer: string): Promise<Record<string, string>> {
    const deviceTime = Math.floor(Date.now() / 1000).toString();
    const sign = createHash("md5")
      .update(`9e2c|${pathName.slice(-7)}|${PLATFORM_CODE}|${APP_VERSION}|${deviceTime}||11ac`)
      .digest("hex");

    return {
      Referer: referer,
      Origin: this.runtime.config.baseUrl,
      appid: String(ASSISTANT_AID),
      appvr: APP_VERSION,
      "app-sdk-version": APP_SDK_VERSION,
      "device-time": deviceTime,
      lan: "zh-Hans",
      loc: "cn",
      pf: PLATFORM_CODE,
      sign,
      "sign-ver": "1",
      tdid: "",
      "x-platform": "pc",
    };
  }

  private async buildJimengSearchParams(type: "image" | "video" = "image"): Promise<Record<string, string>> {
    const webId = await this.runtime.getCookieValue("_tea_web_id");

    const searchParams: Record<string, string> = {
      aid: String(ASSISTANT_AID),
      device_platform: "web",
      region: "cn",
      webId: webId ?? "",
      da_version: DRAFT_VERSION,
      os: "windows",
      web_component_open_flag: "1",
      web_version: WEB_VERSION,
      aigc_features: "app_lip_sync",
    };

    return searchParams;
  }

  public async getAccountInfo(): Promise<AccountInfoResponse> {
    return this.runtime.requestJson<AccountInfoResponse>("/passport/account/info/v2/", {
      method: "GET",
      searchParams: {
        aid: ASSISTANT_AID,
        account_sdk_source: "web",
        sdk_version: "2.2.6",
        verifyFp: "verify_cli",
        fp: "verify_cli",
      },
      headers: {
        Referer: `${this.runtime.config.baseUrl}/ai-tool/generate?workspace=0`,
      },
    });
  }

  public async getCreditBalance(): Promise<CreditBalance> {
    const pathName = "/commerce/v1/benefits/user_credit";
    const response = await this.runtime.requestJson<JimengEnvelope<CreditInfoResponse> | CreditInfoResponse>(pathName, {
      method: "POST",
      headers: await this.buildSignedHeaders(pathName, `${this.runtime.config.baseUrl}/ai-tool/generate?type=image`),
      body: {},
    });
    const data = unwrapEnvelope(response);
    const giftCredit = data.credit?.gift_credit ?? 0;
    const purchaseCredit = data.credit?.purchase_credit ?? 0;
    const vipCredit = data.credit?.vip_credit ?? 0;

    return {
      giftCredit,
      purchaseCredit,
      vipCredit,
      totalCredit: giftCredit + purchaseCredit + vipCredit,
    };
  }

  public async submitImageGenerate(body: unknown): Promise<GenerateSubmitData> {
    const pathName = "/mweb/v1/aigc_draft/generate";
    const referer = `${this.runtime.config.baseUrl}/ai-tool/generate?type=image`;
    const response = await this.runtime.requestJson<JimengEnvelope<GenerateSubmitData>>("/mweb/v1/aigc_draft/generate", {
      method: "POST",
      searchParams: await this.buildJimengSearchParams("image"),
      headers: await this.buildSignedHeaders(pathName, referer),
      body,
    });

    return unwrapEnvelope(response);
  }

  public async submitVideoGenerate(body: unknown): Promise<GenerateSubmitData> {
    const pathName = "/mweb/v1/aigc_draft/generate";
    const referer = `${this.runtime.config.baseUrl}/ai-tool/generate?type=video`;
    const response = await this.runtime.requestJson<JimengEnvelope<GenerateSubmitData>>("/mweb/v1/aigc_draft/generate", {
      method: "POST",
      searchParams: await this.buildJimengSearchParams("video"),
      headers: await this.buildSignedHeaders(pathName, referer),
      body,
    });

    return unwrapEnvelope(response);
  }

  public async getHistoryByIds(historyIds: string[], kind: GenerationKind | "auto" = "auto"): Promise<Record<string, JimengHistoryRecord>> {
    const pathName = "/mweb/v1/get_history_by_ids";
    const referer = `${this.runtime.config.baseUrl}/ai-tool/generate?type=${kind === "video" ? "video" : "image"}`;
    const commonOptions = {
      method: "POST" as const,
      searchParams: await this.buildJimengSearchParams(kind === "video" ? "video" : "image"),
      headers: await this.buildSignedHeaders(pathName, referer),
    };

    const primaryField = kind === "image" ? "submit_ids" : "history_ids";
    const secondaryField = kind === "image" ? "history_ids" : "submit_ids";

    const primaryResponse = await this.runtime.requestJson<JimengEnvelope<Record<string, JimengHistoryRecord>> | Record<string, JimengHistoryRecord>>(
      "/mweb/v1/get_history_by_ids",
      {
        ...commonOptions,
        body: {
          [primaryField]: historyIds,
          ...(kind === "image" ? { image_info: DEFAULT_IMAGE_INFO } : {}),
        },
      },
    );
    const unwrappedPrimaryResponse = unwrapEnvelope(primaryResponse);

    if (Object.keys(unwrappedPrimaryResponse).length > 0) {
      return unwrappedPrimaryResponse;
    }

    const secondaryResponse = await this.runtime.requestJson<JimengEnvelope<Record<string, JimengHistoryRecord>> | Record<string, JimengHistoryRecord>>(
      "/mweb/v1/get_history_by_ids",
      {
        ...commonOptions,
        body: {
          [secondaryField]: historyIds,
          ...(kind === "image" ? { image_info: DEFAULT_IMAGE_INFO } : {}),
        },
      },
    );

    return unwrapEnvelope(secondaryResponse);
  }

  public async getLocalItemList(itemIds: string[]): Promise<JimengLocalItemResponse> {
    const pathName = "/mweb/v1/get_local_item_list";
    const response = await this.runtime.requestJson<JimengEnvelope<JimengLocalItemResponse> | JimengLocalItemResponse>("/mweb/v1/get_local_item_list", {
      method: "POST",
      searchParams: await this.buildJimengSearchParams("video"),
      headers: await this.buildSignedHeaders(pathName, `${this.runtime.config.baseUrl}/ai-tool/generate?type=video`),
      body: {
        item_id_list: itemIds,
        pack_item_opt: {
          scene: 1,
          need_data_integrity: true,
        },
        is_for_video_download: true,
      },
    });

    return unwrapEnvelope(response);
  }

  public async getHistoryList(limit: number, offset = 0): Promise<JimengHistoryListResponse> {
    const pathName = "/mweb/v1/get_history";
    const response = await this.runtime.requestJson<JimengEnvelope<JimengHistoryListResponse> | JimengHistoryListResponse>("/mweb/v1/get_history", {
      method: "POST",
      searchParams: await this.buildJimengSearchParams("image"),
      headers: await this.buildSignedHeaders(pathName, `${this.runtime.config.baseUrl}/ai-tool/generate?type=image`),
      body: {
        offset,
        count: limit,
        history_option: {
          story_id: "",
          only_favorited: false,
          workspace_id: -1,
        },
        history_type_list: [1, 2, 4, 3, 5, 6, 7, 8, 10],
        mode: "workbench",
        is_pack_origin: true,
      },
    });

    return unwrapEnvelope(response);
  }

}
