import { networkInterfaces, hostname } from "node:os";
import type { IncomingHttpHeaders } from "node:http";

export interface PairInfo {
  bases: string[];
  token: string;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * 隧道/反向代理特征头检测。
 *
 * 配对端点靠 socket 源地址判 loopback，前提是「loopback = 物理在本机的人」。
 * cloudflared / ngrok / nginx 等代理跑在本机时源地址同样是 127.0.0.1，该前提被打破：
 * 隧道一开，公网任何人都能无鉴权读到 pair-info 里的 token。
 *
 * 故只要出现任一代理特征头就拒绝（fail-closed）。直连场景下攻击者伪造这些头
 * 只会让自己被拒，不构成提权，因此宁可误杀。
 */
export function looksProxied(headers: IncomingHttpHeaders): boolean {
  const markers = [
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    "forwarded",
    "cf-connecting-ip",
    "cf-ray",
    "cf-ipcountry",
    "cf-visitor",
    "ngrok-trace-id",
  ];
  return markers.some((name) => headers[name] !== undefined);
}

function isIpv4(address: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address);
}

function isTailscaleAddress(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

function interfaceIpv4(name: string): string | undefined {
  return networkInterfaces()[name]?.find((entry) => !entry.internal && entry.family === "IPv4" && isIpv4(entry.address))?.address;
}

export function enumeratePairBases(port: number): string[] {
  const tailscale: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.family === "IPv4" && isTailscaleAddress(entry.address)) {
        tailscale.push(entry.address);
      }
    }
  }
  const lan = interfaceIpv4("en0");
  const localHostname = hostname().toLowerCase().endsWith(".local") ? hostname().toLowerCase() : `${hostname().toLowerCase()}.local`;
  const addresses = [...tailscale, ...(lan === undefined ? [] : [lan]), localHostname];
  return [...new Set(addresses)].map((address) => `http://${address}:${port}`);
}

export function pairPayload(info: PairInfo): string {
  const bases = info.bases.map((base) => encodeURIComponent(base)).join(",");
  return `claude-remote://setup?v=1&token=${encodeURIComponent(info.token)}&bases=${bases}`;
}
