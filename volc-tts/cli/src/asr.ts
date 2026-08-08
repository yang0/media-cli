/**
 * 火山引擎 ASR (语音识别) API 客户端
 *
 * 复用 volc_srt.py 的接口逻辑，用 TypeScript 重写
 * 接口: POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
 * 认证: x-api-key
 */

/** ASR 请求参数 */
export interface ASROptions {
  audioPath: string;
  apiKey: string;
  maxChars?: number;
  enablePunc?: boolean;
  enableItn?: boolean;
  verbose?: boolean;
  language?: string;
}

const ASR_API_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
const RESOURCE_ID = "volc.seedasr.auc";

/**
 * 音频文件转 SRT 字幕
 */
export async function audioToSubtitle(options: ASROptions): Promise<string> {
  const {
    audioPath, apiKey,
    maxChars = 20, // 中文用 20，英文用 45
    enablePunc = true, enableItn = true,
    verbose = false, language,
  } = options;

  // 1. 读取音频并转为 base64
  const audioFile = Bun.file(audioPath);
  const audioBuffer = Buffer.from(await audioFile.arrayBuffer());
  const audioBase64 = audioBuffer.toString("base64");

  if (verbose) {
    console.log(`  📦 音频: ${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB`);
  }

  // 2. 构建请求
  const body: any = {
    user: { uid: "volc-tts-cli" },
    audio: { data: audioBase64 },
    request: {
      model_name: "bigmodel",
      enable_punc: enablePunc,
      enable_itn: enableItn,
      show_utterances: true,
    },
  };
  if (language) body.request["language"] = language;

  const reqId = crypto.randomUUID();

  if (verbose) {
    process.stdout.write("  📡 请求 ASR API... ");
  }

  // 3. 调用 API
  const response = await fetch(ASR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "X-Api-Resource-Id": RESOURCE_ID,
      "X-Api-Request-Id": reqId,
      "X-Api-Sequence": "-1",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ASR API 请求失败 (${response.status}): ${errorText.slice(0, 300)}`);
  }

  const result = await response.json();

  // 检查状态
  const statusCode = response.headers.get("X-Api-Status-Code") || "";
  if (statusCode !== "20000000") {
    throw new Error(`ASR API 错误: ${statusCode} - ${response.headers.get("X-Api-Message") || "未知"}`);
  }

  if (verbose) {
    console.log("✅");
  }

  // 4. 解析识别结果
  const utterances = parseUtterances(result);

  if (!utterances.length) {
    throw new Error("ASR API 未返回有效的识别结果");
  }

  if (verbose) {
    console.log(`  🗣️  识别出 ${utterances.length} 句`);
  }

  // 5. 长句拆分
  const splitUtterances = splitLongUtterances(utterances, maxChars);

  // 6. 生成 SRT
  return generateSRT(splitUtterances);
}

/** 解析 API 响应 */
interface Utterance {
  text: string;
  start_time: number;
  end_time: number;
}

function parseUtterances(response: any): Utterance[] {
  const result = response?.result;
  if (!result) return [];

  const utterances = result.utterances || [];
  if (!utterances.length) {
    const text = result.text;
    if (text) {
      const duration = response?.audio_info?.duration || 0;
      return [{ text, start_time: 0, end_time: duration }];
    }
    return [];
  }

  return utterances.map((u: any) => ({
    text: u.text || "",
    start_time: u.start_time || 0,
    end_time: u.end_time || 0,
  })).filter((u: Utterance) => u.text.trim());
}

/** 长句拆分 */
function splitLongUtterances(utterances: Utterance[], maxChars: number): Utterance[] {
  const result: Utterance[] = [];

  for (const u of utterances) {
    const text = u.text.trim();
    if (text.length <= maxChars) {
      result.push(u);
      continue;
    }

    const duration = u.end_time - u.start_time;
    if (duration <= 0) {
      result.push(u);
      continue;
    }

    const totalChars = text.length;
    let pos = 0;

    while (pos < totalChars) {
      const end = Math.min(pos + maxChars, totalChars);
      // 找标点或空格最佳拆分点
      let splitPos = end;
      if (end < totalChars) {
        const segment = text.slice(pos, end);
        // 优先中英文标点
        const lastPunc = Math.max(
          segment.lastIndexOf("。"), segment.lastIndexOf("，"),
          segment.lastIndexOf("！"), segment.lastIndexOf("？"),
          segment.lastIndexOf("；"), segment.lastIndexOf("\n"),
          segment.lastIndexOf("."), segment.lastIndexOf(","),
          segment.lastIndexOf("!"), segment.lastIndexOf("?"),
          segment.lastIndexOf(";"),
        );
        if (lastPunc > 0) {
          splitPos = pos + lastPunc + 1;
        } else {
          // 没有标点，找最后一个空格（英文单词边界）
          const lastSpace = segment.lastIndexOf(" ");
          if (lastSpace > 0) splitPos = pos + lastSpace + 1;
        }
      }

      const segText = text.slice(pos, splitPos).trim();
      if (segText) {
        result.push({
          text: segText,
          start_time: u.start_time + Math.floor((pos / totalChars) * duration),
          end_time: splitPos < totalChars
            ? u.start_time + Math.floor((splitPos / totalChars) * duration)
            : u.end_time,
        });
      }
      pos = splitPos;
    }
  }

  return result;
}

/** 毫秒转 SRT 时间格式 */
function formatTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const ml = ms % 1000;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")},${ml.toString().padStart(3, "0")}`;
}

/** 生成 SRT 字幕 */
function generateSRT(utterances: Utterance[]): string {
  const lines: string[] = [];

  for (let i = 0; i < utterances.length; i++) {
    const u = utterances[i];
    const text = u.text.trim();
    if (!text) continue;

    lines.push(String(i + 1));
    lines.push(`${formatTime(u.start_time)} --> ${formatTime(u.end_time)}`);
    lines.push(text);
    lines.push("");
  }

  return lines.join("\n");
}
