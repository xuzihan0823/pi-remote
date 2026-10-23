"use strict";

/**
 * pi.desktop.invoke 的白名单网关。
 *
 * 只调用手机控制必需的 read/write 操作；目录中标为 dangerous 的操作（tool/resolvePermission、
 * agent/askTool/resolve、plans/resolve、session/configure、session/delete 等）一律不调用，
 * 也从不传 confirm，因此永远不会触发 Mac 上的原生确认框。
 */

const ALLOWED_OPERATIONS = Object.freeze([
  "session/list",
  "session/get",
  "session/create",
  "agent/prompt",
  "agent/abort",
  "agent/getStatus",
  "providers/list",
  "providers/listModels",
  "project/list",
]);

/** 没有这些操作就无法提供基本的阅读与发送。 */
const REQUIRED_OPERATIONS = Object.freeze(["session/list", "session/get", "agent/getStatus", "agent/prompt", "agent/abort"]);

class CapabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = "CapabilityError";
  }
}

class DesktopGateway {
  constructor(pi) {
    this.pi = pi;
    /** @type {Map<string, string> | null} operation id -> risk */
    this.catalog = null;
    this.catalogError = null;
  }

  /** 启动时读取宿主目录，做能力探测。失败时记录原因，后续请求统一报错。 */
  async refresh() {
    try {
      if (!this.pi?.desktop || typeof this.pi.desktop.listOperations !== "function") {
        throw Object.assign(new Error("当前 PI-Desktop 不提供 pi.desktop 接口"), { code: "UNSUPPORTED" });
      }
      const operations = await this.pi.desktop.listOperations();
      if (!Array.isArray(operations)) throw new Error("PI-Desktop 控制目录格式无效");
      const catalog = new Map();
      for (const entry of operations.slice(0, 4096)) {
        if (entry && typeof entry.id === "string" && entry.id.length <= 256) {
          catalog.set(entry.id, typeof entry.risk === "string" ? entry.risk : "dangerous");
        }
      }
      this.catalog = catalog;
      this.catalogError = null;
    } catch (error) {
      this.catalog = null;
      const code = error && typeof error === "object" ? error.code : undefined;
      this.catalogError = code === "PERMISSION_DENIED"
        ? "插件没有 desktop.control 权限，请在 Plugins 页面重新加载开发插件并授予权限"
        : `无法读取 PI-Desktop 控制目录：${error instanceof Error ? error.message : String(error)}`;
    }
    return this.catalog !== null;
  }

  get ready() {
    return this.catalog !== null && REQUIRED_OPERATIONS.every((operation) => this.has(operation));
  }

  missingRequired() {
    return REQUIRED_OPERATIONS.filter((operation) => !this.has(operation));
  }

  /** 白名单内、目录里存在、且不是 dangerous。 */
  has(operation) {
    if (!ALLOWED_OPERATIONS.includes(operation) || !this.catalog) return false;
    const risk = this.catalog.get(operation);
    return risk === "read" || risk === "write";
  }

  async invoke(operation, args = []) {
    if (!ALLOWED_OPERATIONS.includes(operation)) {
      throw new CapabilityError(`插件不允许调用 ${operation}`);
    }
    if (!this.catalog) throw new CapabilityError(this.catalogError ?? "PI-Desktop 控制目录尚未就绪");
    if (!this.has(operation)) {
      throw new CapabilityError(`当前 PI-Desktop 版本不支持 ${operation}，请更新桌面端`);
    }
    return this.pi.desktop.invoke({ operation, args });
  }
}

module.exports = { DesktopGateway, CapabilityError, ALLOWED_OPERATIONS, REQUIRED_OPERATIONS };
