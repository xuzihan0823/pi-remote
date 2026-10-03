import { spawn, type SpawnOptions } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { GatewayEvent, SessionId, UiDialogResponse } from "../protocol/types.ts";

export interface WritableLike {
  write(chunk: string): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  readonly destroyed?: boolean;
  readonly writable?: boolean;
}

export interface ReadableLike {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "end", listener: () => void): unknown;
}

export interface RpcChildProcess {
  readonly stdin: WritableLike | null;
  readonly stdout: ReadableLike | null;
  readonly stderr: ReadableLike | null;
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type RpcSpawnFn = (command: string, args: string[], options: SpawnOptions) => RpcChildProcess;

export interface RpcCommandInput {
  type: string;
  [key: string]: unknown;
}

export interface RpcClientOptions {
  sessionId: SessionId;
  piBin: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  startupDelayMs?: number;
  maxStderrChars?: number;
  maxLineChars?: number;
  spawnFn?: RpcSpawnFn;
  logger?: (message: string) => void;
}

export class RpcCommandError extends Error {
  readonly code = "rpc_command_failed";
  readonly command: string;

  constructor(command: string, rpcError: string) {
    super(`pi RPC command "${command}" failed: ${rpcError}`);
    this.name = "RpcCommandError";
    this.command = command;
  }
}

export class RpcTimeoutError extends Error {
  readonly code = "rpc_timeout";
  readonly command: string;

  constructor(command: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for pi RPC response to "${command}"`);
    this.name = "RpcTimeoutError";
    this.command = command;
  }
}

export class RpcProcessError extends Error {
  readonly code = "rpc_process_error";

  constructor(message: string) {
    super(message);
    this.name = "RpcProcessError";
  }
}

interface PendingRequest {
  command: string;
  timer: NodeJS.Timeout;
  resolve: (response: RpcResponsePayload) => void;
  reject: (error: Error) => void;
}

interface RpcResponsePayload {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

const DIALOG_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * LF-only JSONL reader. Node readline also splits on U+2028/U+2029, which are valid
 * inside JSON strings, so pi's RPC framing must not use it.
 */
export function attachJsonlLineReader(stream: ReadableLike, onLine: (line: string) => void): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const emit = (line: string): void => {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };

  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      emit(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
    }
  };

  const onEnd = (): void => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      emit(buffer);
      buffer = "";
    }
  };

  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

const defaultSpawn: RpcSpawnFn = (command, args, options) =>
  spawn(command, args, options) as unknown as RpcChildProcess;

export class RpcClient {
  readonly sessionId: SessionId;
  readonly #piBin: string;
  readonly #args: string[];
  readonly #cwd: string | undefined;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #timeoutMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #startupDelayMs: number;
  readonly #maxStderrChars: number;
  readonly #maxLineChars: number;
  readonly #spawnFn: RpcSpawnFn;
  readonly #logger: (message: string) => void;

  #child: RpcChildProcess | null = null;
  #stdin: WritableLike | null = null;
  #detachStdout: (() => void) | null = null;
  #listeners = new Set<(event: GatewayEvent) => void>();
  #pending = new Map<string, PendingRequest>();
  #requestCounter = 0;
  #stderr = "";
  #exited = false;
  #expectedExit = false;
  #exitError: Error | null = null;
  #pid: number | undefined;

  constructor(options: RpcClientOptions) {
    this.sessionId = options.sessionId;
    this.#piBin = options.piBin;
    this.#args = options.args ?? [];
    this.#cwd = options.cwd;
    this.#env = options.env;
    this.#timeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_000;
    this.#startupDelayMs = options.startupDelayMs ?? 100;
    this.#maxStderrChars = options.maxStderrChars ?? 256 * 1024;
    this.#maxLineChars = options.maxLineChars ?? 16 * 1024 * 1024;
    this.#spawnFn = options.spawnFn ?? defaultSpawn;
    this.#logger = options.logger ?? (() => {});
  }

  get pid(): number | undefined {
    return this.#pid;
  }

  isRunning(): boolean {
    return this.#child !== null && !this.#exited;
  }

  getStderr(): string {
    return this.#stderr;
  }

  onEvent(listener: (event: GatewayEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.#child) {
      throw new RpcProcessError(`pi RPC client for session "${this.sessionId}" already started`);
    }

    const child = this.#spawnFn(this.#piBin, ["--mode", "rpc", ...this.#args], {
      cwd: this.#cwd,
      env: this.#env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    this.#stdin = child.stdin;
    this.#pid = child.pid;

    child.stderr?.on("data", (chunk) => this.#handleStderr(chunk));
    child.on("exit", (code, signal) => this.#handleExit(code, signal));
    child.on("error", (error) => this.#handleProcessError(error));
    child.stdin?.on("error", (error) => this.#handleProcessError(error));

    if (!child.stdout) {
      throw new RpcProcessError(`pi RPC process for session "${this.sessionId}" has no stdout`);
    }
    this.#detachStdout = attachJsonlLineReader(child.stdout, (line) => this.#handleLine(line));

    await new Promise((resolve) => setTimeout(resolve, this.#startupDelayMs));
    if (this.#exitError) throw this.#exitError;
    if (child.exitCode !== null) {
      const error = this.#createExitError(child.exitCode, child.signalCode);
      this.#exitError = error;
      throw error;
    }
  }

  async send<T = unknown>(command: RpcCommandInput): Promise<T> {
    const stdin = this.#stdin;
    if (!this.#child || !stdin || this.#exited) {
      throw this.#exitError ?? new RpcProcessError(`pi RPC client for session "${this.sessionId}" is not running`);
    }

    const id = `req_${++this.#requestCounter}`;
    const payload = { ...command, id };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RpcTimeoutError(command.type, this.#timeoutMs));
      }, this.#timeoutMs);

      this.#pending.set(id, {
        command: command.type,
        timer,
        resolve: (response) => {
          clearTimeout(timer);
          if (response.success) {
            resolve(response.data as T);
          } else {
            reject(new RpcCommandError(response.command, response.error ?? "unknown error"));
          }
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      try {
        stdin.write(serializeJsonLine(payload));
      } catch (error) {
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        pending?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async abort(): Promise<void> {
    await this.send({ type: "abort" });
  }

  respondToUi(requestId: string, response: UiDialogResponse): void {
    const stdin = this.#stdin;
    if (!this.#child || !stdin || this.#exited) {
      throw new RpcProcessError(`pi RPC client for session "${this.sessionId}" is not running`);
    }
    stdin.write(serializeJsonLine({ type: "extension_ui_response", id: requestId, ...response }));
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (!child) return;

    this.#expectedExit = true;
    this.#detachStdout?.();
    this.#detachStdout = null;

    if (!this.#exited) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
        }, this.#shutdownTimeoutMs);
        child.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }

    this.#child = null;
    this.#stdin = null;
    this.#rejectAllPending(this.#exitError ?? new RpcProcessError(`pi RPC client for session "${this.sessionId}" closed`));
  }

  #handleLine(line: string): void {
    if (line.length > this.#maxLineChars) {
      this.#emit({
        type: "protocol_error",
        sessionId: this.sessionId,
        message: `Dropped oversized RPC line (${line.length} chars)`,
        line: undefined,
      });
      return;
    }
    if (line.trim().length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.#emit({
        type: "protocol_error",
        sessionId: this.sessionId,
        message: `Failed to parse RPC line as JSON: ${error instanceof Error ? error.message : String(error)}`,
        line,
      });
      return;
    }

    if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
      this.#emit({
        type: "protocol_error",
        sessionId: this.sessionId,
        message: "RPC payload is not an object with a type field",
        line,
      });
      return;
    }

    const record = parsed as Record<string, unknown>;
    const type = record.type;

    if (type === "response") {
      this.#handleResponse(record as unknown as RpcResponsePayload);
      return;
    }

    if (type === "extension_ui_request") {
      this.#handleUiRequest(record);
      return;
    }

    const event = toGatewayEvent(record, this.sessionId);
    if (event) this.#emit(event);
    if (type === "agent_end" && record.isTerminal === true) {
      this.#emit({ type: "agent_settled", sessionId: this.sessionId });
    }
  }

  #handleResponse(response: RpcResponsePayload): void {
    const id = response.id;
    const pending = id === undefined ? undefined : this.#pending.get(id);
    if (id !== undefined && pending) {
      this.#pending.delete(id);
      pending.resolve(response);
      return;
    }
    this.#emit({
      type: "protocol_error",
      sessionId: this.sessionId,
      message: `Received response for unknown request id ${id ?? "<none>"} (command ${response.command})`,
      line: undefined,
    });
  }

  #handleUiRequest(record: Record<string, unknown>): void {
    const requestId = typeof record.id === "string" ? record.id : "";
    const method = typeof record.method === "string" ? record.method : "unknown";
    const { type: _type, id: _id, method: _method, ...payload } = record;
    this.#emit({
      type: "ui_request",
      sessionId: this.sessionId,
      requestId,
      method,
      expectsResponse: DIALOG_UI_METHODS.has(method),
      payload,
    });
  }

  #handleStderr(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text.length === 0) return;
    this.#stderr = (this.#stderr + text).slice(-this.#maxStderrChars);
    this.#emit({ type: "stderr", sessionId: this.sessionId, text });
  }

  #handleProcessError(error: Error): void {
    if (this.#exited) return;
    const processError = new RpcProcessError(
      `pi RPC process error for session "${this.sessionId}": ${error.message}${this.#stderr ? ` | stderr: ${this.#stderr}` : ""}`,
    );
    this.#exitError = processError;
    this.#emit({ type: "process_error", sessionId: this.sessionId, message: processError.message });
    this.#rejectAllPending(processError);
  }

  #handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exited) return;
    this.#exited = true;
    const error = this.#createExitError(code, signal);
    if (!this.#expectedExit) {
      this.#exitError = error;
    }
    this.#rejectAllPending(error);
    this.#emit({
      type: "process_exit",
      sessionId: this.sessionId,
      code,
      signal,
      expected: this.#expectedExit,
    });
  }

  #createExitError(code: number | null, signal: NodeJS.Signals | null): RpcProcessError {
    const cause = this.#expectedExit ? "was closed" : "exited unexpectedly";
    return new RpcProcessError(
      `pi RPC process for session "${this.sessionId}" ${cause} (code=${code ?? "null"} signal=${signal ?? "null"})${this.#stderr ? ` | stderr: ${this.#stderr}` : ""}`,
    );
  }

  #rejectAllPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #emit(event: GatewayEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#logger(`pi RPC event listener threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

function toGatewayEvent(raw: Record<string, unknown>, sessionId: SessionId): GatewayEvent | null {
  const type = raw.type;

  switch (type) {
    case "agent_start":
      return { type: "agent_start", sessionId };
    case "agent_end":
      return { type: "agent_end", sessionId, willRetry: raw.willRetry === true };
    case "agent_settled":
      return { type: "agent_settled", sessionId };
    case "turn_start":
      return { type: "turn_start", sessionId };
    case "turn_end":
      return { type: "turn_end", sessionId, toolResultCount: asArray(raw.toolResults).length };
    case "message_start":
      return { type: "message_start", sessionId, role: asRole(raw.message) };
    case "message_end":
      return { type: "message_end", sessionId, role: asRole(raw.message) };
    case "message_update":
      return mapMessageUpdate(raw, sessionId);
    case "tool_execution_start":
      return {
        type: "tool_start",
        sessionId,
        toolCallId: asString(raw.toolCallId),
        toolName: asString(raw.toolName),
        args: raw.args,
      };
    case "tool_execution_update":
      return {
        type: "tool_update",
        sessionId,
        toolCallId: asString(raw.toolCallId),
        toolName: asString(raw.toolName),
        text: extractText(asContent(raw.partialResult)),
      };
    case "tool_execution_end":
      return {
        type: "tool_end",
        sessionId,
        toolCallId: asString(raw.toolCallId),
        toolName: asString(raw.toolName),
        isError: raw.isError === true,
        text: extractText(asContent(raw.result)),
      };
    case "bash_execution_update":
      return {
        type: "bash_output",
        sessionId,
        requestId: typeof raw.id === "string" ? raw.id : undefined,
        text: asString(raw.delta),
      };
    case "queue_update":
      return {
        type: "queue_update",
        sessionId,
        steering: asStringArray(raw.steering),
        followUp: asStringArray(raw.followUp),
      };
    case "compaction_start":
      return { type: "compaction_start", sessionId, reason: asString(raw.reason) };
    case "compaction_end":
      return {
        type: "compaction_end",
        sessionId,
        reason: asString(raw.reason),
        aborted: raw.aborted === true,
        willRetry: raw.willRetry === true,
        errorMessage: typeof raw.errorMessage === "string" ? raw.errorMessage : undefined,
      };
    case "auto_retry_start":
      return {
        type: "retry_start",
        sessionId,
        attempt: asNumber(raw.attempt),
        maxAttempts: asNumber(raw.maxAttempts),
        delayMs: asNumber(raw.delayMs),
        errorMessage: asString(raw.errorMessage),
      };
    case "auto_retry_end":
      return {
        type: "retry_end",
        sessionId,
        success: raw.success === true,
        attempt: asNumber(raw.attempt),
        errorMessage: typeof raw.finalError === "string" ? raw.finalError : undefined,
      };
    case "extension_error":
      return {
        type: "extension_error",
        sessionId,
        extensionPath: typeof raw.extensionPath === "string" ? raw.extensionPath : undefined,
        event: typeof raw.event === "string" ? raw.event : undefined,
        error: asString(raw.error),
      };
    case "summarization_retry_scheduled":
      return {
        type: "notice",
        sessionId,
        level: "warning",
        text: `Summarization retry ${asNumber(raw.attempt)}/${asNumber(raw.maxAttempts)} in ${asNumber(raw.delayMs)}ms: ${asString(raw.errorMessage)}`,
      };
    case "summarization_retry_attempt_start":
      return { type: "notice", sessionId, level: "info", text: "Summarization retry attempt started" };
    case "summarization_retry_finished":
      return { type: "notice", sessionId, level: "info", text: "Summarization retry finished" };
    default:
      return typeof type === "string" ? { type: "unknown_event", sessionId, name: type } : null;
  }
}

function mapMessageUpdate(raw: Record<string, unknown>, sessionId: SessionId): GatewayEvent | null {
  const delta = raw.assistantMessageEvent;
  if (typeof delta !== "object" || delta === null) return null;
  const update = delta as Record<string, unknown>;
  const contentIndex = asNumber(update.contentIndex);

  switch (update.type) {
    case "text_start":
      return { type: "text_start", sessionId, contentIndex };
    case "text_delta":
      return { type: "text_delta", sessionId, contentIndex, text: asString(update.delta) };
    case "text_end":
      return { type: "text_end", sessionId, contentIndex, text: asString(update.content) };
    case "thinking_start":
      return { type: "thinking_start", sessionId, contentIndex };
    case "thinking_delta":
      return { type: "thinking_delta", sessionId, contentIndex, text: asString(update.delta) };
    case "thinking_end":
      return { type: "thinking_end", sessionId, contentIndex, text: asString(update.content) };
    case "toolcall_start":
      return {
        type: "tool_call_start",
        sessionId,
        contentIndex,
        toolCallId: asString(update.id),
        toolName: asString(update.toolName),
      };
    case "toolcall_delta":
      return { type: "tool_call_delta", sessionId, contentIndex, text: asString(update.delta) };
    case "toolcall_end": {
      const toolCall = asRecord(update.toolCall);
      return {
        type: "tool_call_end",
        sessionId,
        contentIndex,
        toolCallId: asString(toolCall.id),
        toolName: asString(toolCall.name),
      };
    }
    default:
      return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asRole(message: unknown): string {
  const role = asRecord(message).role;
  return typeof role === "string" ? role : "unknown";
}

function asContent(value: unknown): unknown {
  return asRecord(value).content;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      return record.type === "text" ? asString(record.text) : "";
    })
    .join("");
}
