import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

export interface FakeTerminalOptions {
  dir: string;
  sessionId: string;
  cwd: string;
  title?: string;
  activity?: "busy" | "idle";
  messages?: { role: "user" | "assistant"; text: string }[];
  truncated?: boolean;
  /** When set, every op answers with this error code. */
  errorCode?: string;
  /** When set, only `prompt` answers with this error code. */
  errorOnPrompt?: string;
  /** When true, connections are accepted but never answered. */
  hang?: boolean;
}

export interface RecordedCall {
  op: string;
  sessionId?: string;
  message?: string;
}

/** Minimal stand-in for the bridge extension's unix-socket server. */
export class FakeTerminalInstance {
  readonly calls: RecordedCall[] = [];
  readonly socketPath: string;
  readonly #options: FakeTerminalOptions;
  #server: Server | null = null;

  private constructor(options: FakeTerminalOptions) {
    this.#options = options;
    this.socketPath = join(options.dir, `b-${randomBytes(8).toString("hex")}.sock`);
  }

  static async start(options: FakeTerminalOptions): Promise<FakeTerminalInstance> {
    const instance = new FakeTerminalInstance(options);
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    const server = createServer((socket) => instance.#handle(socket));
    instance.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(instance.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      chmodSync(instance.socketPath, 0o600);
    } catch {
      // permissions are best-effort in the fixture
    }
    return instance;
  }

  get listening(): boolean {
    return this.#server?.listening ?? false;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try {
      unlinkSync(this.socketPath);
    } catch {
      // already gone
    }
  }

  #handle(socket: Socket): void {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        this.#respond(socket, line);
        newline = buffer.indexOf("\n");
      }
    });
  }

  #respond(socket: Socket, line: string): void {
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const op = typeof request.op === "string" ? request.op : "unknown";
    const call: RecordedCall = { op };
    if (typeof request.sessionId === "string") call.sessionId = request.sessionId;
    if (typeof request.message === "string") call.message = request.message;
    this.calls.push(call);

    if (this.#options.hang) return;
    const id = typeof request.id === "string" ? request.id : null;
    const write = (body: unknown): void => {
      if (socket.destroyed || !socket.writable) return;
      socket.write(`${JSON.stringify(body)}\n`);
    };

    if (this.#options.errorCode) {
      write({ id, ok: false, error: { code: this.#options.errorCode, message: "fixture error" } });
      return;
    }
    if (op === "prompt" && this.#options.errorOnPrompt) {
      write({ id, ok: false, error: { code: this.#options.errorOnPrompt, message: "fixture prompt error" } });
      return;
    }

    const activity = this.#options.activity ?? "idle";
    const meta = {
      sessionId: this.#options.sessionId,
      cwd: this.#options.cwd,
      title: this.#options.title ?? this.#options.sessionId,
      activity,
    };
    switch (op) {
      case "list":
        write({ id, ok: true, data: { sessions: [meta] } });
        return;
      case "get":
        write({ id, ok: true, data: meta });
        return;
      case "snapshot":
        write({
          id,
          ok: true,
          data: {
            sessionId: this.#options.sessionId,
            activity,
            messages: this.#options.messages ?? [],
            truncated: this.#options.truncated ?? false,
          },
        });
        return;
      case "prompt":
        write({ id, ok: true, data: { sessionId: this.#options.sessionId, queued: true } });
        return;
      case "abort":
        write({ id, ok: true, data: { sessionId: this.#options.sessionId, aborted: true } });
        return;
      default:
        write({ id, ok: false, error: { code: "unsupported_op", message: `unsupported op ${op}` } });
    }
  }
}
