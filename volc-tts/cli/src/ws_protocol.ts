/**
 * v3 双向 WebSocket TTS 二进制协议
 * 基于官方 Python SDK (seed-tts-2.0)
 * doc: https://www.volcengine.com/docs/6561/2532486
 *
 * Headers:
 *   X-Api-Key: {api_key}
 *   X-Api-Resource-Id: seed-tts-2.0
 *   X-Api-Connect-Id: {uuid}
 *   X-Control-Require-Usage-Tokens-Return: *
 */

import WebSocket from "ws";

// === Protocol constants matching Python SDK ===

const enum MsgType {
  FullClientRequest = 0b1,
  AudioOnlyClient = 0b10,
  FullServerResponse = 0b1001,
  AudioOnlyServer = 0b1011,
  Error = 0b1111,
}

const enum Flag {
  NoSeq = 0,
  PositiveSeq = 0b1,
  LastNoSeq = 0b10,
  NegativeSeq = 0b11,
  WithEvent = 0b100,
}

const enum Event {
  StartConnection = 1,
  FinishConnection = 2,
  ConnectionStarted = 50,
  ConnectionFailed = 51,
  ConnectionFinished = 52,
  StartSession = 100,
  CancelSession = 101,
  FinishSession = 102,
  SessionStarted = 150,
  SessionCanceled = 151,
  SessionFinished = 152,
  SessionFailed = 153,
  TaskRequest = 200,
  TTSSentenceStart = 350,
  TTSSentenceEnd = 351,
  TTSResponse = 352,
  TTSSubtitle = 364,
  TTSEnded = 359,
}

// === Binary message builder (following Python struct format) ===

export function buildMessage(
  msgType: number,
  flag: number,
  event: number = 0,
  sessionId?: string,
  payload: Buffer = Buffer.from("{}")
): Buffer {
  const parts: Buffer[] = [];

  // Header: version(4)|headerSize(4), msgType(4)|flag(4), serialization(4)|compression(4)
  // headerSize=1 means 4 bytes, 2=8, 3=12, 4=16
  const hdrSize = 1;
  const serialBuf = Buffer.alloc(3);
  serialBuf[0] = (1 << 4) | hdrSize; // Version1 | HeaderSize4
  serialBuf[1] = (msgType << 4) | flag; // MsgType | Flag
  serialBuf[2] = (1 << 4) | 0; // JSON | NoCompression
  parts.push(serialBuf);

  // Padding to headerSize * 4
  const headerBytes = hdrSize * 4;
  const padding = headerBytes - 3;
  if (padding > 0) parts.push(Buffer.alloc(padding));

  // For WithEvent: write event + (optional sessionId) + (optional connectId)
  if (flag === Flag.WithEvent) {
    const evBuf = Buffer.alloc(4);
    evBuf.writeInt32BE(event);
    parts.push(evBuf);

    // Session ID: for session-level events (StartSession, FinishSession, TaskRequest, etc.)
    const skipSession = [Event.StartConnection, Event.FinishConnection];
    if (!skipSession.includes(event)) {
      if (sessionId) {
        const idBuf = Buffer.from(sessionId, "utf-8");
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(idBuf.length);
        parts.push(lenBuf, idBuf);
      } else {
        parts.push(Buffer.alloc(4)); // length=0
      }
    }
  }

  // Payload length + data
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(payload.length);
  parts.push(lenBuf, payload);

  return Buffer.concat(parts);
}

export function parseMessage(data: Buffer): {
  msgType: number; flag: number; event?: number;
  sessionId?: string; connectId?: string; payload: Buffer;
} {
  if (data.length < 3) return { msgType: 0, flag: 0, payload: Buffer.alloc(0) };
  const b1 = data[1];
  const msgType = b1 >> 4;
  const flag = b1 & 0xf;
  const hdrSizeCode = data[0] & 0xf;
  const headerBytes = hdrSizeCode * 4;
  let offset = headerBytes;

  let event: number | undefined;
  let sessionId: string | undefined;
  let connectId: string | undefined;

  if (flag === Flag.WithEvent) {
    if (offset + 4 > data.length) return { msgType, flag, payload: Buffer.alloc(0) };
    event = data.readInt32BE(offset);
    offset += 4;

    // Session ID (only for session-level events)
    const skipSession = [1, 2]; // StartConnection, FinishConnection
    if (event && !skipSession.includes(event)) {
      if (offset + 4 <= data.length) {
        const sLen = data.readUInt32BE(offset);
        offset += 4;
        if (sLen > 0 && offset + sLen <= data.length) {
          sessionId = data.slice(offset, offset + sLen).toString("utf-8");
          offset += sLen;
        }
      }
    }

    // Connect ID (only in server responses like ConnectionStarted)
    if (event && [50, 51, 52].includes(event)) {
      if (offset + 4 <= data.length) {
        const cLen = data.readUInt32BE(offset);
        offset += 4;
        if (cLen > 0 && offset + cLen <= data.length) {
          connectId = data.slice(offset, offset + cLen).toString("utf-8");
          offset += cLen;
        }
      }
    }
  }

  // Payload
  if (offset + 4 > data.length) return { msgType, flag, event, sessionId, connectId, payload: Buffer.alloc(0) };
  const pLen = data.readUInt32BE(offset);
  offset += 4;
  const payload = pLen > 0 && offset + pLen <= data.length
    ? data.slice(offset, offset + pLen) : Buffer.alloc(0);

  return { msgType, flag, event, sessionId, connectId, payload };
}

// === Main function following official example ===

const WS_V3_URL = "wss://openspeech.bytedance.com/api/v3/tts/bidirection";
const RESOURCE_ID = "seed-tts-2.0";

/**
 * v3 bidirectional WebSocket TTS (官方二进制协议)
 * 支持多语种 + 字幕回传 (enable_subtitle: true)
 */
export async function textToSpeechV3(
  text: string,
  apiKey: string,
  speaker: string = "zh_female_vv_uranus_bigtts",
  enableSubtitle: boolean = true
): Promise<{ audio: Buffer; subtitle?: string }> {
  const sessionId = crypto.randomUUID();
  const connectId = crypto.randomUUID();
  const audioChunks: Buffer[] = [];
  let subtitleLines: { start: number; end: number; text: string }[] = [];
  let audioDone = false;
  let error: Error | null = null;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_V3_URL, {
      headers: {
        "X-Api-Key": apiKey,
        "X-Api-Resource-Id": RESOURCE_ID,
        "X-Api-Connect-Id": connectId,
        "X-Control-Require-Usage-Tokens-Return": "*",
      },
    });

    const timeout = setTimeout(() => {
      if (!audioDone) { audioDone = true; reject(new Error("v3 WS 超时")); }
    }, 120000);

    let step = "init";

    ws.on("open", () => {
      // Step 1: StartConnection
      step = "conn";
      ws.send(buildMessage(MsgType.FullClientRequest, Flag.WithEvent, Event.StartConnection));
    });

    ws.on("message", (raw: Buffer) => {
      try {
        const msg = parseMessage(raw as Buffer);

        if (msg.msgType === MsgType.FullServerResponse) {
          // ConnectionStarted → StartSession
          if (msg.event === Event.ConnectionStarted && step === "conn") {
            step = "session";
            const payload = JSON.stringify({
              event: Event.StartSession,
              req_params: {
                speaker,
                audio_params: {
                  format: "mp3",
                  sample_rate: 24000,
                  enable_subtitle: enableSubtitle,
                },
              },
            });
            ws.send(buildMessage(MsgType.FullClientRequest, Flag.WithEvent, Event.StartSession, sessionId, Buffer.from(payload)));
            return;
          }

          // SessionStarted → send entire text as one batch request
          if (msg.event === Event.SessionStarted && step === "session") {
            step = "sending";
            const taskPayload = JSON.stringify({
              event: Event.TaskRequest,
              req_params: {
                speaker,
                audio_params: {
                  format: "mp3",
                  sample_rate: 24000,
                  enable_subtitle: enableSubtitle,
                },
                text,
              },
            });
            ws.send(buildMessage(MsgType.FullClientRequest, Flag.WithEvent, Event.TaskRequest, sessionId, Buffer.from(taskPayload)));
            // 发送完文本后立即 FinishSession（音频会在此之后陆续到达）
            ws.send(buildMessage(MsgType.FullClientRequest, Flag.WithEvent, Event.FinishSession, sessionId, Buffer.from("{}")));
            step = "done";
            return;
          }

          // SessionFinished → all done, close
          if (msg.event === Event.SessionFinished) {
            audioDone = true;
            clearTimeout(timeout);
            ws.send(buildMessage(MsgType.FullClientRequest, Flag.WithEvent, Event.FinishConnection));
            setTimeout(() => ws.close(), 500);

            const result: { audio: Buffer; subtitle?: string } = {
              audio: Buffer.concat(audioChunks),
            };
            if (subtitleLines.length > 0) {
              result.subtitle = subtitleLines
                .map((s, i) => `${i + 1}\n${fmtTimeSRT(s.start)} --> ${fmtTimeSRT(s.end)}\n${s.text}\n`)
                .join("\n");
            }
            resolve(result);
            return;
          }

          // Subtitle data
          if (msg.event === Event.TTSSubtitle && msg.payload.length > 0) {
            try {
              const payload = JSON.parse(msg.payload.toString());
              const subs = payload.subtitle || payload.additions?.subtitle;
              if (Array.isArray(subs)) {
                subtitleLines = subs.map((s: any) => ({
                  start: s.start_time || s.startTime || 0,
                  end: s.end_time || s.endTime || 0,
                  text: s.text || "",
                }));
              }
            } catch {}
          }
        }

        // Audio data
        if (msg.msgType === MsgType.AudioOnlyServer && msg.payload.length > 0) {
          audioChunks.push(msg.payload);
        }

        // Error
        if (msg.msgType === MsgType.Error) {
          const errText = msg.payload.toString("utf-8");
          error = new Error(`TTS WS 错误: ${errText}`);
        }
      } catch (e: any) {
        error = e;
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      if (!audioDone) reject(new Error(`v3 WS 连接失败: ${err.message}`));
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      if (error) reject(error);
      else if (!audioDone && audioChunks.length === 0) reject(new Error("v3 WS 未收到音频"));
    });
  });
}

function fmtTimeSRT(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const ml = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad3(ml)}`;
}
const pad = (n: number) => String(n).padStart(2, "0");
const pad3 = (n: number) => String(n).padStart(3, "0");
