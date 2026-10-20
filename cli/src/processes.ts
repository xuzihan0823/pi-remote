import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

export function lines(onLine: (line: string) => void): { write(chunk: Buffer): void; end(): void } {
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  const flush = (): void => {
    for (;;) {
      const index = buffered.indexOf("\n");
      if (index < 0) break;
      onLine(buffered.slice(0, index).replace(/\r$/, ""));
      buffered = buffered.slice(index + 1);
    }
    if (buffered.length > 64 * 1024) { onLine(buffered.slice(0, 64 * 1024)); buffered = ""; }
  };
  return {
    write(chunk) { buffered += decoder.write(chunk); flush(); },
    end() { buffered += decoder.end(); flush(); if (buffered) onLine(buffered); buffered = ""; },
  };
}

export interface Job {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  tag: string;
  killGraceMs?: number;
}
export class ProcessGroup {
  readonly controller = new AbortController();
  readonly #children: { process: ChildProcessWithoutNullStreams; done: Promise<void> }[] = [];
  readonly #supervisor: string;
  #stopping: Promise<void> | undefined;
  failure: Error | undefined;

  constructor(supervisor = fileURLToPath(new URL("./runtime-supervisor.mjs", import.meta.url))) { this.#supervisor = supervisor; }
  get signal(): AbortSignal { return this.controller.signal; }
  fail(error: Error): void { if (!this.failure) this.failure = error; this.controller.abort(error); }
  cancel(): void { this.controller.abort(); }

  start(job: Job, onLine: (line: string) => void): void {
    this.signal.throwIfAborted();
    const child = spawn(process.execPath, [this.#supervisor], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = lines(onLine), stderr = lines(onLine);
    child.stdout.on("data", (chunk: Buffer) => stdout.write(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.write(chunk));
    child.stdout.on("end", () => stdout.end());
    child.stderr.on("end", () => stderr.end());
    child.stdin.on("error", () => {});
    const done = new Promise<void>((resolve) => {
      child.once("error", () => { this.fail(new Error(`${job.tag} 无法启动`)); resolve(); });
      child.once("close", (code, signal) => {
        if (!this.signal.aborted) this.fail(new Error(`${job.tag} 意外退出（${signal ?? code}）`));
        resolve();
      });
    });
    this.#children.push({ process: child, done });
    child.stdin.write(`${JSON.stringify({ ...job, killGraceMs: job.killGraceMs ?? 5000 })}\n`);
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.cancel();
    this.#stopping = Promise.all(this.#children.map(async ({ process: child, done }) => {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGTERM"), 12_000);
      try { await done; } finally { clearTimeout(timer); }
    })).then(() => {});
    return this.#stopping;
  }
}

export function redact(line: string, secrets: string[]): string {
  let result = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  for (const secret of secrets) if (secret) {
    result = result.split(secret).join("[已隐藏]");
    result = result.split(encodeURIComponent(secret)).join("[已隐藏]");
  }
  return result.replace(/([?&](?:token|key|secret)=)[^\s&#]*/gi, "$1[已隐藏]");
}
