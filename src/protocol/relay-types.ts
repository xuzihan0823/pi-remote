import type { UiDialogResponse } from "./types.ts";

export const RELAY_PROTOCOL_VERSION = 1;

export type RelayRole = "ios" | "agent";

export type RelayFrameType =
  | "hello"
  | "hello_ack"
  | "request"
  | "response"
  | "session_event"
  | "error"
  | "ping"
  | "pong";

export type RelayRequestMethod =
  | "subscribe"
  | "unsubscribe"
  | "session.list"
  | "session.start"
  | "session.get"
  | "session.prompt"
  | "session.abort"
  | "ui.response";

export const RELAY_REQUEST_METHODS: readonly RelayRequestMethod[] = [
  "subscribe",
  "unsubscribe",
  "session.list",
  "session.start",
  "session.get",
  "session.prompt",
  "session.abort",
  "ui.response",
];

export type RelayErrorCode =
  | "invalid_frame"
  | "invalid_json"
  | "unsupported_version"
  | "unauthorized"
  | "hello_required"
  | "agent_already_connected"
  | "no_agent_connected"
  | "unknown_session"
  | "session_busy"
  | "duplicate_request_id"
  | "timeout"
  | "agent_disconnected"
  | "not_implemented"
  | "internal_error";

export interface RelayErrorInfo {
  code: RelayErrorCode;
  message: string;
}

export interface RelayHelloPayload {
  role: RelayRole;
  label?: string;
  appVersion?: string;
}

export interface RelayHelloFrame {
  version: number;
  type: "hello";
  deviceId: string;
  payload: RelayHelloPayload;
}

export interface RelayHelloAckFrame {
  version: number;
  type: "hello_ack";
  deviceId: string;
  payload: {
    role: RelayRole;
    protocolVersion: number;
    agentConnected: boolean;
    iosClients: number;
  };
}

export interface RelayRequestFrame {
  version: number;
  type: "request";
  requestId: string;
  deviceId?: string;
  sessionId?: string;
  payload: {
    method: RelayRequestMethod;
    params?: Record<string, unknown>;
  };
}

export interface RelayResponseFrame {
  version: number;
  type: "response";
  requestId: string;
  deviceId?: string;
  sessionId?: string;
  payload: {
    ok: boolean;
    data?: unknown;
    error?: RelayErrorInfo;
  };
}

export interface RelaySessionEventFrame {
  version: number;
  type: "session_event";
  deviceId?: string;
  sessionId: string;
  payload: {
    event: unknown;
  };
}

export interface RelayErrorFrame {
  version: number;
  type: "error";
  requestId?: string;
  deviceId?: string;
  sessionId?: string;
  payload: RelayErrorInfo;
}

export interface RelayPingFrame {
  version: number;
  type: "ping";
  payload: { timestamp?: number };
}

export interface RelayPongFrame {
  version: number;
  type: "pong";
  payload: { timestamp?: number };
}

export type RelayFrame =
  | RelayHelloFrame
  | RelayHelloAckFrame
  | RelayRequestFrame
  | RelayResponseFrame
  | RelaySessionEventFrame
  | RelayErrorFrame
  | RelayPingFrame
  | RelayPongFrame;

export type RelayParseResult = { ok: true; frame: RelayFrame } | { ok: false; error: RelayErrorInfo };

export function relayError(code: RelayErrorCode, message: string): RelayErrorInfo {
  return { code, message };
}

export function relayErrorFrame(
  error: RelayErrorInfo,
  extra: { requestId?: string; deviceId?: string; sessionId?: string } = {},
): RelayErrorFrame {
  const frame: RelayErrorFrame = {
    version: RELAY_PROTOCOL_VERSION,
    type: "error",
    payload: error,
  };
  if (extra.requestId !== undefined) frame.requestId = extra.requestId;
  if (extra.deviceId !== undefined) frame.deviceId = extra.deviceId;
  if (extra.sessionId !== undefined) frame.sessionId = extra.sessionId;
  return frame;
}

export function relayResponseFrame(
  requestId: string,
  payload: RelayResponseFrame["payload"],
  extra: { deviceId?: string; sessionId?: string } = {},
): RelayResponseFrame {
  const frame: RelayResponseFrame = {
    version: RELAY_PROTOCOL_VERSION,
    type: "response",
    requestId,
    payload,
  };
  if (extra.deviceId !== undefined) frame.deviceId = extra.deviceId;
  if (extra.sessionId !== undefined) frame.sessionId = extra.sessionId;
  return frame;
}

export function parseRelayFrame(raw: unknown): RelayParseResult {
  const record = asRecord(raw);
  if (!record) {
    return { ok: false, error: relayError("invalid_frame", "Frame must be a JSON object") };
  }
  if (record.version !== RELAY_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: relayError(
        "unsupported_version",
        `Unsupported protocol version ${JSON.stringify(record.version)}, expected ${RELAY_PROTOCOL_VERSION}`,
      ),
    };
  }

  const type = record.type;
  switch (type) {
    case "hello":
      return parseHello(record);
    case "hello_ack":
      return parseHelloAck(record);
    case "request":
      return parseRequest(record);
    case "response":
      return parseResponse(record);
    case "session_event":
      return parseSessionEvent(record);
    case "error":
      return parseError(record);
    case "ping":
    case "pong":
      return { ok: true, frame: { version: RELAY_PROTOCOL_VERSION, type, payload: {} } };
    default:
      return { ok: false, error: relayError("invalid_frame", `Unknown frame type ${JSON.stringify(type)}`) };
  }
}

function parseHello(record: Record<string, unknown>): RelayParseResult {
  const deviceId = nonEmptyString(record.deviceId);
  if (!deviceId) {
    return { ok: false, error: relayError("invalid_frame", "hello.deviceId must be a non-empty string") };
  }
  const payload = asRecord(record.payload);
  const role = payload?.role;
  if (role !== "ios" && role !== "agent") {
    return { ok: false, error: relayError("invalid_frame", "hello.payload.role must be \"ios\" or \"agent\"") };
  }
  const hello: RelayHelloPayload = { role };
  if (typeof payload?.label === "string") hello.label = payload.label;
  if (typeof payload?.appVersion === "string") hello.appVersion = payload.appVersion;
  return { ok: true, frame: { version: RELAY_PROTOCOL_VERSION, type: "hello", deviceId, payload: hello } };
}

function parseHelloAck(record: Record<string, unknown>): RelayParseResult {
  const deviceId = nonEmptyString(record.deviceId);
  if (!deviceId) {
    return { ok: false, error: relayError("invalid_frame", "hello_ack.deviceId must be a non-empty string") };
  }
  const payload = asRecord(record.payload);
  const role = payload?.role;
  if (role !== "ios" && role !== "agent") {
    return { ok: false, error: relayError("invalid_frame", "hello_ack.payload.role must be \"ios\" or \"agent\"") };
  }
  return {
    ok: true,
    frame: {
      version: RELAY_PROTOCOL_VERSION,
      type: "hello_ack",
      deviceId,
      payload: {
        role,
        protocolVersion: typeof payload?.protocolVersion === "number" ? payload.protocolVersion : RELAY_PROTOCOL_VERSION,
        agentConnected: payload?.agentConnected === true,
        iosClients: typeof payload?.iosClients === "number" ? payload.iosClients : 0,
      },
    },
  };
}

function parseRequest(record: Record<string, unknown>): RelayParseResult {
  const requestId = nonEmptyString(record.requestId);
  if (!requestId) {
    return { ok: false, error: relayError("invalid_frame", "request.requestId must be a non-empty string") };
  }
  const payload = asRecord(record.payload);
  const method = payload?.method;
  if (!isRequestMethod(method)) {
    return { ok: false, error: relayError("invalid_frame", `request.payload.method is not a known method: ${JSON.stringify(method)}`) };
  }
  const params = asRecord(payload?.params);
  const frame: RelayRequestFrame = {
    version: RELAY_PROTOCOL_VERSION,
    type: "request",
    requestId,
    payload: params ? { method, params } : { method },
  };
  assignOptionalStrings(frame, record);
  return { ok: true, frame };
}

function parseResponse(record: Record<string, unknown>): RelayParseResult {
  const requestId = nonEmptyString(record.requestId);
  if (!requestId) {
    return { ok: false, error: relayError("invalid_frame", "response.requestId must be a non-empty string") };
  }
  const payload = asRecord(record.payload);
  if (typeof payload?.ok !== "boolean") {
    return { ok: false, error: relayError("invalid_frame", "response.payload.ok must be a boolean") };
  }
  const responsePayload: RelayResponseFrame["payload"] = { ok: payload.ok };
  if ("data" in payload) responsePayload.data = payload.data;
  if (payload.error !== undefined) {
    const error = asRecord(payload.error);
    if (!error || typeof error.code !== "string" || typeof error.message !== "string") {
      return { ok: false, error: relayError("invalid_frame", "response.payload.error must have string code and message") };
    }
    responsePayload.error = { code: error.code as RelayErrorCode, message: error.message };
  }
  const frame: RelayResponseFrame = {
    version: RELAY_PROTOCOL_VERSION,
    type: "response",
    requestId,
    payload: responsePayload,
  };
  assignOptionalStrings(frame, record);
  return { ok: true, frame };
}

function parseSessionEvent(record: Record<string, unknown>): RelayParseResult {
  const sessionId = nonEmptyString(record.sessionId);
  if (!sessionId) {
    return { ok: false, error: relayError("invalid_frame", "session_event.sessionId must be a non-empty string") };
  }
  const payload = asRecord(record.payload);
  if (!payload || !("event" in payload)) {
    return { ok: false, error: relayError("invalid_frame", "session_event.payload.event is required") };
  }
  const frame: RelaySessionEventFrame = {
    version: RELAY_PROTOCOL_VERSION,
    type: "session_event",
    sessionId,
    payload: { event: payload.event },
  };
  assignOptionalStrings(frame, record);
  return { ok: true, frame };
}

function parseError(record: Record<string, unknown>): RelayParseResult {
  const payload = asRecord(record.payload);
  if (!payload || typeof payload.code !== "string" || typeof payload.message !== "string") {
    return { ok: false, error: relayError("invalid_frame", "error.payload must have string code and message") };
  }
  const frame: RelayErrorFrame = {
    version: RELAY_PROTOCOL_VERSION,
    type: "error",
    payload: { code: payload.code as RelayErrorCode, message: payload.message },
  };
  assignOptionalStrings(frame, record);
  return { ok: true, frame };
}

export function isRequestMethod(value: unknown): value is RelayRequestMethod {
  return typeof value === "string" && (RELAY_REQUEST_METHODS as readonly string[]).includes(value);
}

function assignOptionalStrings(
  target: { deviceId?: string; sessionId?: string },
  source: Record<string, unknown>,
): void {
  const deviceId = nonEmptyString(source.deviceId);
  if (deviceId) target.deviceId = deviceId;
  const sessionId = nonEmptyString(source.sessionId);
  if (sessionId) target.sessionId = sessionId;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface SubscribeParams {
  sessionId?: string;
}

export interface SessionStartParams {
  /** Omitted mode retains the original managed RPC behavior. */
  mode?: "terminal" | "rpc";
  sessionId?: string;
  cwd?: string;
  args?: string[];
}

export interface SessionGetParams {
  sessionId?: string;
}

export interface SessionPromptParams {
  message: string;
  images?: unknown[];
}

export interface SessionAbortParams {
  sessionId?: string;
}

export interface UiResponseParams {
  requestId: string;
  response: UiDialogResponse;
}
