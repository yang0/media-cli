import { describe, expect, it } from "vitest";

import { GenerationService, getSupportedModels } from "../../src/services/generation-service.js";

describe("GenerationService", () => {
  it("exposes supported models for CLI listing", () => {
    expect(getSupportedModels("image")).toEqual([
      { kind: "image", alias: "jimeng-4.0", key: "high_aes_general_v40" },
      { kind: "image", alias: "jimeng-4.1", key: "high_aes_general_v41" },
      { kind: "image", alias: "jimeng-4.5", key: "high_aes_general_v40l" },
      { kind: "image", alias: "jimeng-4.6", key: "high_aes_general_v42" },
      { kind: "image", alias: "jimeng-5.0", key: "high_aes_general_v50" },
    ]);
    expect(getSupportedModels("video")[0]).toEqual({
      kind: "video",
      alias: "jimeng-video-3.0",
      key: "dreamina_ic_generate_video_model_vgfm_3.0",
    });
  });

  it("maps image model aliases into Jimeng request payloads", async () => {
    let capturedBody = "";
    const service = new GenerationService({
      submitImageGenerate: async (body) => {
        capturedBody = JSON.stringify(body);
        return { aigc_data: { history_record_id: "history-image-1" } };
      },
      submitVideoGenerate: async () => {
        throw new Error("not used");
      },
    });

    const result = await service.submitImage({
      prompt: "a neon fox",
      model: "jimeng-5.0",
      ratio: "1:1",
      resolution: "2k",
      sampleStrength: 0.5,
    });

    expect(result.historyId).toBe("history-image-1");
    const parsed = JSON.parse(capturedBody) as { extend: { root_model: string }; draft_content: string };
    const draft = JSON.parse(parsed.draft_content) as {
      component_list: Array<{
        abilities: {
          generate: {
            core_param: {
              prompt: string;
            };
          };
        };
      }>;
    };

    expect(parsed.extend.root_model).toBe("high_aes_general_v50");
    expect(draft.component_list[0]?.abilities.generate.core_param.prompt).toBe("a neon fox");
  });

  it("maps video model aliases into Jimeng request payloads", async () => {
    let capturedBody = "";
    const service = new GenerationService({
      submitImageGenerate: async () => {
        throw new Error("not used");
      },
      submitVideoGenerate: async (body) => {
        capturedBody = JSON.stringify(body);
        return { aigc_data: { history_record_id: "history-video-1" } };
      },
    });

    const result = await service.submitVideo({
      prompt: "a drifting spaceship",
      model: "jimeng-video-3.5-pro",
      ratio: "16:9",
      duration: 5,
    });

    expect(result.historyId).toBe("history-video-1");
    const parsed = JSON.parse(capturedBody) as { extend: { root_model: string }; draft_content: string };
    const draft = JSON.parse(parsed.draft_content) as {
      component_list: Array<{
        abilities: {
          gen_video: {
            text_to_video_params: {
              video_aspect_ratio: string;
            };
          };
        };
      }>;
    };

    expect(parsed.extend.root_model).toBe("dreamina_ic_generate_video_model_vgfm_3.5_pro");
    expect(draft.component_list[0]?.abilities.gen_video.text_to_video_params.video_aspect_ratio).toBe("16:9");
  });
});
