import { pathToFileURL } from "node:url";
import { describeConfig, loadDesktopAgentConfig } from "../config.ts";
import type { PiProcessManager } from "../pi/process-manager.ts";
import { AgentClient } from "./agent-client.ts";
import { createDesktopAgentHandler } from "./desktop-agent-handler.ts";
import { DesktopMcpClient } from "../desktop/mcp-client.ts";

export interface AgentRuntimeOptions {
  client: AgentClient;
  manager?: Pick<PiProcessManager, "closeAll">;
  cleanup?: () => void | Promise<void>;
  logger?: (message: string) => void;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
}

export function computeBackoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(baseMs * 2 ** safeAttempt, maxMs);
}

/**
 * Keeps an AgentClient connected. A dropped or failed socket triggers an exponential-backoff
 * reconnect until `stop()` is called; no session is started on its own.
 */
export class AgentRuntime {
  readonly #client: AgentClient;
  readonly #cleanup: () => void | Promise<void>;
  readonly #logger: (message: string) => void;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;

  #running = false;
  #attempt = 0;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #unsubscribe: () => void = () => {};

  constructor(options: AgentRuntimeOptions) {
    this.#client = options.client;
    this.#cleanup = options.cleanup ?? (() => options.manager?.closeAll());
    this.#logger = options.logger ?? (() => {});
    this.#baseDelayMs = options.reconnectBaseDelayMs ?? 1_000;
    this.#maxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#unsubscribe = this.#client.onStateChange((state) => {
      if (state === "closed" && this.#running) this.#scheduleReconnect();
    });
    await this.#tryConnect();
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#unsubscribe();
    this.#client.disconnect();
    try {
      await this.#cleanup();
    } catch (error) {
      this.#logger(`error closing sessions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #tryConnect(): Promise<void> {
    try {
      await this.#client.connect();
      this.#attempt = 0;
      if (!this.#running) {
        this.#client.disconnect();
        return;
      }
      this.#logger(`agent connected as "${this.#client.deviceId}"`);
    } catch (error) {
      this.#logger(`agent connection failed: ${error instanceof Error ? error.message : String(error)}`);
      if (this.#running) this.#scheduleReconnect();
    }
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer || !this.#running) return;
    const delayMs = computeBackoffDelay(this.#attempt, this.#baseDelayMs, this.#maxDelayMs);
    this.#attempt += 1;
    this.#logger(`reconnecting in ${delayMs}ms (attempt ${this.#attempt})`);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (!this.#running) return;
      void this.#tryConnect();
    }, delayMs);
  }
}

export async function main(): Promise<void> {
  const config = loadDesktopAgentConfig();
  const logger = (message: string): void => console.log(`[pi-agent] ${message}`);
  logger(describeConfig(config));
  const desktop = new DesktopMcpClient();
  const client = new AgentClient({
    url: config.relayUrl,
    token: config.agentToken,
    deviceId: config.agentDeviceId,
    handler: createDesktopAgentHandler({ client: desktop, workspaceRoot: config.piWorkspaceRoot }),
    logger,
  });
  const runtime = new AgentRuntime({ client, cleanup: () => desktop.close(), logger });
  logger("session scope: Pi Desktop only; CLI and OMP discovery disabled");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger(`received ${signal}, shutting down`);
    try {
      await runtime.stop();
    } catch (error) {
      logger(`error during shutdown: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  };

  // Registered before the first connect attempt so a signal arriving during a slow handshake
  // still tears the runtime down instead of skipping cleanup.
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await runtime.start();
}

export function isMainModule(meta: ImportMeta, argv: string[] = process.argv): boolean {
  const entry = argv[1];
  return entry !== undefined && meta.url === pathToFileURL(entry).href;
}

if (isMainModule(import.meta)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
