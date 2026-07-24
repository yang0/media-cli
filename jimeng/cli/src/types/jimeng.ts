export interface AccountInfoResponse {
  message: string;
  data?: {
    user_id?: number;
    name?: string;
    error_code?: number;
    description?: string;
  };
}

export interface CreditInfoResponse {
  credit?: {
    gift_credit?: number;
    purchase_credit?: number;
    vip_credit?: number;
  };
}

export interface CreditBalance {
  giftCredit: number;
  purchaseCredit: number;
  vipCredit: number;
  totalCredit: number;
}

export interface SupportedModel {
  kind: GenerationKind;
  alias: string;
  key: string;
}

export type GenerationKind = "image" | "video";

export interface JimengEnvelope<T> {
  ret?: string;
  errmsg?: string;
  data?: T;
  logid?: string;
}

export interface GenerateSubmitData {
  aigc_data?: {
    history_record_id?: string | number;
  };
}

export interface JimengHistoryTask {
  history_id?: string | number;
  finish_time?: number;
}

export interface JimengImageInfo {
  large_images?: Array<{
    image_url?: string;
  }>;
}

export interface JimengVideoModelInfo {
  video_model?: string;
  play_url?: string;
  download_url?: string;
  url?: string;
  transcoded_video?: {
    origin?: {
      video_url?: string;
    };
  };
}

export interface JimengHistoryItem {
  id?: string | number;
  item_id?: string | number;
  local_item_id?: string | number;
  image?: JimengImageInfo;
  video?: JimengVideoModelInfo;
  common_attr?: {
    id?: string | number;
    cover_url?: string;
    transcoded_video?: {
      origin?: {
        video_url?: string;
      };
    };
  };
}

export interface JimengHistoryRecord {
  history_record_id?: string | number;
  submit_id?: string;
  status?: number;
  fail_code?: number | string;
  item_list?: JimengHistoryItem[];
  task?: JimengHistoryTask;
}

export interface JimengLocalItemResponse {
  item_list?: JimengHistoryItem[];
  local_item_list?: JimengHistoryItem[];
}

export interface JimengHistoryListResponse {
  has_more?: boolean;
  next_offset?: number;
  records_list?: Array<{
    history_record_id?: string | number;
    status?: number;
    fail_code?: number | string;
    created_time?: number;
  }>;
}

export interface ResolvedAsset {
  kind: GenerationKind;
  url: string;
  fileNameHint?: string;
}

export interface TaskResolution {
  historyId: string;
  kind: GenerationKind;
  record: JimengHistoryRecord;
  assets: ResolvedAsset[];
}
