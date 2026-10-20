import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import QRCode from "qrcode";
import { pairPayload } from "../../backend/claude/src/pair.ts";
import { waitFor } from "./tunnel.ts";

export function piPayload(agentUrl: string, token: string): string {
  const url = new URL(agentUrl);
  url.pathname = "/ws/ios";
  return JSON.stringify({ version: 1, serverUrl: url.toString(), token });
}
export function claudePayload(base: string, token: string): string { return pairPayload({ bases: [base], token }); }

export async function health(base: string, token: string, signal: AbortSignal, path = "/api/health"): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(new URL(path, base), {
      headers: { Authorization: `Bearer ${token}` }, redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
    });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error("健康检查发生重定向，已拒绝连接"); }
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new Error("健康检查认证失败，请检查连接凭据"); }
    if (!response.ok) { await response.body?.cancel(); return undefined; }
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 64 * 1024) throw new Error("健康检查响应过大");
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof TypeError || error instanceof SyntaxError || (error instanceof Error && error.name === "TimeoutError")) return undefined;
    throw error;
  }
}

export async function verifyPi(base: string, token: string, deviceId: string, signal: AbortSignal): Promise<void> {
  await waitFor("等待 Pi Agent", async () => {
    const result = await health(base, token, signal, "/api/status");
    return result?.status === "ok" && result.agentConnected === true && result.agentDeviceId === deviceId ? true : undefined;
  }, signal);
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/ios";
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 5000, maxPayload: 64 * 1024, followRedirects: false });
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Pi 手机连接握手超时")), 6000);
    const abort = (): void => finish(new Error("连接已取消"));
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal.removeEventListener("abort", abort); socket.terminate();
      if (error) reject(error); else resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    socket.on("open", () => socket.send(JSON.stringify({ version: 1, type: "hello", deviceId: `cli-pair-${randomUUID()}`, payload: { role: "ios" } })));
    socket.on("message", (data) => {
      try {
        const frame = JSON.parse(data.toString());
        if (frame.type === "hello_ack" && frame.payload?.role === "ios" && frame.payload?.agentConnected === true) finish();
        else finish(new Error("Pi 手机连接握手失败"));
      } catch { finish(new Error("Pi 握手响应无效")); }
    });
    socket.on("error", () => finish(new Error("Pi 手机连接认证失败或地址不可达")));
    socket.on("close", () => finish(new Error("Pi 手机连接已关闭")));
  });
}

export async function verifyClaude(base: string, token: string, instanceId: string, signal: AbortSignal): Promise<void> {
  await waitFor("等待 Claude 后端", async () => {
    const result = await health(base, token, signal);
    if (!result) return undefined;
    if (result.ok !== true || result.service !== "pi-remote-claude" || result.instanceId !== instanceId) throw new Error("Claude 后端实例不匹配，已拒绝配对");
    return true;
  }, signal);
}

export async function showPairing(label: string, base: string, payload: string): Promise<void> {
  console.log(`\n${label} 已就绪：${base}`);
  if (process.stdout.isTTY) {
    console.log(`请用 ${label} 手机端扫码（二维码包含连接凭据）：`);
    console.log(await QRCode.toString(payload, { type: "terminal", small: true }));
  } else { console.log("请在交互终端运行以显示配对二维码；日志中不输出凭据。"); }
}
