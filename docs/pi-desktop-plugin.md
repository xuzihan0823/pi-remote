# 用 PI-Desktop 插件接入 pi-remote

`plugins/pi-desktop-bridge` 是一个 [PI-Desktop](https://github.com/vastsa/PI-Desktop) 插件。它在 PI-Desktop 里常驻运行，主动连到 pi-remote Relay 的 `/ws/agent`，扮演原来的 Mac Agent，于是 pi-remote iOS App 可以直接阅读、新建、发送和停止 **Pi Desktop 里的会话**——不需要在 Mac 上另外运行 `npm run agent`，也不需要本机 MCP 控制服务器。

```
iPhone (pi-remote App) ──wss──▶ Relay (/ws/ios)
                                  ▲
                                  │ wss，Authorization: Bearer AGENT_TOKEN
                                  │
PI-Desktop ── 插件进程 ── pi.net.websocket ──▶ Relay (/ws/agent)
     ▲                │
     └── pi.desktop.invoke（受审核的控制目录：session/*、agent/*、providers/*、project/list）
```

> 同一个 Relay 同一时间只允许一个 Agent。使用插件时，请停掉 Mac 上的 `npm run agent` / Mac 助手 App 里的 Agent，否则后连上的一方会被拒绝。

## 一、准备 Relay 与凭据

插件只需要 Relay 的 **AGENT_TOKEN**（Agent 端点 `/ws/agent` 的凭据）。它和手机使用的 **RELAY_TOKEN**（`/ws/ios`）是两把不同的钥匙（PR #1 拆分），请在 Relay 上分别设置：

```bash
RELAY_TOKEN=$(openssl rand -hex 32)   # 填到手机
AGENT_TOKEN=$(openssl rand -hex 32)   # 填到 PI-Desktop 插件
```

Relay 部署方式不变（见仓库 README 与 `deploy/`）。

## 二、安装插件（开发插件方式）

1. 把本仓库克隆到 Mac，例如 `~/src/pi-remote`。插件没有任何依赖，不需要 `npm install`。
2. 打开 PI-Desktop → **Plugins（扩展）** 页面 → 右上角菜单 → **Load development plugin（加载开发插件）**。
3. 选择目录 `~/src/pi-remote/plugins/pi-desktop-bridge`。
4. 在权限确认里允许以下权限：

   | 权限 | 风险 | 用途 |
   |---|---|---|
   | `background.service` | 中 | 常驻服务 `relay`：保持与 Relay 的连接 |
   | `net.websocket` | 高 | 通过宿主管理的 WebSocket 连接 Relay |
   | `net.anyHost` | 高 | Relay 地址由你自己填写，无法在 manifest 里预先写死域名 |
   | `desktop.control` | 高 | 调用 PI-Desktop 的受审核控制目录（列出/读取/新建会话、发送、停止、读模型目录、读项目列表） |

插件也可以用 PI-Desktop 仓库的 devkit 打包成 `.piplug` 再通过 **Install plugin package** 安装；但 `desktop.control` 是高风险权限，**插件市场上的第三方插件不一定能获得这项授权**，以开发插件方式加载是确定可用的路径。

## 三、配置

在 Plugins 页面打开本插件的设置：

| 设置 | 说明 |
|---|---|
| Relay 地址 | 例如 `wss://relay.example.com`，会自动补上 `/ws/agent`；也接受 `https://`（自动换成 `wss://`）。**公网地址必须用 `wss://`**；`ws://` 只允许本机、局域网（10/8、172.16/12、192.168/16、169.254/16）、`*.local` 和 Tailscale（100.64/10、`*.ts.net`）地址——与 PR #1 的 iOS 传输安全规则一致。地址里不能带查询参数或用户名密码。 |
| AGENT_TOKEN | Relay 的 Agent 凭据，只通过 `Authorization: Bearer` 头发送，不会出现在 URL 或日志里。 |
| 设备名称（可选） | 手机上显示的 Mac 名称，留空用主机名。 |
| 启用连接 | 关掉后插件保持加载但不连接。 |

修改设置后插件会自动按新设置重连。全局搜索（⌘K）里可以运行：

- **pi-remote：连接状态**——显示当前连接状态与最近的错误原因；
- **pi-remote：重新连接**——立即重连。

> 安全提示：PI-Desktop 当前不支持加密的插件设置（manifest 校验会拒绝 `secret` 设置项），AGENT_TOKEN 以明文保存在该插件的私有设置文件里。请只在自己的 Mac 上使用，并在怀疑泄露时轮换 AGENT_TOKEN。

## 四、把会话设为自动（auto）权限模式

插件**不会**替你批准任何东西：工具权限（`tool/resolvePermission`）、AskTool 回答（`agent/askTool/resolve`）、计划批准（`plans/resolve`）和修改会话配置（`session/configure`）在 PI-Desktop 里都属于 `dangerous` 操作，调用时会在 Mac 上弹出原生确认框，插件一律不调用。

因此请在 PI-Desktop 里把要从手机驱动的会话（或全局默认权限）设为 **auto**。否则会话一旦需要审批，就会停在那里等你回到 Mac 处理；手机会话页会显示“需要在 Mac 上的 Pi Desktop 中处理”的提示，非 auto 会话也会有一条常驻提示。

## 五、手机上怎么用

手机端无需更新，现有 pi-remote App 即可：

- 会话列表里，Pi Desktop 会话以“Mac 共享会话”的形式出现（会话 ID 前缀 `terminal:desktop:`），按项目分组，显示运行中/空闲。
- 新建会话时选择 **Mac 共享会话**（默认就是它；“后台会话”不适用于 Pi Desktop），项目只能从 PI-Desktop 已知项目里选，可以选模型。
- 会话页能看到用户消息、助手回复、工具调用与结果（可展开参数/结果/长正文），可以发送文字消息和停止当前轮次。
- 已有会话的模型只能在 Mac 上切换；确认与选择请在 Mac 上完成。

## 能力对照

| 手机操作（Relay 方法） | PI-Desktop 控制目录操作 |
|---|---|
| `session.list` | `session/list` + 每个会话 `agent/getStatus`（只列本机 Desktop 会话，排除 CLI、远程主机、定时任务会话；最多 100 个） |
| `session.list`（选择项目） | `project/list` |
| `session.start` | `session/create`（可带 `projectPath`、`providerId`/`modelId`） |
| `session.get`（时间线 / 分支 / 工具详情） | `session/get`（按消息窗口分页，`messageAround` 精确回读单条）+ `agent/getStatus` |
| `session.prompt` | `agent/prompt`（运行中会拒绝，避免排队） |
| `session.abort` | `agent/abort` |
| `model.list` / `session.get_model` | `providers/list` + `providers/listModels`（`source: "cache"`，不触发联网刷新） |
| `session.set_model`、`ui.response` | 不支持（需要 dangerous 操作），返回“请在 Mac 上处理” |

插件启动时用 `pi.desktop.listOperations()` 做能力探测；只调用上表白名单里、目录标为 `read`/`write` 的操作，从不传 `confirm`，从不调用 dangerous 操作，也从不接触 MCP Bearer Token。

## 限制

- **没有逐字流式输出**：PI-Desktop 不向插件推送 token 流。手机按现有逻辑轮询 `session.get`（运行中约 0.5 秒、空闲 2 秒），插件另外以约 1 秒（空闲 5 秒）的间隔轮询手机最近操作过的会话的 `agent/getStatus`，并利用宿主的 `session:turnEnded` 事件尽快推送“本轮结束”。正文出现的时机取决于 PI-Desktop 何时把内容写进会话记录。
- **审批只能在 Mac 上做**：见第四节。
- **帧大小**：PI-Desktop 插件 WebSocket 单帧上限 1 MiB、每个插件最多 4 个连接。插件同一时间只持有一个连接；时间线每页最多 30 条消息、整页控制在 256 KiB 内，长正文/工具输出截断后可在手机上按 60 KiB 分段展开；任何超过上限的响应会改写为 `result_too_large` 错误而不是断线。
- **不支持**：图片附件、续接 OMP 历史、在手机上浏览任意目录、切换已有会话的模型、子 agent 内部记录（只显示主时间线）。
- `desktop.control` 可能无法授予市场上的第三方插件；开发插件方式加载可用。
- 本插件按 PI-Desktop `0.21.0-beta.7`（main 分支 `e7d8765`）的插件 API 与控制目录编写，并在仓库里用模拟宿主做了单元与端到端测试；尚需在真实的 Mac + PI-Desktop 上验证（见 PR 说明里的检查清单）。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 状态“需要配置” | Relay 地址或 AGENT_TOKEN 没填或不合法；状态里会写明原因（例如公网地址用了 `ws://`）。 |
| 状态“等待重连 · 401” | AGENT_TOKEN 不对（注意不是 RELAY_TOKEN）。 |
| “Relay 上已有另一个 Mac Agent 在线” | 停掉 `npm run agent` 或 Mac 助手 App 里的 Agent。 |
| “PI-Desktop 拒绝连接该地址” | 没有授予 `net.websocket` / `net.anyHost`；重新加载开发插件并允许权限。 |
| 手机提示“Pi Desktop 控制能力不可用” | 没有授予 `desktop.control`，或 PI-Desktop 版本缺少所需操作。 |
| 会话停在运行中不动 | 多半在等待权限 / 计划 / AskTool，回到 Mac 上处理，并把会话设为 auto。 |

日志：PI-Desktop **Settings → Info → Logs**，搜索插件 id `io.github.xuzihan0823.pi-remote-bridge`。

## 开发

```bash
npm run test:plugin   # 插件单元测试 + 与真实 Relay 的端到端测试（模拟 PI-Desktop 宿主）
npm test              # 全部测试
```

在 PI-Desktop 仓库根目录可以用官方 devkit 校验与打包：

```bash
pnpm pi-plugin check /path/to/pi-remote/plugins/pi-desktop-bridge
pnpm pi-plugin pack  /path/to/pi-remote/plugins/pi-desktop-bridge
```

`check` 会给出两条预期内的警告：高风险权限需要用户明确授权；以及 `net.websocket` “未使用”——devkit 只扫描 `main.js`，而连接代码在 `lib/relay-connection.js` 里。
