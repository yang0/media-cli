/**
 * Volcengine OpenSpeech WebSocket binary protocol (v3).
 * Port of bytedance/agentkit-samples byted-podcast-gen protocols.
 * Docs: https://www.volcengine.com/docs/6561/1668014
 */

export const MsgType = {
  Invalid: 0,
  FullClientRequest: 0b0001,
  AudioOnlyClient: 0b0010,
  FullServerResponse: 0b1001,
  AudioOnlyServer: 0b1011,
  FrontEndResultServer: 0b1100,
  Error: 0b1111,
};

export const MsgTypeFlagBits = {
  NoSeq: 0,
  PositiveSeq: 0b0001,
  LastNoSeq: 0b0010,
  NegativeSeq: 0b0011,
  WithEvent: 0b0100,
};

export const VersionBits = { Version1: 1 };
export const HeaderSizeBits = { HeaderSize4: 1 };
export const SerializationBits = { Raw: 0, JSON: 0b0001 };
export const CompressionBits = { None: 0, Gzip: 0b0001 };

export const EventType = {
  None: 0,
  StartConnection: 1,
  FinishConnection: 2,
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  ConnectionFinished: 52,
  StartSession: 100,
  CancelSession: 101,
  FinishSession: 102,
  SessionStarted: 150,
  SessionCanceled: 151,
  SessionFinished: 152,
  SessionFailed: 153,
  UsageResponse: 154,
  PodcastRoundStart: 360,
  PodcastRoundResponse: 361,
  PodcastRoundEnd: 362,
  PodcastEnd: 363,
};

function writeU32BE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function writeI32BE(n) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n | 0, 0);
  return b;
}

/**
 * @typedef {object} Message
 * @property {number} type
 * @property {number} flag
 * @property {number} version
 * @property {number} headerSize
 * @property {number} serialization
 * @property {number} compression
 * @property {number} event
 * @property {string} sessionId
 * @property {string} connectId
 * @property {number} sequence
 * @property {number} errorCode
 * @property {Buffer} payload
 */

/**
 * @param {Partial<Message>} partial
 * @returns {Message}
 */
export function createMessage(partial = {}) {
  return {
    type: MsgType.Invalid,
    flag: MsgTypeFlagBits.NoSeq,
    version: VersionBits.Version1,
    headerSize: HeaderSizeBits.HeaderSize4,
    serialization: SerializationBits.JSON,
    compression: CompressionBits.None,
    event: EventType.None,
    sessionId: "",
    connectId: "",
    sequence: 0,
    errorCode: 0,
    payload: Buffer.alloc(0),
    ...partial,
  };
}

/**
 * @param {Message} msg
 * @returns {Buffer}
 */
export function marshalMessage(msg) {
  const parts = [];

  const header = Buffer.alloc(4);
  header[0] = ((msg.version & 0xf) << 4) | (msg.headerSize & 0xf);
  header[1] = ((msg.type & 0xf) << 4) | (msg.flag & 0xf);
  header[2] = ((msg.serialization & 0xf) << 4) | (msg.compression & 0xf);
  header[3] = 0;
  parts.push(header);

  if (msg.flag === MsgTypeFlagBits.WithEvent) {
    parts.push(writeI32BE(msg.event));
    // Connection-level events do not carry session_id
    if (
      ![
        EventType.StartConnection,
        EventType.FinishConnection,
        EventType.ConnectionStarted,
        EventType.ConnectionFailed,
      ].includes(msg.event)
    ) {
      const sid = Buffer.from(msg.sessionId || "", "utf8");
      parts.push(writeU32BE(sid.length));
      if (sid.length) parts.push(sid);
    }
  }

  if (
    [MsgType.FullClientRequest, MsgType.FullServerResponse, MsgType.AudioOnlyClient, MsgType.AudioOnlyServer, MsgType.FrontEndResultServer].includes(
      msg.type,
    )
  ) {
    if (
      msg.flag === MsgTypeFlagBits.PositiveSeq ||
      msg.flag === MsgTypeFlagBits.NegativeSeq
    ) {
      parts.push(writeI32BE(msg.sequence));
    }
  } else if (msg.type === MsgType.Error) {
    parts.push(writeU32BE(msg.errorCode));
  }

  const payload = Buffer.isBuffer(msg.payload)
    ? msg.payload
    : Buffer.from(msg.payload || "");
  parts.push(writeU32BE(payload.length));
  if (payload.length) parts.push(payload);

  return Buffer.concat(parts);
}

/**
 * @param {Buffer|Uint8Array} data
 * @returns {Message}
 */
export function unmarshalMessage(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 4) {
    throw new Error(`Data too short: ${buf.length}`);
  }

  let offset = 0;
  const versionAndHeader = buf[offset++];
  const typeAndFlag = buf[offset++];
  const serAndComp = buf[offset++];
  offset++; // reserved

  const version = (versionAndHeader >> 4) & 0xf;
  const headerSize = versionAndHeader & 0xf;
  const type = (typeAndFlag >> 4) & 0xf;
  const flag = typeAndFlag & 0xf;
  const serialization = (serAndComp >> 4) & 0xf;
  const compression = serAndComp & 0xf;

  // Skip optional header padding if header_size > 1
  const headerBytes = 4 * headerSize;
  if (headerBytes > 4) {
    offset += headerBytes - 4;
  }

  /** @type {Message} */
  const msg = createMessage({
    version,
    headerSize,
    type,
    flag,
    serialization,
    compression,
  });

  const readU32 = () => {
    if (offset + 4 > buf.length) throw new Error("Unexpected EOF reading u32");
    const v = buf.readUInt32BE(offset);
    offset += 4;
    return v;
  };
  const readI32 = () => {
    if (offset + 4 > buf.length) throw new Error("Unexpected EOF reading i32");
    const v = buf.readInt32BE(offset);
    offset += 4;
    return v;
  };
  const readBytes = (n) => {
    if (offset + n > buf.length) throw new Error("Unexpected EOF reading bytes");
    const slice = buf.subarray(offset, offset + n);
    offset += n;
    return Buffer.from(slice);
  };

  // Sequence / error first for certain types, then event fields (matches official Python)
  if (
    [MsgType.FullClientRequest, MsgType.FullServerResponse, MsgType.AudioOnlyClient, MsgType.AudioOnlyServer, MsgType.FrontEndResultServer].includes(
      type,
    )
  ) {
    if (flag === MsgTypeFlagBits.PositiveSeq || flag === MsgTypeFlagBits.NegativeSeq) {
      msg.sequence = readI32();
    }
  } else if (type === MsgType.Error) {
    msg.errorCode = readU32();
  }

  if (flag === MsgTypeFlagBits.WithEvent) {
    msg.event = readI32();

    // Connection-level events: no session_id field
    if (
      ![
        EventType.StartConnection,
        EventType.FinishConnection,
        EventType.ConnectionStarted,
        EventType.ConnectionFailed,
        EventType.ConnectionFinished,
      ].includes(msg.event)
    ) {
      const sidLen = readU32();
      if (sidLen > 0) {
        msg.sessionId = readBytes(sidLen).toString("utf8");
      }
    }

    // ConnectionStarted/Failed/Finished carry connect_id
    if (
      [
        EventType.ConnectionStarted,
        EventType.ConnectionFailed,
        EventType.ConnectionFinished,
      ].includes(msg.event)
    ) {
      if (offset + 4 <= buf.length) {
        const cidLen = readU32();
        if (cidLen > 0) {
          msg.connectId = readBytes(cidLen).toString("utf8");
        }
      }
    }
  }

  if (offset + 4 <= buf.length) {
    const payloadLen = readU32();
    if (payloadLen > 0) {
      msg.payload = readBytes(payloadLen);
    }
  }

  return msg;
}

export function startConnectionFrame() {
  return marshalMessage(
    createMessage({
      type: MsgType.FullClientRequest,
      flag: MsgTypeFlagBits.WithEvent,
      event: EventType.StartConnection,
      payload: Buffer.from("{}"),
    }),
  );
}

export function finishConnectionFrame() {
  return marshalMessage(
    createMessage({
      type: MsgType.FullClientRequest,
      flag: MsgTypeFlagBits.WithEvent,
      event: EventType.FinishConnection,
      payload: Buffer.from("{}"),
    }),
  );
}

/**
 * @param {string} sessionId
 * @param {Buffer|string|object} payload
 */
export function startSessionFrame(sessionId, payload) {
  let body;
  if (Buffer.isBuffer(payload)) body = payload;
  else if (typeof payload === "string") body = Buffer.from(payload, "utf8");
  else body = Buffer.from(JSON.stringify(payload), "utf8");

  return marshalMessage(
    createMessage({
      type: MsgType.FullClientRequest,
      flag: MsgTypeFlagBits.WithEvent,
      event: EventType.StartSession,
      sessionId,
      payload: body,
    }),
  );
}

/**
 * @param {string} sessionId
 */
export function finishSessionFrame(sessionId) {
  return marshalMessage(
    createMessage({
      type: MsgType.FullClientRequest,
      flag: MsgTypeFlagBits.WithEvent,
      event: EventType.FinishSession,
      sessionId,
      payload: Buffer.from("{}"),
    }),
  );
}

export function describeMessage(msg) {
  const typeName =
    Object.entries(MsgType).find(([, v]) => v === msg.type)?.[0] || msg.type;
  const eventName =
    Object.entries(EventType).find(([, v]) => v === msg.event)?.[0] || msg.event;
  if (msg.type === MsgType.AudioOnlyServer || msg.type === MsgType.AudioOnlyClient) {
    return `${typeName}/${eventName} payload=${msg.payload.length}B`;
  }
  if (msg.type === MsgType.Error) {
    return `${typeName} code=${msg.errorCode} ${msg.payload.toString("utf8")}`;
  }
  const text = msg.payload?.length
    ? msg.payload.toString("utf8").slice(0, 200)
    : "";
  return `${typeName}/${eventName} ${text}`;
}
