"use strict";

/**
 * 文本清洗与按字节截断。与 pi-remote 的 src/terminal/extension.ts#safeText 保持同一规则：
 * 去掉终端控制序列和控制字符，并遮蔽常见凭据形态，避免把 Token 带到手机上。
 */

function safeText(text) {
  return String(text ?? "")
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1[已隐藏]")
    .replace(/([?&](?:token|key|secret|password|access_token)=)[^&#\s)]+/gi, "$1[已隐藏]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g, "[凭据已隐藏]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[私钥已隐藏]");
}

function byteLength(text) {
  return Buffer.byteLength(String(text), "utf8");
}

/** 截断到不超过 maxBytes 的 UTF-8 字节，不切断多字节字符。 */
function truncateBytes(text, maxBytes) {
  const value = String(text);
  if (byteLength(value) <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8").subarray(0, Math.max(0, maxBytes));
  let decoded = buffer.toString("utf8");
  // 末尾不完整的多字节字符会被解码成 U+FFFD，去掉它。
  while (decoded.endsWith("\uFFFD")) decoded = decoded.slice(0, -1);
  return decoded;
}

/** 递归清洗工具参数：遮蔽敏感键，限制深度与数量。 */
function safeArguments(value, depth = 0) {
  if (depth > 8) return "[内容已隐藏]";
  if (typeof value === "string") return safeText(value);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.slice(0, 1000).map((item) => safeArguments(item, depth + 1));
  if (typeof value !== "object") return "[未记录]";
  return Object.fromEntries(Object.entries(value).slice(0, 1000).map(([key, item]) => [
    safeText(key),
    /token|password|secret|credential|authorization|api.?key|signature|providerPayload|thinking/i.test(key)
      ? "[已隐藏]" : safeArguments(item, depth + 1),
  ]));
}

/** 把 PI-Desktop 的工具结果（字符串、内容块数组或对象）收敛成纯文字。 */
function textOnly(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.flatMap((part) => {
      if (typeof part === "string") return [part];
      if (part && typeof part === "object" && (part.type === undefined || part.type === "text") && typeof part.text === "string") {
        return [part.text];
      }
      return [];
    }).join("");
  }
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (value.content !== undefined) return textOnly(value.content);
    try { return JSON.stringify(value, null, 2); } catch { return ""; }
  }
  return value === undefined || value === null ? "" : String(value);
}

function errorMessage(error) {
  if (error && typeof error === "object" && typeof error.message === "string") return error.message;
  return String(error);
}

function errorCode(error) {
  if (error && typeof error === "object") {
    const candidate = error.code ?? error.errorCode ?? error.data?.errorCode;
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

module.exports = { safeText, byteLength, truncateBytes, safeArguments, textOnly, errorMessage, errorCode };
