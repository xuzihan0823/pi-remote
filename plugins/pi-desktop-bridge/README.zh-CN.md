# pi-remote Bridge（PI-Desktop 插件）

把 PI-Desktop 接到 [pi-remote](https://github.com/xuzihan0823/pi-remote) Relay，让 pi-remote iOS App 阅读、新建、发送和停止 Pi Desktop 会话。完整说明见仓库的 [docs/pi-desktop-plugin.md](../../docs/pi-desktop-plugin.md)。

## 快速开始

1. PI-Desktop → Plugins → 右上角菜单 → **Load development plugin**，选择本目录。
2. 允许权限：`background.service`、`net.websocket`、`net.anyHost`、`desktop.control`。
3. 在插件设置里填写 **Relay 地址**（如 `wss://relay.example.com`）和 **AGENT_TOKEN**（不是手机用的 RELAY_TOKEN）。
4. 把要从手机驱动的会话设为 **auto** 权限模式——审批类操作在 PI-Desktop 里是 dangerous，插件不会调用，只能在 Mac 上处理。
5. ⌘K 运行 **pi-remote：连接状态** 确认已连接。

## 文件

| 文件 | 作用 |
|---|---|
| `manifest.json` | 插件声明：常驻服务 `relay`、两条命令、四个设置、四项权限 |
| `package.json` | 只声明 `"type": "commonjs"`，没有依赖 |
| `main.js` | 入口：注册服务与命令 |
| `lib/bridge.js` | 读取设置、能力探测、组装连接与请求处理 |
| `lib/relay-connection.js` | 经 `pi.net.websocket` 连接 Relay：hello、请求/响应、心跳、指数退避重连 |
| `lib/handler.js` | Relay 方法 → PI-Desktop 控制目录操作 |
| `lib/timeline.js` | PI-Desktop 会话记录 → pi-remote 时间线 v2，分页与工具详情 |
| `lib/watcher.js` | 轮询运行状态，推送 agent_start / agent_settled / 待处理提示 |
| `lib/desktop.js` | `pi.desktop.invoke` 白名单网关（从不调用 dangerous 操作） |
| `lib/transport.js` | Relay 地址规范化与 ws/wss 传输规则 |
| `lib/frames.js` | Relay 帧构造、解析与 1 MiB 体积保护 |
| `lib/backoff.js`、`lib/text.js` | 退避与文本清洗工具 |

测试在仓库的 `tests/pi-desktop-bridge/`（`npm run test:plugin`）。

## 许可

插件代码属于 pi-remote 仓库。它只通过 PI-Desktop（LGPL-3.0）公开的插件 API 与之交互，没有复制或链接 PI-Desktop 的源码。
