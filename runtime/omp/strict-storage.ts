import { accessSync, closeSync, constants, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { FileSessionStorage, tryAcquireSessionLease } from "./node_modules/@oh-my-pi/pi-coding-agent/src/session/session-storage.ts";

export class StrictSessionStorage extends FileSessionStorage {
  readonly file: string;
  readonly id: string;
  readonly cwd: string;
  readonly #lease: NonNullable<ReturnType<typeof tryAcquireSessionLease>>;
  #identity: string;
  #failed = false;
  #released = false;
  readonly #fatal: (error: Error) => void;

  constructor(target: { file: string; id: string; cwd: string }, fatal: (error: Error) => void = () => {}, readonly changed: () => void = () => {}) {
    super();
    this.file = realpathSync(target.file);
    this.id = target.id;
    this.cwd = realpathSync(target.cwd);
    if (resolve(target.file) !== this.file) throw new Error("strict_history_path_changed");
    accessSync(this.file, constants.R_OK | constants.W_OK);
    this.#identity = this.identity();
    this.#fatal = fatal;
    const lease = tryAcquireSessionLease(this.id);
    if (!lease) throw new Error("strict_history_owned");
    this.#lease = lease;
    try { this.assert(); } catch (error) { this.release(); throw error; }
  }

  identity(): string {
    const info = lstatSync(this.file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("strict_history_not_file");
    if (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0 || (info.mode & 0o600) !== 0o600) throw new Error("strict_history_permissions_changed");
    return `${info.dev}:${info.ino}`;
  }

  fail(reason: string): never {
    const error = new Error(reason);
    this.#failed = true;
    this.#fatal(error);
    throw error;
  }

  assert(path = this.file): void {
    if (this.#failed || this.#released) this.fail("strict_history_unavailable");
    if (resolve(path) !== this.file) this.fail("strict_history_relocation_forbidden");
    try {
      if (realpathSync(path) !== this.file || this.identity() !== this.#identity) this.fail("strict_history_replaced");
      const fd = openSync(this.file, "r");
      let prefix: string;
      try {
        const bytes = Buffer.alloc(64 * 1024);
        prefix = bytes.toString("utf8", 0, readSync(fd, bytes, 0, bytes.length, 0));
      } finally { closeSync(fd); }
      const header = prefix.split("\n").find(line => {
        try { return JSON.parse(line).type === "session"; } catch { return false; }
      });
      const value = header ? JSON.parse(header) : null;
      if (value?.id !== this.id || realpathSync(value.cwd) !== this.cwd) this.fail("strict_history_identity_changed");
    } catch (error) {
      if (this.#failed) throw error;
      this.fail("strict_history_missing_or_invalid");
    }
  }

  claimSession(id: string, path: string): () => void {
    this.assert(path);
    if (id !== this.id) this.fail("strict_history_id_changed");
    return () => {};
  }

  openWriter(path: string, options?: Parameters<FileSessionStorage["openWriter"]>[1]) {
    this.assert(path);
    const writer = super.openWriter(path, { ...options, onError: error => {
      options?.onError?.(error);
      this.fail("strict_history_write_failed");
    } });
    return {
      flush: (...args: Parameters<typeof writer.flush>) => { this.assert(path); return writer.flush(...args); },
      flushSync: () => { this.assert(path); return writer.flushSync!(); },
      isOpen: () => writer.isOpen(),
      close: () => writer.close(),
      getError: () => writer.getError(),
      append: (line: string) => { this.assert(path); return writer.append(line); },
      appendSync: (line: string) => { this.assert(path); return writer.appendSync!(line); },
    };
  }
  renameSync(source: string, target: string): void {
    this.assert(target);
    const header = readFileSync(source, "utf8").split("\n").find(line => {
      try { return JSON.parse(line).type === "session"; } catch { return false; }
    });
    if (!header || JSON.parse(header).id !== this.id) this.fail("strict_history_rewrite_identity_changed");
    super.renameSync(source, target);
    this.#identity = this.identity();
    this.assert();
    this.changed();
  }

  writeTextSync(path: string, content: string, options?: Parameters<FileSessionStorage["writeTextSync"]>[2]): void {
    this.assert(path);
    try { super.writeTextSync(path, content, options); } catch (error) { this.fail("strict_history_write_failed"); }
  }

  async writeTextAtomic(path: string, content: string, options?: Parameters<FileSessionStorage["writeTextAtomic"]>[2]): Promise<void> {
    this.assert(path);
    try { await super.writeTextAtomic(path, content, options); } catch (error) { this.fail("strict_history_write_failed"); }
  }

  async writeText(_path: string, _content: string): Promise<void> { this.fail("strict_history_unprotected_write_forbidden"); }
  async rename(_path: string, _nextPath: string): Promise<void> { this.fail("strict_history_relocation_forbidden"); }
  async unlink(_path: string): Promise<void> { this.fail("strict_history_delete_forbidden"); }
  async deleteSessionWithArtifacts(_path: string): Promise<void> { this.fail("strict_history_delete_forbidden"); }
  async deleteSessionWithArtifactsIf(_path: string, _predicate: (content: string) => boolean): Promise<boolean> { this.fail("strict_history_delete_forbidden"); }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#lease.release();
  }
}
