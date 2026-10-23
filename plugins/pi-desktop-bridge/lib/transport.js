"use strict";

/**
 * Relay 地址校验。规则与 pi-remote PR #1 的 iOS TransportSecurity 一致：
 * 明文 ws:// 只允许本机、局域网、链路本地与 Tailscale（100.64.0.0/10、*.ts.net）地址；
 * 公网地址必须使用 wss://，否则 AGENT_TOKEN 和会话内容会以明文经过公网。
 */

const DEFAULT_AGENT_PATH = "/ws/agent";

function isPrivateHost(rawHost) {
  const host = String(rawHost ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".ts.net")) return true;
  if (host.includes(":")) {
    // IPv6：回环、链路本地 fe80::/10、唯一本地 fc00::/7
    return host === "::1" || /^fe[89ab]/.test(host) || /^f[cd]/.test(host);
  }
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / Tailscale
  return false;
}

function allowsTransport(scheme, host) {
  switch (String(scheme).toLowerCase().replace(/:$/, "")) {
    case "wss":
    case "https":
      return true;
    case "ws":
    case "http":
      return isPrivateHost(host);
    default:
      return false;
  }
}

/**
 * 把用户在设置里填的 Relay 地址规范成 Agent 端点 URL。
 * 接受 wss://host、wss://host/ws/agent，也接受 https:// / http://（自动换成 wss:// / ws://）。
 * 返回 { ok: true, url } 或 { ok: false, error }，error 为中文说明。
 */
function normalizeRelayUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "尚未填写 Relay 地址" };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "Relay 地址格式无效，应形如 wss://relay.example.com" };
  }
  const schemes = { "https:": "wss:", "http:": "ws:", "wss:": "wss:", "ws:": "ws:" };
  const scheme = schemes[url.protocol];
  if (!scheme) return { ok: false, error: "Relay 地址必须使用 wss:// 或 ws://" };
  if (!url.hostname) return { ok: false, error: "Relay 地址缺少主机名" };
  if (url.username || url.password) return { ok: false, error: "Relay 地址不能包含用户名或密码" };
  if (url.search || url.hash) {
    return { ok: false, error: "Relay 地址不能带查询参数；AGENT_TOKEN 请填在单独的设置项里" };
  }
  if (!allowsTransport(scheme, url.hostname)) {
    return { ok: false, error: "公网 Relay 必须使用 wss://；ws:// 只允许本机、局域网或 Tailscale 地址" };
  }
  const path = url.pathname === "" || url.pathname === "/" ? DEFAULT_AGENT_PATH : url.pathname.replace(/\/+$/, "");
  if (path !== DEFAULT_AGENT_PATH) {
    return { ok: false, error: `Relay 地址路径应为 ${DEFAULT_AGENT_PATH}（可省略）` };
  }
  const host = url.host; // 保留端口与 IPv6 方括号
  return { ok: true, url: `${scheme}//${host}${DEFAULT_AGENT_PATH}` };
}

/** AGENT_TOKEN 只做最基本的形态检查：不能为空、不能含空白或控制字符。 */
function validateAgentToken(raw) {
  const token = String(raw ?? "").trim();
  if (!token) return { ok: false, error: "尚未填写 AGENT_TOKEN" };
  if (/[\s\x00-\x1f\x7f]/.test(token)) return { ok: false, error: "AGENT_TOKEN 不能包含空白或控制字符" };
  if (token.length > 4096) return { ok: false, error: "AGENT_TOKEN 过长" };
  return { ok: true, token };
}

module.exports = { isPrivateHost, allowsTransport, normalizeRelayUrl, validateAgentToken, DEFAULT_AGENT_PATH };
