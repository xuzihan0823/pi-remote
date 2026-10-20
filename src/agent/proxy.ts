import { request as httpRequest, Agent as HttpAgent, type AgentOptions } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";

function bypassed(host: string, port: number, noProxy: string | undefined): boolean {
  const name = host.toLowerCase();
  if (name === "localhost" || name === "::1" || /^127\./.test(name)) return true;
  for (const raw of (noProxy ?? "").split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const [entryHost = "", entryPort] = entry.split(":");
    if (entryPort && Number(entryPort) !== port) continue;
    const suffix = entryHost.replace(/^\*?\./, "");
    if (name === suffix || name.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

function proxyFor(target: URL, env: NodeJS.ProcessEnv): string | undefined {
  const secure = target.protocol === "wss:" || target.protocol === "https:";
  const value = secure
    ? env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy
    : env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy;
  if (!value) return undefined;
  try {
    const proxy = new URL(value);
    if (proxy.protocol !== "http:" || !proxy.hostname) return undefined;
    return proxy.toString();
  } catch {
    return undefined;
  }
}

type TunnelCallback = (error: Error | null, socket?: Duplex) => void;

function connectTunnel(proxyUrl: string, host: string, port: number, callback: TunnelCallback): void {
  const proxy = new URL(proxyUrl);
  const headers: Record<string, string> = { host: `${host}:${port}` };
  if (proxy.username) {
    const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
    headers["proxy-authorization"] = `Basic ${Buffer.from(credentials).toString("base64")}`;
  }
  const request = httpRequest({
    host: proxy.hostname,
    port: Number(proxy.port) || 80,
    method: "CONNECT",
    path: `${host}:${port}`,
    headers,
    timeout: 15_000,
  });
  request.on("connect", (response, socket) => {
    if (response.statusCode !== 200) {
      socket.destroy();
      callback(new Error(`代理 CONNECT 失败（HTTP ${response.statusCode}）`));
      return;
    }
    callback(null, socket);
  });
  request.on("error", callback);
  request.on("timeout", () => request.destroy(new Error("代理连接超时")));
  request.end();
}

function createAgent(proxy: string, secure: boolean, target: URL): HttpAgent | HttpsAgent {
  const Agent = secure ? HttpsAgent : HttpAgent;
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = (options: AgentOptions, callback) => {
    const host = options.host ?? target.hostname;
    const port = Number(options.port) || (secure ? 443 : 80);
    connectTunnel(proxy, host, port, (error, socket) => {
      if (error || !socket || !callback) {
        callback?.(error, socket as never);
        return;
      }
      if (!secure) {
        callback(null, socket as never);
        return;
      }
      const secured = tlsConnect({
        socket,
        servername: (options as { servername?: string }).servername ?? host,
        rejectUnauthorized: true,
      });
      const onError = (tlsError: Error): void => callback(tlsError, undefined as never);
      secured.once("error", onError);
      secured.once("secureConnect", () => {
        secured.removeListener("error", onError);
        callback(null, secured as never);
      });
    });
    return undefined as never;
  };
  return agent;
}

export function proxyAgentFor(target: URL, env: NodeJS.ProcessEnv = process.env): HttpAgent | HttpsAgent | undefined {
  const secure = target.protocol === "wss:" || target.protocol === "https:";
  const port = Number(target.port) || (secure ? 443 : 80);
  if (bypassed(target.hostname, port, env.NO_PROXY ?? env.no_proxy)) return undefined;
  const proxy = proxyFor(target, env);
  return proxy ? createAgent(proxy, secure, target) : undefined;
}
