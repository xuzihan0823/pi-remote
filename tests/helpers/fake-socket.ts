import type { WebSocket } from "ws";

type Listener = (...args: unknown[]) => void;

/**
 * Scriptable stand-in for `ws.WebSocket`. It can stay silent (never answer pings, never emit
 * `close`) and stall a graceful close, which is how a half-open socket behaves in the field.
 */
export class FakeSocket {
  static readonly instances: FakeSocket[] = [];
  static autoOpen = true;
  static autoPong = true;
  static silentConnect = false;

  readyState = 0;
  readonly url: string;
  readonly sent: string[] = [];
  pingCount = 0;
  terminated = false;
  gracefulCloseStalls = false;
  readonly #listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
    setImmediate(() => {
      if (FakeSocket.silentConnect) return;
      if (FakeSocket.autoOpen) this.open();
      else {
        this.emit("error", new Error("connection refused"));
        this.serverClose();
      }
    });
  }

  on(event: string, listener: Listener): this {
    const set = this.#listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(event, set);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapper: Listener = (...args: unknown[]) => {
      this.#listeners.get(event)?.delete(wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(...args);
  }

  open(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.emit("open");
  }

  send(data: string): void {
    this.sent.push(data);
  }

  ping(): void {
    this.pingCount += 1;
    if (FakeSocket.autoPong) this.emit("pong");
  }

  close(): void {
    if (this.gracefulCloseStalls) return;
    this.serverClose(1000);
  }

  terminate(): void {
    if (this.readyState === 3) return;
    this.terminated = true;
    this.serverClose(1006);
  }

  serverClose(code = 1006): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(""));
  }
}

export const fakeWebSocketImpl = FakeSocket as unknown as typeof WebSocket;

export function resetFakeSockets(): void {
  FakeSocket.instances.length = 0;
  FakeSocket.autoOpen = true;
  FakeSocket.autoPong = true;
  FakeSocket.silentConnect = false;
}
