/**
 * Volcengine Doubao Podcast TTS client (websocket-v3).
 * Endpoint: wss://openspeech.bytedance.com/api/v3/sami/podcasttts
 * Resource: volc.service_type.10050
 *
 * Auth (console app): X-Api-App-Id / X-Api-Access-Key / X-Api-App-Key
 * Docs: https://www.volcengine.com/docs/6561/1668014
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EventType,
  MsgType,
  describeMessage,
  finishConnectionFrame,
  finishSessionFrame,
  startConnectionFrame,
  startSessionFrame,
  unmarshalMessage,
} from "./protocol.mjs";

export const DEFAULT_ENDPOINT =
  "wss://openspeech.bytedance.com/api/v3/sami/podcasttts";
export const DEFAULT_RESOURCE_ID = "volc.service_type.10050";
export const DEFAULT_APP_KEY = "aGjiRDfUWi";

export const DEFAULT_SPEAKERS = {
  female: "zh_female_mizaitongxue_v2_saturn_bigtts",
  male: "zh_male_dayixiansheng_v2_saturn_bigtts",
};

/**
 * @typedef {object} PodcastCredentials
 * @property {string} appId
 * @property {string} accessToken
 * @property {string} [secretKey]
 * @property {string} [endpoint]
 * @property {string} [resourceId]
 * @property {string} [appKey]
 */

/**
 * @typedef {object} NlpText
 * @property {string} text
 * @property {string} speaker
 */

/**
 * @typedef {object} GenerateOptions
 * @property {0|3|4} [action]
 * @property {string} [inputText]
 * @property {string} [inputUrl]
 * @property {string} [promptText]
 * @property {NlpText[]} [nlpTexts]
 * @property {string} [inputId]
 * @property {boolean} [useHeadMusic]
 * @property {boolean} [useTailMusic]
 * @property {boolean} [aigcWatermark]
 * @property {boolean} [returnAudioUrl]
 * @property {boolean} [onlyNlpText]
 * @property {boolean} [strictAudit]
 * @property {string} [format] mp3 | wav | ogg_opus | pcm | aac
 * @property {number} [sampleRate]
 * @property {number} [speechRate]
 * @property {{ random_order?: boolean, speakers?: string[] }} [speakerInfo]
 * @property {number} [timeoutMs]
 * @property {(line: string) => void} [onLog]
 */

/**
 * Load credentials from env (DOUBAO_PODCAST_*).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {PodcastCredentials}
 */
export function loadCredentialsFromEnv(env = process.env) {
  const appId = (env.DOUBAO_PODCAST_APP_ID || "").trim();
  const accessToken = (env.DOUBAO_PODCAST_ACCESS_TOKEN || "").trim();
  const secretKey = (env.DOUBAO_PODCAST_SECRET_KEY || "").trim();
  if (!appId || !accessToken) {
    throw new Error(
      "Missing DOUBAO_PODCAST_APP_ID / DOUBAO_PODCAST_ACCESS_TOKEN (set in .env)",
    );
  }
  return {
    appId,
    accessToken,
    secretKey,
    endpoint: (env.DOUBAO_PODCAST_ENDPOINT || DEFAULT_ENDPOINT).trim(),
    resourceId: (env.DOUBAO_PODCAST_RESOURCE_ID || DEFAULT_RESOURCE_ID).trim(),
    appKey: (env.DOUBAO_PODCAST_APP_KEY || DEFAULT_APP_KEY).trim(),
  };
}

/**
 * @param {number} seconds
 * @returns {string} HH:MM:SS.mmm
 */
export function formatTs(seconds) {
  const msTotal = Math.max(0, Math.round(Number(seconds) * 1000));
  const h = Math.floor(msTotal / 3_600_000);
  const m = Math.floor((msTotal % 3_600_000) / 60_000);
  const s = Math.floor((msTotal % 60_000) / 1000);
  const ms = msTotal % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

/**
 * @param {number} seconds
 * @returns {string} HH:MM:SS,mmm (SRT)
 */
export function formatSrtTs(seconds) {
  return formatTs(seconds).replace(".", ",");
}

/**
 * Map speaker id → [女]/[男]/[旁]
 * @param {string} speaker
 */
export function speakerLabel(speaker = "") {
  const s = String(speaker).toLowerCase();
  if (s.includes("female") || s.includes("mizai") || s.includes("nv") || s.includes("女")) {
    return "女";
  }
  if (s.includes("male") || s.includes("dayi") || s.includes("nan") || s.includes("男")) {
    return "男";
  }
  return "旁";
}

/**
 * Build .texts.json payload matching prior media-cli outputs.
 * @param {{ taskId: string, turns: object[] }} input
 */
export function buildTextsJson({ taskId, turns }) {
  const last = turns[turns.length - 1];
  const duration = last ? Number(last.end || 0) : 0;
  return {
    taskId,
    duration,
    duration_ms: Math.round(duration * 1000),
    duration_ts: formatTs(duration),
    turns: turns.length,
    texts: turns,
  };
}

/**
 * @param {object[]} turns
 * @returns {string}
 */
export function buildSrt(turns) {
  const lines = [];
  let idx = 1;
  for (const t of turns) {
    if (t.round_id === -1 || t.round_id === 9999) continue; // head/tail music
    if (!t.text) continue;
    const label = speakerLabel(t.speaker);
    lines.push(String(idx++));
    lines.push(`${formatSrtTs(t.start)} --> ${formatSrtTs(t.end)}`);
    lines.push(`[${label}] ${t.text}`);
    lines.push("");
  }
  return lines.join("\n");
}

function parseJsonPayload(buf) {
  if (!buf?.length) return null;
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Generate podcast audio + per-round timestamps.
 *
 * @param {PodcastCredentials} credentials
 * @param {GenerateOptions} options
 * @returns {Promise<{
 *   taskId: string,
 *   audio: Buffer,
 *   turns: object[],
 *   textsJson: object,
 *   srt: string,
 *   audioUrl?: string,
 *   usage?: object,
 *   podcastEnd?: object,
 * }>}
 */
export async function generatePodcast(credentials, options = {}) {
  const log = options.onLog || (() => {});
  const endpoint = credentials.endpoint || DEFAULT_ENDPOINT;
  const resourceId = credentials.resourceId || DEFAULT_RESOURCE_ID;
  const appKey = credentials.appKey || DEFAULT_APP_KEY;
  const taskId = randomUUID();
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;

  const action = options.action ?? 3;
  const format = options.format || "mp3";
  const sampleRate = options.sampleRate ?? 24000;
  const speechRate = options.speechRate ?? 0;

  /** @type {Record<string, unknown>} */
  const reqParams = {
    input_id: options.inputId || `podcast_${taskId.slice(0, 8)}`,
    action,
    use_head_music: options.useHeadMusic ?? false,
    use_tail_music: options.useTailMusic ?? false,
    aigc_watermark: options.aigcWatermark ?? false,
    audio_config: {
      format,
      sample_rate: sampleRate,
      speech_rate: speechRate,
    },
  };

  if (action === 0) {
    if (options.inputText) reqParams.input_text = options.inputText;
    reqParams.input_info = {
      input_url: options.inputUrl || undefined,
      return_audio_url: options.returnAudioUrl ?? true,
      only_nlp_text: options.onlyNlpText ?? false,
      strict_audit: options.strictAudit ?? false,
    };
  } else if (action === 3) {
    if (!options.nlpTexts?.length) {
      throw new Error("action=3 requires nlpTexts[{text,speaker},...]");
    }
    reqParams.nlp_texts = options.nlpTexts.map((t) => ({
      text: t.text,
      speaker: t.speaker,
    }));
    reqParams.input_info = {
      return_audio_url: options.returnAudioUrl ?? false,
      only_nlp_text: options.onlyNlpText ?? false,
    };
  } else if (action === 4) {
    if (!options.promptText) throw new Error("action=4 requires promptText");
    reqParams.prompt_text = options.promptText;
    reqParams.input_info = {
      return_audio_url: options.returnAudioUrl ?? true,
      only_nlp_text: options.onlyNlpText ?? false,
      strict_audit: options.strictAudit ?? false,
    };
  } else {
    throw new Error(`Unsupported action: ${action}`);
  }

  if (options.speakerInfo) {
    reqParams.speaker_info = options.speakerInfo;
  } else if (action !== 3) {
    reqParams.speaker_info = {
      random_order: false,
      speakers: [DEFAULT_SPEAKERS.female, DEFAULT_SPEAKERS.male],
    };
  }

  const headers = {
    "X-Api-App-Id": credentials.appId,
    "X-Api-Access-Key": credentials.accessToken,
    "X-Api-Resource-Id": resourceId,
    "X-Api-App-Key": appKey,
    "X-Api-Request-Id": taskId,
  };

  log(`connect ${endpoint}`);
  log(`taskId=${taskId} action=${action}`);

  const WebSocketImpl = globalThis.WebSocket;
  if (!WebSocketImpl) {
    throw new Error("WebSocket not available (use Bun or Node 22+)");
  }

  const audioChunks = [];
  const roundAudio = [];
  /** @type {object[]} */
  const turns = [];
  let current = null;
  let podcastEnd = null;
  let usage = null;
  let sessionFinished = false;

  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error(`Podcast TTS timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    /** @type {WebSocket} */
    let ws;
    try {
      // Bun / undici WebSocket accept headers via second arg options
      ws = new WebSocketImpl(endpoint, { headers });
    } catch (e) {
      clearTimeout(timer);
      reject(e);
      return;
    }

    // Node/Bun may need binaryType
    try {
      ws.binaryType = "arraybuffer";
    } catch {
      /* ignore */
    }

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const ok = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve();
    };

    const send = (frame) => {
      const buf = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
      // Bun accepts Buffer / Uint8Array
      ws.send(buf);
    };

    ws.addEventListener("open", () => {
      log("ws open → StartConnection");
      try {
        send(startConnectionFrame());
      } catch (e) {
        fail(e);
      }
    });

    ws.addEventListener("error", (ev) => {
      fail(new Error(`WebSocket error: ${ev?.message || ev?.error || "unknown"}`));
    });

    ws.addEventListener("close", (ev) => {
      if (!settled) {
        if (sessionFinished) ok();
        else fail(new Error(`WebSocket closed early code=${ev.code} reason=${ev.reason || ""}`));
      }
    });

    let phase = "wait_connection_started";

    ws.addEventListener("message", (ev) => {
      try {
        const raw =
          ev.data instanceof ArrayBuffer
            ? Buffer.from(ev.data)
            : Buffer.isBuffer(ev.data)
              ? ev.data
              : typeof ev.data === "string"
                ? Buffer.from(ev.data)
                : Buffer.from(ev.data);

        const msg = unmarshalMessage(raw);
        log(`← ${describeMessage(msg)}`);

        if (msg.type === MsgType.Error) {
          const body = msg.payload.toString("utf8");
          fail(
            new Error(
              `Server error code=${msg.errorCode} ${body || "(empty)"}`,
            ),
          );
          return;
        }

        // Audio chunks
        if (
          msg.type === MsgType.AudioOnlyServer &&
          msg.event === EventType.PodcastRoundResponse
        ) {
          if (msg.payload?.length) {
            roundAudio.push(msg.payload);
            audioChunks.push(msg.payload);
          }
          return;
        }

        if (msg.type === MsgType.FullServerResponse || msg.flag === 0b0100) {
          // Connection lifecycle
          if (msg.event === EventType.ConnectionStarted && phase === "wait_connection_started") {
            phase = "session";
            log("→ StartSession + FinishSession");
            send(startSessionFrame(taskId, reqParams));
            send(finishSessionFrame(taskId));
            return;
          }

          if (msg.event === EventType.ConnectionFailed) {
            fail(
              new Error(
                `ConnectionFailed: ${msg.payload.toString("utf8") || "auth/resource error"}`,
              ),
            );
            return;
          }

          if (msg.event === EventType.SessionStarted) {
            log("SessionStarted");
            return;
          }

          if (msg.event === EventType.SessionFailed) {
            fail(
              new Error(
                `SessionFailed: ${msg.payload.toString("utf8") || "unknown"}`,
              ),
            );
            return;
          }

          if (msg.event === EventType.PodcastRoundStart) {
            const data = parseJsonPayload(msg.payload) || {};
            current = {
              round_id: data.round_id,
              speaker: data.speaker || "",
              text: data.text || "",
              text_type: data.text_type || "",
            };
            log(
              `round start id=${current.round_id} speaker=${current.speaker} text=${(current.text || "").slice(0, 40)}`,
            );
            return;
          }

          if (msg.event === EventType.PodcastRoundEnd) {
            const data = parseJsonPayload(msg.payload) || {};
            if (data.is_error) {
              fail(new Error(`Round error: ${JSON.stringify(data)}`));
              return;
            }

            const start = Number(data.start_time ?? 0);
            const end = Number(data.end_time ?? start);
            const audioDuration = Number(
              data.audio_duration ?? Math.max(0, end - start),
            );

            // Prefer server absolute timeline; fall back to cumulative if missing
            let absStart = Number.isFinite(start) ? start : 0;
            let absEnd = Number.isFinite(end) ? end : absStart + audioDuration;
            if (
              (!Number.isFinite(data.start_time) || !Number.isFinite(data.end_time)) &&
              turns.length
            ) {
              absStart = turns[turns.length - 1].end;
              absEnd = absStart + audioDuration;
            }

            const turn = {
              index: turns.length,
              round_id: current?.round_id ?? turns.length,
              speaker: current?.speaker || "",
              text: current?.text || "",
              start: absStart,
              start_ms: Math.round(absStart * 1000),
              start_ts: formatTs(absStart),
              duration: audioDuration,
              duration_ms: Math.round(audioDuration * 1000),
              end: absEnd,
              end_ms: Math.round(absEnd * 1000),
              end_ts: formatTs(absEnd),
              server: {
                audio_duration: audioDuration,
                start_time: data.start_time,
                end_time: data.end_time,
              },
            };
            turns.push(turn);
            roundAudio.length = 0;
            current = null;
            log(
              `round end #${turn.index} ${turn.start_ts}→${turn.end_ts} (${turn.duration_ms}ms)`,
            );
            return;
          }

          if (msg.event === EventType.PodcastEnd) {
            podcastEnd = parseJsonPayload(msg.payload);
            log(`PodcastEnd ${JSON.stringify(podcastEnd)?.slice(0, 200) || ""}`);
            return;
          }

          if (msg.event === EventType.UsageResponse) {
            usage = parseJsonPayload(msg.payload);
            return;
          }

          if (msg.event === EventType.SessionFinished) {
            sessionFinished = true;
            log("SessionFinished → FinishConnection");
            try {
              send(finishConnectionFrame());
            } catch (e) {
              fail(e);
            }
            return;
          }

          if (msg.event === EventType.ConnectionFinished) {
            log("ConnectionFinished");
            ok();
            return;
          }
        }
      } catch (e) {
        fail(e);
      }
    });
  });

  const audio = Buffer.concat(audioChunks);
  if (!options.onlyNlpText && audio.length === 0) {
    throw new Error("No audio data received from Podcast TTS");
  }

  // Drop empty head/tail music-only turns from primary timeline if no text
  // but keep them if they have duration for total accuracy — include all.
  const textsJson = buildTextsJson({ taskId, turns });
  const srt = buildSrt(turns);
  const audioUrl = podcastEnd?.meta_info?.audio_url;

  return {
    taskId,
    audio,
    turns,
    textsJson,
    srt,
    audioUrl,
    usage,
    podcastEnd,
  };
}

/**
 * Generate and write mp3 + .texts.json + .srt next to output path.
 *
 * @param {PodcastCredentials} credentials
 * @param {GenerateOptions & { output: string }} options
 */
export async function generatePodcastToFiles(credentials, options) {
  const result = await generatePodcast(credentials, options);
  const out = path.resolve(options.output);
  await mkdir(path.dirname(out), { recursive: true });

  const ext = path.extname(out) || `.${options.format || "mp3"}`;
  const base = ext ? out.slice(0, -ext.length) : out;
  const audioPath = ext ? out : `${out}.${options.format || "mp3"}`;
  const textsPath = `${base}.texts.json`;
  const srtPath = `${base}.srt`;

  if (result.audio.length) {
    await writeFile(audioPath, result.audio);
  }
  await writeFile(textsPath, JSON.stringify(result.textsJson, null, 2), "utf8");
  await writeFile(srtPath, result.srt, "utf8");

  return {
    ...result,
    audioPath,
    textsPath,
    srtPath,
  };
}
