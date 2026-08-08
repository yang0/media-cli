/**
 * 火山引擎 TTS — v3 HTTP 单向流 (seed-tts-2.0)
 *
 * 接口: POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
 * 认证: X-Api-Key (不需要 HMAC256)
 * 文档: https://www.volcengine.com/docs/6561/2528925
 *
 * 环境变量:
 *   VOLC_API_KEY     - X-Api-Key
 */

export const DEFAULT_VOICE = "zh_female_vv_uranus_bigtts";

export interface TTSOptions {
  text: string;
  apiKey?: string;
  voiceType?: string;
  encoding?: "mp3" | "wav" | "pcm" | "opus";
  sampleRate?: number;
  /** 语种: zh | en | ja | es-mx | id | pt-br | ko */
  language?: string;
}

export interface TTSResult {
  audio: Uint8Array;
}

const V3_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";

/**
 * v3 HTTP 单向流 TTS (seed-tts-2.0)
 * 支持多语种 (explicit_language)
 */
export async function textToSpeech(options: TTSOptions): Promise<TTSResult> {
  const {
    text,
    apiKey = process.env.VOLC_API_KEY || "",
    voiceType = DEFAULT_VOICE,
    encoding = "mp3",
    sampleRate = 24000,
    language,
  } = options;

  if (!apiKey) throw new Error("❌ 缺少 VOLC_API_KEY");

  // 构建 request body
  const req_params: any = {
    text,
    speaker: voiceType,
    audio_params: {
      format: encoding,
      sample_rate: sampleRate,
    },
  };

  // 指定语种 (explicit_language)
  if (language && language !== "zh") {
    req_params.additions = JSON.stringify({ explicit_language: language });
  }

  const response = await fetch(V3_URL, {
    method: "POST",
    headers: {
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": "seed-tts-2.0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ req_params }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`TTS 请求失败 (${response.status}): ${err.slice(0, 300)}`);
  }

  // 解析流式响应 (每行一个 JSON)
  const raw = await response.text();
  let audioBase64 = "";
  let lastCode = 0;
  let lastMsg = "";

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.data) audioBase64 += obj.data;
      if (obj.code !== undefined) {
        lastCode = obj.code;
        lastMsg = obj.message || "";
      }
    } catch {}
  }

  if (lastCode !== 0 && lastCode !== 20000000) {
    throw new Error(`TTS 错误 (${lastCode}): ${lastMsg}`);
  }

  if (!audioBase64) {
    throw new Error(`TTS 未返回音频数据 (code=${lastCode})`);
  }

  return { audio: Buffer.from(audioBase64, "base64") };
}
