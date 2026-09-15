import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SpawnOptions } from "node:child_process";
import type { RpcChildProcess, RpcSpawnFn } from "../../src/pi/rpc-client.ts";

export interface FakeChild {
  process: RpcChildProcess;
  spawn: RpcSpawnFn;
  spawnedArgs: string[][];
  spawnedOptions: SpawnOptions[];
  killedWith: NodeJS.Signals[];
  writtenLines(): Record<string, unknown>[];
  lastWrittenLine(): Record<string, unknown>;
  pushStdout(line: string): void;
  pushStderr(chunk: string): void;
  exit(code: number | null, signal?: NodeJS.Signals | null): void;
  emitError(error: Error): void;
}

export function createFakeChild(): FakeChild {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const chunks: string[] = [];
  const spawnedArgs: string[][] = [];
  const spawnedOptions: SpawnOptions[] = [];
  const killedWith: NodeJS.Signals[] = [];

  const originalWrite = stdin.write.bind(stdin);
  stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string") chunks.push(chunk);
    return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof stdin.write;

  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;

  const fakeProcess = {
    get stdin() {
      return stdin;
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    pid: 4242,
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    kill(signal: NodeJS.Signals = "SIGTERM") {
      killedWith.push(signal);
      if (exitCode === null && signalCode === null) {
        exitCode = 0;
        queueMicrotask(() => emitter.emit("exit", 0, null));
      }
      return true;
    },
    on(event: string, listener: (...args: never[]) => void) {
      emitter.on(event, listener as unknown as (...args: unknown[]) => void);
      return fakeProcess;
    },
  } as unknown as RpcChildProcess;

  const spawn: RpcSpawnFn = (command, args, options) => {
    spawnedArgs.push([command, ...args]);
    spawnedOptions.push(options);
    return fakeProcess;
  };

  const parseChunks = (): Record<string, unknown>[] =>
    chunks
      .join("")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  return {
    process: fakeProcess,
    spawn,
    spawnedArgs,
    spawnedOptions,
    killedWith,
    writtenLines: parseChunks,
    lastWrittenLine: () => {
      const lines = parseChunks();
      const line = lines.at(-1);
      if (!line) throw new Error("no RPC lines were written");
      return line;
    },
    pushStdout: (line) => {
      stdout.write(line);
    },
    pushStderr: (chunk) => {
      stderr.write(chunk);
    },
    exit: (code, signal = null) => {
      exitCode = code;
      signalCode = signal;
      emitter.emit("exit", code, signal);
    },
    emitError: (error) => {
      emitter.emit("error", error);
    },
  };
}

export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
