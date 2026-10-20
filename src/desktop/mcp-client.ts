import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export interface DesktopMcpClientOptions {
  connectionFiles?: string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface DesktopMcpClient {
  call(tool: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export class DesktopConnectionError extends Error {
  readonly code: string;

  constructor(message: string, code = "not_connected") {
    super(message);
    this.name = "DesktopConnectionError";
    this.code = code;
  }
}

interface FileIdentity {
  path: string;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface DesktopConnection {
  readonly fingerprint: string;
  readonly port: number;
  readonly token: string;
}

interface McpSession {
  readonly connection: DesktopConnection;
  readonly id: string;
  readonly protocolVersion: "2025-06-18" | "2025-03-26";
}

interface HttpResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

interface RpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface RpcExchange {
  readonly response: RpcResponse;
  readonly headers: IncomingHttpHeaders;
}

class RequestFailure extends Error {
  readonly kind: "timeout" | "network" | "too_large";

  constructor(kind: "timeout" | "network" | "too_large") {
    super(kind);
    this.kind = kind;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_CONNECTION_FILE_BYTES = 16 * 1024;
const CONNECTION_ERROR_MESSAGE = "无法连接 Pi Desktop，请确认桌面端已启动并启用本机 MCP。";
const PROTOCOL_ERROR_MESSAGE = "Pi Desktop MCP 响应无效，请检查桌面端状态后重试。";
const UNCERTAIN_RESULT_MESSAGE = "Pi Desktop 操作结果无法确认，请先检查桌面端会话状态，再决定是否重试。";
const INITIALIZE_PROTOCOL_VERSION = "2025-06-18";
const ACCEPT_HEADER = "application/json, text/event-stream";
const CONNECTION_FILE_NAMES = [
  join(".pi-desktop", "mcp-control.json"),
  join("Library", "Application Support", "PI-Desktop", "mcp-control.json"),
];

function connectionError(): DesktopConnectionError {
  return new DesktopConnectionError(CONNECTION_ERROR_MESSAGE, "not_connected");
}

function protocolError(): DesktopConnectionError {
  return new DesktopConnectionError(PROTOCOL_ERROR_MESSAGE, "protocol_error");
}

function uncertainResult(): DesktopConnectionError {
  return new DesktopConnectionError(UNCERTAIN_RESULT_MESSAGE, "result_uncertain");
}

function resultTooLarge(): DesktopConnectionError {
  return new DesktopConnectionError("Pi Desktop 返回内容过大，暂时无法读取，请稍后在 Pi Desktop 查看。", "result_too_large");
}

function toolError(): DesktopConnectionError {
  return new DesktopConnectionError("Pi Desktop 工具执行失败，请检查会话状态后重试。", "tool_error");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statIdentity(path: string, info: Stats): FileIdentity {
  return {
    path,
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    uid: info.uid,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.uid === right.uid && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameDirectoryChain(left: readonly FileIdentity[], right: readonly FileIdentity[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return other !== undefined && entry.path === other.path && entry.dev === other.dev &&
      entry.ino === other.ino && entry.mode === other.mode && entry.uid === other.uid;
  });
}

async function inspectDirectoryChain(path: string): Promise<FileIdentity[]> {
  const absolute = resolve(path);
  const chain: FileIdentity[] = [];
  let current: string = sep;
  const rootInfo = await lstat(current);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o022) !== 0) throw connectionError();
  chain.push(statIdentity(current, rootInfo));
  for (const component of absolute.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0) throw connectionError();
    chain.push(statIdentity(current, info));
  }
  return chain;
}

async function loadConnectionFile(path: string): Promise<DesktopConnection> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 || info.size >= MAX_CONNECTION_FILE_BYTES) throw connectionError();

    const parent = dirname(path);
    const directoryHandle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const directory = await directoryHandle.stat();
      if (!directory.isDirectory() || (directory.mode & 0o022) !== 0) throw connectionError();
      const chain = await inspectDirectoryChain(parent);
      const directoryIdentity = statIdentity(parent, directory);
      const last = chain.at(-1);
      if (!last || last.dev !== directoryIdentity.dev || last.ino !== directoryIdentity.ino) throw connectionError();

      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const initial = statIdentity(path, await handle.stat());
      if (!sameIdentity(statIdentity(path, info), initial)) throw connectionError();
      const bytes = Buffer.alloc(MAX_CONNECTION_FILE_BYTES);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const content = bytes.subarray(0, bytesRead).toString("utf8");
      const current = statIdentity(path, await handle.stat());
      const named = statIdentity(path, await lstat(path));
      const currentDirectory = statIdentity(parent, await directoryHandle.stat());
      const currentChain = await inspectDirectoryChain(parent);
      const chainUnchanged = chain.length === currentChain.length && chain.every((entry, index) => {
        const next = currentChain[index];
        return next !== undefined && entry.path === next.path && entry.dev === next.dev &&
          entry.ino === next.ino && entry.mode === next.mode && entry.uid === next.uid;
      });
      if (bytesRead >= MAX_CONNECTION_FILE_BYTES || !sameIdentity(initial, current) || !sameIdentity(initial, named) ||
        !sameIdentity(directoryIdentity, currentDirectory) || !chainUnchanged) throw connectionError();
      await handle.close();
      handle = undefined;
      const parsed = parseConnectionConfig(content);
      const fingerprintChain = chain.map(({ path: directoryPath, dev, ino, mode, uid }) => ({
        path: directoryPath, dev, ino, mode, uid,
      }));
      const fingerprint = createHash("sha256").update(JSON.stringify({ file: initial, chain: fingerprintChain, content })).digest("hex");
      return { fingerprint, port: parsed.port, token: parsed.token };
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof DesktopConnectionError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw connectionError();
  }
}

function parseConnectionConfig(contents: string): { port: number; token: string } {
  let config: unknown;
  try {
    config = JSON.parse(contents);
  } catch {
    throw connectionError();
  }
  if (!isRecord(config) || config.active !== true || typeof config.url !== "string" ||
    typeof config.token !== "string" || config.token.length === 0 || config.token.length > 8192 ||
    !/^[\x21-\x7e]+$/.test(config.token) || typeof config.pid !== "number" ||
    !Number.isSafeInteger(config.pid) || config.pid < 1) throw connectionError();

  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw connectionError();
  }
  const port = Number(url.port);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
    !Number.isInteger(port) || port < 1 || port > 65_535 || url.pathname !== "/mcp" ||
    url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw connectionError();

  try {
    process.kill(config.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw connectionError();
  }
  return { port, token: config.token };
}
async function loadConnection(paths: readonly string[]): Promise<DesktopConnection> {
  for (const path of paths) {
    try {
      return await loadConnectionFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (error instanceof DesktopConnectionError && error.code === "not_connected") continue;
      throw connectionError();
    }
  }
  throw connectionError();
}

function requestHttp(
  connection: DesktopConnection,
  method: "POST" | "DELETE",
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<HttpResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timedOut = false;
    let responseBytes = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, result?: HttpResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(result!);
    };
    let request: ReturnType<typeof httpRequest>;
    const timer = setTimeout(() => {
      timedOut = true;
      finish(new RequestFailure("timeout"));
      request.destroy();
    }, timeoutMs);

    try {
      request = httpRequest({
        hostname: "127.0.0.1",
        port: connection.port,
        path: "/mcp",
        method,
        headers,
      }, response => {
        const contentLength = Number(response.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
          finish(new RequestFailure("too_large"));
          response.destroy();
          request.destroy();
          return;
        }
        response.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseBytes += bytes.length;
          if (responseBytes > maxResponseBytes) {
            finish(new RequestFailure("too_large"));
            response.destroy();
            request.destroy();
            return;
          }
          chunks.push(bytes);
        });
        response.on("end", () => finish(undefined, {
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }));
        response.on("aborted", () => finish(new RequestFailure("network")));
        response.on("error", () => finish(new RequestFailure("network")));
      });
      request.on("error", () => finish(new RequestFailure(timedOut ? "timeout" : "network")));
      request.end(body);
    } catch {
      finish(new RequestFailure("network"));
    }
  });
}

function headersFor(connection: DesktopConnection, session?: McpSession): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: ACCEPT_HEADER,
    Authorization: `Bearer ${connection.token}`,
  };
  if (session) {
    headers["MCP-Protocol-Version"] = session.protocolVersion;
    headers["Mcp-Session-Id"] = session.id;
  }
  return headers;
}

function parseJsonRpcResponse(body: Buffer, contentType: string | undefined, expectedId: string): RpcResponse {
  let candidates: unknown[];
  const mimeType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  try {
    if (mimeType === "application/json") {
      candidates = [JSON.parse(body.toString("utf8")) as unknown];
    } else if (mimeType === "text/event-stream") {
      const events: unknown[] = [];
      let data: string[] = [];
      const flush = (): void => {
        if (data.length === 0) return;
        events.push(JSON.parse(data.join("\n")) as unknown);
        data = [];
      };
      for (const line of body.toString("utf8").split(/\r\n|\n|\r/)) {
        if (line.length === 0) {
          flush();
          continue;
        }
        if (line.startsWith(":")) continue;
        const separator = line.indexOf(":");
        const field = separator < 0 ? line : line.slice(0, separator);
        if (field !== "data") continue;
        let value = separator < 0 ? "" : line.slice(separator + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        data.push(value);
      }
      flush();
      candidates = events;
    } else {
      throw protocolError();
    }
  } catch (error) {
    if (error instanceof DesktopConnectionError) throw error;
    throw protocolError();
  }

  const response = candidates.find(value => isRecord(value) && value.id === expectedId);
  if (!isRecord(response) || response.jsonrpc !== "2.0" || response.id !== expectedId ||
    (Object.hasOwn(response, "result") === Object.hasOwn(response, "error"))) throw protocolError();
  return response as unknown as RpcResponse;
}

function toolFailureCode(value: unknown): "result_too_large" | "tool_error" | undefined {
  if (!isRecord(value)) return undefined;
  if (value.truncated === true && value.reason === "MCP_RESULT_LIMIT") return "result_too_large";
  if (typeof value.operation === "string" && isRecord(value.result) &&
    value.result.truncated === true && value.result.reason === "MCP_RESULT_LIMIT") return "result_too_large";
  if (value.ok === false) return "tool_error";
  return typeof value.operation === "string" && isRecord(value.result) && value.result.ok === false
    ? "tool_error" : undefined;
}

export class DesktopMcpClient implements DesktopMcpClient {
  readonly #connectionFiles: readonly string[];
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  #connection: DesktopConnection | undefined;
  #session: McpSession | undefined;
  #initializing: { connection: DesktopConnection; promise: Promise<McpSession> } | undefined;
  #nextId = 0;
  #generation = 0;
  #closed = false;

  constructor(options: DesktopMcpClientOptions = {}) {
    this.#connectionFiles = options.connectionFiles ?? CONNECTION_FILE_NAMES.map(path => join(homedir(), path));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 ||
      !Number.isSafeInteger(this.#maxResponseBytes) || this.#maxResponseBytes < 1) {
      throw new RangeError("timeoutMs and maxResponseBytes must be positive safe integers");
    }
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#closed) throw new DesktopConnectionError("Pi Desktop MCP 客户端已关闭。", "closed");
    if (typeof tool !== "string" || tool.trim().length === 0 || !isRecord(args)) {
      throw new DesktopConnectionError("Pi Desktop 工具名称或参数无效。", "invalid_arguments");
    }

    let argumentsJson: string;
    try {
      argumentsJson = JSON.stringify(args);
      if (argumentsJson === undefined) throw new Error();
    } catch {
      throw new DesktopConnectionError("Pi Desktop 工具参数无法编码为 JSON。", "invalid_arguments");
    }

    const connection = await this.#getCurrentConnection();
    const session = await this.#ensureSession(connection);
    const current = await this.#getCurrentConnection();
    if (current.fingerprint !== connection.fingerprint || this.#session?.id !== session.id) {
      throw connectionError();
    }

    const id = this.#nextRequestId();
    const body = `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":"tools/call","params":{"name":${JSON.stringify(tool)},"arguments":${argumentsJson}}}`;
    const exchange = await this.#exchange(connection, body, session, "tool");
    const envelope = exchange.response.result;
    if (toolFailureCode(envelope) === "result_too_large") throw resultTooLarge();
    if (!isRecord(envelope) || !Object.hasOwn(envelope, "structuredContent") ||
      !Array.isArray(envelope.content) || (envelope.isError !== undefined && typeof envelope.isError !== "boolean")) {
      throw uncertainResult();
    }
    const failure = toolFailureCode(envelope.structuredContent);
    if (failure === "result_too_large") throw resultTooLarge();
    if (envelope.isError === true || failure === "tool_error") throw toolError();
    return envelope.structuredContent;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation++;
    const session = this.#session;
    this.#session = undefined;
    const initializing = this.#initializing?.promise;

    if (initializing) await initializing.catch(() => undefined);
    if (!session) {
      this.#connection = undefined;
      return;
    }
    let current: DesktopConnection;
    try {
      current = await loadConnection(this.#connectionFiles);
    } catch {
      this.#connection = undefined;
      return;
    }
    if (current.fingerprint !== session.connection.fingerprint) {
      this.#connection = undefined;
      return;
    }
    try {
      const result = await requestHttp(current, "DELETE", headersFor(current, session), undefined,
        this.#timeoutMs, this.#maxResponseBytes);
      if (result.status !== 200 && result.status !== 202 && result.status !== 204 && result.status !== 404) {
        throw new DesktopConnectionError("无法关闭 Pi Desktop MCP 会话。", "close_failed");
      }
    } catch {
      throw new DesktopConnectionError("无法关闭 Pi Desktop MCP 会话。", "close_failed");
    } finally {
      this.#connection = undefined;
    }
  }

  async #getCurrentConnection(): Promise<DesktopConnection> {
    if (this.#closed) throw new DesktopConnectionError("Pi Desktop MCP 客户端已关闭。", "closed");
    let current: DesktopConnection;
    try {
      current = await loadConnection(this.#connectionFiles);
    } catch (error) {
      if (this.#connection !== undefined || this.#session !== undefined || this.#initializing !== undefined) {
        this.#generation++;
        this.#connection = undefined;
        this.#session = undefined;
      }
      throw error instanceof DesktopConnectionError ? error : connectionError();
    }
    if (this.#connection && this.#connection.fingerprint !== current.fingerprint) {
      this.#generation++;
      this.#session = undefined;
    }
    this.#connection = current;
    return current;
  }

  #nextRequestId(): string {
    this.#nextId++;
    return `pi-remote-${this.#nextId}`;
  }

  async #ensureSession(connection: DesktopConnection): Promise<McpSession> {
    if (this.#session?.connection.fingerprint === connection.fingerprint) return this.#session;
    if (this.#initializing?.connection.fingerprint === connection.fingerprint) return this.#initializing.promise;

    const generation = this.#generation;
    const promise = this.#initializeSession(connection, generation);
    this.#initializing = { connection, promise };
    try {
      return await promise;
    } finally {
      if (this.#initializing?.promise === promise) this.#initializing = undefined;
    }
  }

  async #initializeSession(connection: DesktopConnection, generation: number): Promise<McpSession> {
    let sessionId: string | undefined;
    let protocolVersion: "2025-06-18" | "2025-03-26" = INITIALIZE_PROTOCOL_VERSION;
    let committed = false;
    try {
      const id = this.#nextRequestId();
      const initializeExchange = await this.#exchange(connection, JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: INITIALIZE_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "pi-remote", version: "0.1.0" },
        },
      }), undefined, "initialize");
      const initialize = initializeExchange.response;
      if (!isRecord(initialize.result) ||
        (initialize.result.protocolVersion !== "2025-06-18" && initialize.result.protocolVersion !== "2025-03-26") ||
        !isRecord(initialize.result.serverInfo) || initialize.result.serverInfo.name !== "pi-desktop") {
        throw protocolError();
      }
      const header = initializeExchange.headers["mcp-session-id"];
      if (typeof header !== "string" || header.trim().length === 0 || /[\r\n]/.test(header)) throw protocolError();
      sessionId = header;
      protocolVersion = initialize.result.protocolVersion;
      const session: McpSession = {
        connection,
        id: sessionId,
        protocolVersion,
      };

      await this.#assertCurrentConnection(connection, generation);
      await this.#sendNotification(session, generation);
      await this.#assertCurrentConnection(connection, generation);
      this.#session = session;
      committed = true;
      return session;
    } finally {
      if (sessionId && !committed) {
        await this.#deleteSessionBestEffort(connection, sessionId, protocolVersion);
      }
    }
  }

  async #assertCurrentConnection(connection: DesktopConnection, generation: number): Promise<void> {
    const current = await this.#getCurrentConnection();
    if (generation !== this.#generation || current.fingerprint !== connection.fingerprint || this.#closed) {
      throw connectionError();
    }
  }

  async #sendNotification(session: McpSession, generation: number): Promise<void> {
    const body = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    const result = await this.#send(session.connection, "POST", headersFor(session.connection, session), body, "initialize");
    if (result.status === 404) throw new DesktopConnectionError("Pi Desktop MCP 会话已失效，请重新发送操作。", "session_expired");
    if (result.status !== 202) throw protocolError();
    if (generation !== this.#generation || this.#closed) throw connectionError();
  }

  async #exchange(
    connection: DesktopConnection,
    body: string,
    session: McpSession | undefined,
    phase: "initialize" | "tool",
  ): Promise<RpcExchange> {
    const id = JSON.parse(body) as { id: string };
    const headers = headersFor(connection, session);
    headers["Content-Type"] = "application/json";
    const result = await this.#send(connection, "POST", headers, body, phase);
    if (result.status === 404 && session) {
      if (this.#session?.id === session.id) this.#session = undefined;
      throw new DesktopConnectionError("Pi Desktop MCP 会话已失效，本次操作未自动重放；请重新发送。", "session_expired");
    }
    if (result.status >= 300 && result.status < 400) {
      throw phase === "tool" ? uncertainResult() : connectionError();
    }
    if (result.status >= 500) throw phase === "tool" ? uncertainResult() : connectionError();
    if (result.status !== 200) {
      throw phase === "tool"
        ? new DesktopConnectionError(`Pi Desktop MCP 拒绝了操作（HTTP ${result.status}）。`, "tool_error")
        : protocolError();
    }

    let response: RpcResponse;
    try {
      response = parseJsonRpcResponse(result.body, result.headers["content-type"], id.id);
    } catch {
      throw phase === "tool" ? uncertainResult() : protocolError();
    }
    if (Object.hasOwn(response, "error")) {
      throw phase === "tool" ? toolError() : protocolError();
    }
    return { response, headers: result.headers };
  }

  async #send(
    connection: DesktopConnection,
    method: "POST" | "DELETE",
    headers: Record<string, string>,
    body: string | undefined,
    phase: "initialize" | "tool",
  ): Promise<HttpResult> {
    try {
      return await requestHttp(connection, method, headers, body, this.#timeoutMs, this.#maxResponseBytes);
    } catch (error) {
      if (phase === "tool") throw uncertainResult();
      if (error instanceof RequestFailure && error.kind === "too_large") throw protocolError();
      throw connectionError();
    }
  }

  async #deleteSessionBestEffort(
    connection: DesktopConnection,
    id: string,
    protocolVersion: "2025-06-18" | "2025-03-26",
  ): Promise<void> {
    let current: DesktopConnection;
    try {
      current = await loadConnection(this.#connectionFiles);
    } catch {
      return;
    }
    if (current.fingerprint !== connection.fingerprint) return;
    const session: McpSession = { connection: current, id, protocolVersion };
    await requestHttp(current, "DELETE", headersFor(current, session), undefined,
      this.#timeoutMs, this.#maxResponseBytes).catch(() => undefined);
  }
}
