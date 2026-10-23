"use strict";

/**
 * pi-remote ↔ PI-Desktop 桥接插件入口（在 PI-Desktop 的独立 Node 插件进程中运行，宿主注入全局 pi）。
 *
 * - 常驻服务 relay：主动连到 pi-remote Relay 的 /ws/agent，扮演 Mac Agent，让 pi-remote iOS App 阅读、
 *   新建、发送、停止 Pi Desktop 会话。
 * - 命令「pi-remote：连接状态」显示当前连接状态；「pi-remote：重新连接」立即按当前设置重连。
 */

const { Bridge } = require("./lib/bridge.js");

const SERVICE_ID = "relay";
const STATUS_COMMAND = "pi-remote-bridge.status";
const RECONNECT_COMMAND = "pi-remote-bridge.reconnect";

let bridge = null;

async function onLoad() {
  bridge = new Bridge(pi);
  pi.services.register({
    id: SERVICE_ID,
    start: ({ log } = {}) => {
      bridge.setLogger(log);
      bridge.start();
    },
    stop: () => bridge.stop(),
  });
  await pi.commands.register({
    id: STATUS_COMMAND,
    title: "pi-remote：连接状态",
    keywords: ["pi-remote", "relay", "iphone", "手机", "远程"],
    run: async () => {
      await pi.ui.showToast(bridge.describeStatus(), bridge.status.state === "connected" ? "info" : "warn");
    },
  });
  await pi.commands.register({
    id: RECONNECT_COMMAND,
    title: "pi-remote：重新连接",
    keywords: ["pi-remote", "relay", "reconnect", "重连"],
    run: async () => {
      if (!bridge.started) bridge.start();
      else await bridge.reconnect();
      await pi.ui.showToast(bridge.describeStatus(), "info");
    },
  });
}

async function onUnload() {
  try {
    await pi.commands.unregister(STATUS_COMMAND);
    await pi.commands.unregister(RECONNECT_COMMAND);
  } catch {
    // 宿主卸载时也会清理命令
  }
  if (bridge) await bridge.stop();
  bridge = null;
}

module.exports = { onLoad, onUnload };
