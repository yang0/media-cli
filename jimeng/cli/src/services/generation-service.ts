import { randomUUID } from "node:crypto";

import { AppError } from "../runtime/errors.js";
import type { GenerateSubmitData, GenerationKind, SupportedModel } from "../types/jimeng.js";
import type { JimengClient } from "../http/jimeng-client.js";

const ASSISTANT_AID = 513695;
const DRAFT_VERSION = "3.3.9";
const DRAFT_MIN_VERSION = "3.0.2";

const IMAGE_MODEL_MAP: Record<string, string> = {
  "jimeng-5.0": "high_aes_general_v50",
  "jimeng-4.6": "high_aes_general_v42",
  "jimeng-4.5": "high_aes_general_v40l",
  "jimeng-4.1": "high_aes_general_v41",
  "jimeng-4.0": "high_aes_general_v40",
};

const VIDEO_MODEL_MAP: Record<string, string> = {
  "jimeng-video-seedance-2.0": "dreamina_seedance_40_pro",
  "jimeng-video-seedance-2.0-fast": "dreamina_seedance_40",
  "jimeng-video-3.5-pro": "dreamina_ic_generate_video_model_vgfm_3.5_pro",
  "jimeng-video-3.0-pro": "dreamina_ic_generate_video_model_vgfm_3.0_pro",
  "jimeng-video-3.0": "dreamina_ic_generate_video_model_vgfm_3.0",
  "jimeng-video-3.0-fast": "dreamina_ic_generate_video_model_vgfm_3.0_fast",
};

const IMAGE_RESOLUTION_OPTIONS = {
  "1k": {
    "1:1": { width: 1024, height: 1024, ratio: 1 },
    "4:3": { width: 768, height: 1024, ratio: 4 },
    "3:4": { width: 1024, height: 768, ratio: 2 },
    "16:9": { width: 1024, height: 576, ratio: 3 },
    "9:16": { width: 576, height: 1024, ratio: 5 },
  },
  "2k": {
    "1:1": { width: 2048, height: 2048, ratio: 1 },
    "4:3": { width: 2304, height: 1728, ratio: 4 },
    "3:4": { width: 1728, height: 2304, ratio: 2 },
    "16:9": { width: 2560, height: 1440, ratio: 3 },
    "9:16": { width: 1440, height: 2560, ratio: 5 },
  },
  "4k": {
    "1:1": { width: 4096, height: 4096, ratio: 101 },
    "4:3": { width: 4608, height: 3456, ratio: 104 },
    "3:4": { width: 3456, height: 4608, ratio: 102 },
    "16:9": { width: 5120, height: 2880, ratio: 103 },
    "9:16": { width: 2880, height: 5120, ratio: 105 },
  },
} as const;

const VIDEO_BENEFIT_BY_MODEL_KEY: Array<[needle: string, benefit: string]> = [
  ["seedance_40_pro", "dreamina_video_seedance_20_pro"],
  ["seedance_40", "dreamina_seedance_20_fast"],
  ["vgfm_3.5_pro", "basic_video_operation_vgfm_v_three"],
  ["vgfm_3.0_pro", "basic_video_operation_vgfm_v_three"],
  ["vgfm_3.0_fast", "basic_video_operation_vgfm_v_three"],
  ["vgfm_3.0", "basic_video_operation_vgfm_v_three"],
];

function listSupportedModelEntries(kind: GenerationKind, entries: Record<string, string>): SupportedModel[] {
  return Object.entries(entries)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([alias, key]) => ({ kind, alias, key }));
}

export function getSupportedModels(kind: GenerationKind | "all" = "all"): SupportedModel[] {
  const imageModels = listSupportedModelEntries("image", IMAGE_MODEL_MAP);
  const videoModels = listSupportedModelEntries("video", VIDEO_MODEL_MAP);

  if (kind === "image") {
    return imageModels;
  }

  if (kind === "video") {
    return videoModels;
  }

  return [...imageModels, ...videoModels];
}

export interface ImageGenerateOptions {
  prompt: string;
  model: string;
  ratio: keyof (typeof IMAGE_RESOLUTION_OPTIONS)["2k"];
  resolution: keyof typeof IMAGE_RESOLUTION_OPTIONS;
  negativePrompt?: string;
  seed?: number;
  sampleStrength: number;
}

export interface VideoGenerateOptions {
  prompt: string;
  model: string;
  ratio: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
  duration: 5 | 10 | 12;
}

export interface SubmissionResult {
  historyId: string;
  submitId: string;
}

function resolveImageModel(model: string): string {
  return IMAGE_MODEL_MAP[model] ?? model;
}

function resolveVideoModel(model: string): string {
  return VIDEO_MODEL_MAP[model] ?? model;
}

function resolveVideoBenefit(modelKey: string): string {
  for (const [needle, benefit] of VIDEO_BENEFIT_BY_MODEL_KEY) {
    if (modelKey.includes(needle)) {
      return benefit;
    }
  }

  return "basic_video_operation_vgfm_v_three";
}

function resolveImageResolution(resolution: ImageGenerateOptions["resolution"], ratio: ImageGenerateOptions["ratio"]): { width: number; height: number; ratio: number; resolutionType: string } {
  const bucket = IMAGE_RESOLUTION_OPTIONS[resolution];
  const resolved = bucket[ratio];

  if (!resolved) {
    throw new AppError(`Unsupported image ratio ${ratio} for resolution ${resolution}`, 2);
  }

  return {
    width: resolved.width,
    height: resolved.height,
    ratio: resolved.ratio,
    resolutionType: resolution,
  };
}

function buildMetadata() {
  return {
    type: "",
    id: randomUUID(),
    created_platform: 3,
    created_platform_version: "",
    created_time_in_ms: Date.now().toString(),
    created_did: "",
  };
}

function getHistoryId(data: GenerateSubmitData): string {
  const historyId = data.aigc_data?.history_record_id;

  if (historyId === undefined || historyId === null) {
    throw new AppError("Jimeng submit response did not include history_record_id", 1, data);
  }

  return String(historyId);
}

export class GenerationService {
  public constructor(private readonly client: Pick<JimengClient, "submitImageGenerate" | "submitVideoGenerate">) {}

  public async submitImage(options: ImageGenerateOptions): Promise<SubmissionResult> {
    const modelKey = resolveImageModel(options.model);
    const resolution = resolveImageResolution(options.resolution, options.ratio);
    const componentId = randomUUID();
    const submitId = randomUUID();
    const seed = options.seed ?? Math.floor(Math.random() * 1_000_000_000) + 2_500_000_000;

    const body = {
      extend: {
        root_model: modelKey,
      },
      submit_id: submitId,
      metrics_extra: JSON.stringify({
        promptSource: "custom",
        generateCount: 1,
        enterFrom: "click",
        position: "page_bottom_box",
        sceneOptions: JSON.stringify([
          {
            type: "image",
            scene: "ImageBasicGenerate",
            modelReqKey: modelKey,
            resolutionType: resolution.resolutionType,
            abilityList: [],
            benefitCount: 4,
            reportParams: {
              enterSource: "generate",
              vipSource: "generate",
              extraVipFunctionKey: `${modelKey}-${resolution.resolutionType}`,
              useVipFunctionDetailsReporterHoc: true,
            },
          },
        ]),
        isBoxSelect: false,
        isCutout: false,
        generateId: submitId,
        isRegenerate: false,
      }),
      draft_content: JSON.stringify({
        type: "draft",
        id: randomUUID(),
        min_version: DRAFT_MIN_VERSION,
        min_features: [],
        is_from_tsn: true,
        version: DRAFT_VERSION,
        main_component_id: componentId,
        component_list: [
          {
            type: "image_base_component",
            id: componentId,
            min_version: DRAFT_MIN_VERSION,
            aigc_mode: "workbench",
            metadata: buildMetadata(),
            generate_type: "generate",
            abilities: {
              type: "",
              id: randomUUID(),
              generate: {
                type: "",
                id: randomUUID(),
                core_param: {
                  type: "",
                  id: randomUUID(),
                  model: modelKey,
                  prompt: options.prompt,
                  ...(options.negativePrompt ? { negative_prompt: options.negativePrompt } : {}),
                  seed,
                  sample_strength: options.sampleStrength,
                  image_ratio: resolution.ratio,
                  intelligent_ratio: false,
                  generate_type: 0,
                  large_image_info: {
                    type: "",
                    id: randomUUID(),
                    min_version: DRAFT_MIN_VERSION,
                    height: resolution.height,
                    width: resolution.width,
                    resolution_type: resolution.resolutionType,
                  },
                },
                gen_option: {
                  type: "",
                  id: randomUUID(),
                  generate_all: false,
                },
              },
            },
          },
        ],
      }),
      http_common_info: {
        aid: ASSISTANT_AID,
      },
    };

    const data = await this.client.submitImageGenerate(body);
    return {
      historyId: getHistoryId(data),
      submitId,
    };
  }

  public async submitVideo(options: VideoGenerateOptions): Promise<SubmissionResult> {
    const modelKey = resolveVideoModel(options.model);
    const componentId = randomUUID();
    const submitId = randomUUID();
    const metricsExtra = JSON.stringify({
      promptSource: "custom",
      isDefaultSeed: 1,
      originSubmitId: submitId,
      isRegenerate: false,
      enterFrom: "click",
      position: "page_bottom_box",
      functionMode: "first_last_frames",
      sceneOptions: JSON.stringify([
        {
          type: "video",
          scene: "BasicVideoGenerateButton",
          modelReqKey: modelKey,
          videoDuration: options.duration,
          materialTypes: [],
          reportParams: {
            enterSource: "generate",
            vipSource: "generate",
            extraVipFunctionKey: modelKey,
            useVipFunctionDetailsReporterHoc: true,
          },
        },
      ]),
    });

    const body = {
      extend: {
        root_model: modelKey,
        m_video_commerce_info: {
          benefit_type: resolveVideoBenefit(modelKey),
          resource_id: "generate_video",
          resource_id_type: "str",
          resource_sub_type: "aigc",
        },
        m_video_commerce_info_list: [
          {
            benefit_type: resolveVideoBenefit(modelKey),
            resource_id: "generate_video",
            resource_id_type: "str",
            resource_sub_type: "aigc",
          },
        ],
      },
      submit_id: submitId,
      metrics_extra: metricsExtra,
      draft_content: JSON.stringify({
        type: "draft",
        id: randomUUID(),
        min_version: DRAFT_VERSION,
        min_features: [],
        is_from_tsn: true,
        version: DRAFT_VERSION,
        main_component_id: componentId,
        component_list: [
          {
            type: "video_base_component",
            id: componentId,
            min_version: "1.0.0",
            aigc_mode: "workbench",
            metadata: buildMetadata(),
            generate_type: "gen_video",
            abilities: {
              type: "",
              id: randomUUID(),
              gen_video: {
                id: randomUUID(),
                type: "",
                text_to_video_params: {
                  type: "",
                  id: randomUUID(),
                  video_gen_inputs: [
                    {
                      type: "",
                      id: randomUUID(),
                      min_version: "3.0.5",
                      prompt: options.prompt,
                      video_mode: 2,
                      fps: 24,
                      duration_ms: options.duration * 1000,
                      idip_meta_list: [],
                    },
                  ],
                  video_aspect_ratio: options.ratio,
                  seed: Math.floor(Math.random() * 4_294_967_296),
                  model_req_key: modelKey,
                  priority: 0,
                },
                video_task_extra: metricsExtra,
              },
            },
            process_type: 1,
          },
        ],
      }),
      http_common_info: {
        aid: ASSISTANT_AID,
      },
    };

    const data = await this.client.submitVideoGenerate(body);
    return {
      historyId: getHistoryId(data),
      submitId,
    };
  }
}
