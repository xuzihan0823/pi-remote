"use strict";

/**
 * pi-remote Relay 协议（src/protocol/relay-types.ts，RELAY_PROTOCOL_VERSION = 1）的最小实现。
 * PI-Desktop 宿主的 WebSocket 单帧上限是 1 MiB，超出会直接断开连接，所以每一帧发送前都要过体积检查。
 */

const PROTOCOL_VERSION = 1;
/** PI-Desktop 插件 WebSocket 的单帧上限（plugin-websocket.ts MAX_FRAME_BYTES）。 */
const HOST_MAX_FRAME_BYTES = 1024 * 1024;
/** 留出余量给帧头和编码差异。 */
const FRAME_BUDGET_BYTES = HOST_MAX_FRAME_BYTES - 16 * 1024;

const FRAME_TYPES = new Set(["hello", "hello_ack", "request", "response", "session_event", "error", "ping", "pong"]);

function frameBytes(text) {
  return Buffer.byteLength(text, "utf8");
}

/** 解析 Relay 发来的文本帧；失败返回 null。 */
function parseFrame(text) {
  if (typeof text !== "string") {
    if (text instanceof Uint8Array) text = Buffer.from(text).toString("utf8");
    else return null;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.version !== PROTOCOL_VERSION || !FRAME_TYPES.has(value.type)) return null;
  return value;
}

function helloFrame(deviceId, label, appVersion) {
  return {
    version: PROTOCOL_VERSION,
    type: "hello",
    deviceId,
    payload: {
      role: "agent",
      ...(label ? { label } : {}),
      ...(appVersion ? { appVersion } : {}),
    },
  };
}

function responseFrame(request, result, deviceId) {
  const payload = result && result.ok
    ? { ok: true, ...(result.data === undefined ? {} : { data: result.data }) }
    : { ok: false, error: result?.error ?? { code: "internal_error", message: "插件未返回错误详情" } };
  return {
    version: PROTOCOL_VERSION,
    type: "response",
    requestId: request.requestId,
    ...(deviceId ? { deviceId } : {}),
    ...(typeof request.sessionId === "string" && request.sessionId ? { sessionId: request.sessionId } : {}),
    payload,
  };
}

function sessionEventFrame(sessionId, event, deviceId) {
  return {
    version: PROTOCOL_VERSION,
    type: "session_event",
    ...(deviceId ? { deviceId } : {}),
    sessionId,
    payload: { event },
  };
}

function pingFrame() {
  return { version: PROTOCOL_VERSION, type: "ping", payload: { timestamp: Date.now() } };
}

function pongFrame() {
  return { version: PROTOCOL_VERSION, type: "pong", payload: {} };
}

/**
 * 序列化并检查体积。response 超限时改写为 result_too_large 错误响应（仍然回答这个 requestId，
 * 手机不会一直等到超时）；其他类型超限返回 null，调用方丢弃该帧。
 */
function encodeFrame(frame, budget = FRAME_BUDGET_BYTES) {
  const text = JSON.stringify(frame);
  if (frameBytes(text) <= budget) return text;
  if (frame.type === "response") {
    const replacement = {
      ...frame,
      payload: {
        ok: false,
        error: { code: "result_too_large", message: "Pi Desktop 返回内容过大，请缩小范围或在 Mac 上查看" },
      },
    };
    const fallback = JSON.stringify(replacement);
    return frameBytes(fallback) <= budget ? fallback : null;
  }
  return null;
}

module.exports = {
  PROTOCOL_VERSION,
  HOST_MAX_FRAME_BYTES,
  FRAME_BUDGET_BYTES,
  parseFrame,
  helloFrame,
  responseFrame,
  sessionEventFrame,
  pingFrame,
  pongFrame,
  encodeFrame,
  frameBytes,
};
