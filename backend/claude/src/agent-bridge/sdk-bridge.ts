import { query, type CanUseTool, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export type QueryFactory = typeof query;

export interface StartQueryOptions {
  cwd: string;
  prompt: string;
  canUseTool: CanUseTool;
  resume?: string;
  /** Explicit model override for this turn. Omit to use the CLI/settings default. */
  model?: string;
  /** Explicit session id for a new session. Mutually exclusive with resume. */
  sessionId?: string;
  /** 权限模式覆盖；省略时由 SDK 走 "default"。 */
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  signal: AbortSignal;
}

class InputStream implements AsyncIterable<SDKUserMessage> {
  readonly #pending: SDKUserMessage[] = [];
  readonly #waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  #closed = false;

  push(message: SDKUserMessage): void {
    if (this.#closed) throw new Error("query input is closed");
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: message });
    else this.#pending.push(message);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async () => {
        const value = this.#pending.shift();
        if (value) return { done: false as const, value };
        if (this.#closed) return { done: true as const, value: undefined };
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

export interface SdkQueryHandle {
  readonly messages: AsyncIterable<SDKMessage>;
  steer(prompt: string): Promise<void>;
  interrupt(): Promise<void>;
  close(): void;
}

export function startSdkQuery(options: StartQueryOptions, queryFactory: QueryFactory = query): SdkQueryHandle {
  if (options.resume !== undefined && options.sessionId !== undefined) {
    throw new TypeError("resume and sessionId are mutually exclusive");
  }
  const input = new InputStream();
  input.push(userMessage(options.prompt));
  const sdkOptions = {
    cwd: options.cwd,
    canUseTool: options.canUseTool,
    permissionMode: (options.permissionMode ?? "default") as "default" | "acceptEdits" | "plan" | "bypassPermissions",
    includePartialMessages: true,
    persistSession: true,
    // SDK options.env replaces the subprocess env entirely, so we must spread
    // process.env ourselves. Overriding CLAUDE_CODE_ENTRYPOINT to "claude-remote"
    // keeps the session visible in the Mac terminal's /resume list (CLI hides
    // sessions whose entrypoint ∈ {sdk-cli, sdk-ts, sdk-py}).
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "claude-remote" } as Record<string, string>,
    // CLAUDE_BIN：GUI 壳 app 的子进程没有 shell PATH，由壳注入显式 claude 路径（docs/mac-app-plan.md §2.2）
    ...(process.env.CLAUDE_BIN ? { pathToClaudeCodeExecutable: process.env.CLAUDE_BIN } : {}),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.model === undefined ? {} : { model: options.model }),
  };
  const sdkQuery: Query = queryFactory({ prompt: input, options: sdkOptions });
  const abort = (): void => { void sdkQuery.interrupt().catch(() => undefined); };
  if (options.signal.aborted) abort();
  else options.signal.addEventListener("abort", abort, { once: true });
  return {
    messages: sdkQuery,
    async steer(prompt: string): Promise<void> { input.push(userMessage(prompt)); },
    async interrupt(): Promise<void> { await sdkQuery.interrupt(); },
    close(): void {
      input.close();
      options.signal.removeEventListener("abort", abort);
      sdkQuery.close();
    },
  };
}

function userMessage(prompt: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
  };
}
