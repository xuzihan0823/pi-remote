import { RpcClient, type RpcClientOptions, type RpcCommandInput, type RpcSpawnFn } from "./rpc-client.ts";
import type { GatewayEvent, SessionId } from "../protocol/types.ts";

export type SessionProcessState = "running" | "exited" | "failed";

export interface SessionProcessStatus {
  sessionId: SessionId;
  state: SessionProcessState;
  pid: number | undefined;
  exitCode: number | null;
  signal: string | null;
  error: string | undefined;
  startedAt: number;
}

export interface SessionStartOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  args?: string[];
}

export interface PiProcessManagerOptions extends Omit<RpcClientOptions, "sessionId" | "args" | "cwd" | "env" | "piBin"> {
  piBin: string;
  args?: string[];
  maxSessions?: number;
}

export class SessionAlreadyRunningError extends Error {
  readonly code = "session_already_running";
  readonly sessionId: SessionId;

  constructor(sessionId: SessionId) {
    super(`Session "${sessionId}" already has a running pi process`);
    this.name = "SessionAlreadyRunningError";
    this.sessionId = sessionId;
  }
}

export class SessionNotFoundError extends Error {
  readonly code = "session_not_found";
  readonly sessionId: SessionId;

  constructor(sessionId: SessionId) {
    super(`Session "${sessionId}" has no pi process`);
    this.name = "SessionNotFoundError";
    this.sessionId = sessionId;
  }
}

export class SessionBusyError extends Error {
  readonly code = "session_busy";
  readonly sessionId: SessionId;

  constructor(sessionId: SessionId) {
    super(`Session "${sessionId}" is already streaming; abort or wait before sending another prompt`);
    this.name = "SessionBusyError";
    this.sessionId = sessionId;
  }
}

interface SessionRecord {
  client: RpcClient;
  status: SessionProcessStatus;
  busy: boolean;
  unsubscribe: () => void;
}

export class PiProcessManager {
  readonly #piBin: string;
  readonly #baseArgs: string[];
  readonly #maxSessions: number;
  readonly #clientOptions: Omit<RpcClientOptions, "sessionId" | "args" | "cwd" | "env" | "piBin">;
  readonly #sessions = new Map<SessionId, SessionRecord>();
  readonly #eventListeners = new Set<(event: GatewayEvent) => void>();
  readonly #statusListeners = new Set<(status: SessionProcessStatus) => void>();

  constructor(options: PiProcessManagerOptions) {
    const { piBin, args, maxSessions, ...clientOptions } = options;
    this.#piBin = piBin;
    this.#baseArgs = args ?? [];
    this.#maxSessions = maxSessions ?? 16;
    this.#clientOptions = clientOptions;
  }

  async start(sessionId: SessionId, options: SessionStartOptions = {}): Promise<SessionProcessStatus> {
    if (this.#sessions.has(sessionId)) {
      throw new SessionAlreadyRunningError(sessionId);
    }
    if (this.#sessions.size >= this.#maxSessions) {
      throw new Error(`Cannot start session "${sessionId}": max sessions (${this.#maxSessions}) reached`);
    }

    const client = new RpcClient({
      ...this.#clientOptions,
      sessionId,
      piBin: this.#piBin,
      args: [...this.#baseArgs, ...(options.args ?? [])],
      cwd: options.cwd,
      env: options.env,
    });

    const record: SessionRecord = {
      client,
      busy: false,
      status: {
        sessionId,
        state: "running",
        pid: undefined,
        exitCode: null,
        signal: null,
        error: undefined,
        startedAt: Date.now(),
      },
      unsubscribe: () => {},
    };

    record.unsubscribe = client.onEvent((event) => this.#handleClientEvent(record, event));
    this.#sessions.set(sessionId, record);

    try {
      await client.start();
    } catch (error) {
      record.unsubscribe();
      this.#sessions.delete(sessionId);
      record.status.state = "failed";
      record.status.error = error instanceof Error ? error.message : String(error);
      this.#notifyStatus(record.status);
      throw error;
    }

    record.status.pid = client.pid;
    this.#notifyStatus(record.status);
    return { ...record.status };
  }

  get(sessionId: SessionId): RpcClient | undefined {
    return this.#sessions.get(sessionId)?.client;
  }

  getStatus(sessionId: SessionId): SessionProcessStatus | undefined {
    const record = this.#sessions.get(sessionId);
    return record ? { ...record.status } : undefined;
  }

  list(): SessionProcessStatus[] {
    return [...this.#sessions.values()].map((record) => ({ ...record.status }));
  }

  isBusy(sessionId: SessionId): boolean {
    return this.#require(sessionId).busy;
  }

  async send<T = unknown>(sessionId: SessionId, command: RpcCommandInput): Promise<T> {
    return this.#require(sessionId).client.send<T>(command);
  }

  async prompt(sessionId: SessionId, message: string, options: { images?: unknown[] } = {}): Promise<void> {
    const record = this.#require(sessionId);
    if (record.busy) {
      throw new SessionBusyError(sessionId);
    }
    record.busy = true;
    try {
      await record.client.send({ type: "prompt", message, ...(options.images ? { images: options.images } : {}) });
    } catch (error) {
      record.busy = false;
      throw error;
    }
  }

  async abort(sessionId: SessionId): Promise<void> {
    await this.#require(sessionId).client.abort();
  }

  async close(sessionId: SessionId): Promise<void> {
    const record = this.#sessions.get(sessionId);
    if (!record) return;
    this.#sessions.delete(sessionId);
    record.unsubscribe();
    await record.client.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((sessionId) => this.close(sessionId)));
  }

  onEvent(listener: (event: GatewayEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  }

  onStatusChange(listener: (status: SessionProcessStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => {
      this.#statusListeners.delete(listener);
    };
  }

  #require(sessionId: SessionId): SessionRecord {
    const record = this.#sessions.get(sessionId);
    if (!record) throw new SessionNotFoundError(sessionId);
    if (!record.client.isRunning()) {
      throw new Error(`Session "${sessionId}" pi process is not running: ${record.status.error ?? "process exited"}`);
    }
    return record;
  }

  #handleClientEvent(record: SessionRecord, event: GatewayEvent): void {
    if (event.type === "agent_settled") {
      record.busy = false;
    } else if (event.type === "process_exit") {
      record.busy = false;
      record.status.exitCode = event.code;
      record.status.signal = event.signal;
      record.status.state = event.expected || (event.code === 0 && event.signal === null) ? "exited" : "failed";
      if (record.status.state === "failed") {
        record.status.error = `pi process exited (code=${event.code ?? "null"} signal=${event.signal ?? "null"})`;
      }
      this.#notifyStatus(record.status);
    } else if (event.type === "process_error") {
      record.busy = false;
      record.status.state = "failed";
      record.status.error = event.message;
      this.#notifyStatus(record.status);
    }

    for (const listener of this.#eventListeners) {
      listener(event);
    }
  }

  #notifyStatus(status: SessionProcessStatus): void {
    for (const listener of this.#statusListeners) {
      listener({ ...status });
    }
  }
}

export type { RpcSpawnFn };
