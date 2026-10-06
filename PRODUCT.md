# Product

<!-- impeccable:product-schema 1 -->

> 本文件的 init 访谈环节没有真人可答（本次由子 agent 按任务简报生成，用户未被提问）。所有从仓库推断、而非用户确认的内容都逐条标注「**假设**」。未标注的内容有仓库源码或文档的直接依据，依据路径写在句末。

## Platform

ios

**平台说明（事实 + 假设）**

- 事实：Impeccable 技能只支持 `web`、`ios`、`android`、`adaptive` 四种平台值，没有 macOS。本项目的设计对象实际是 **macOS 13+ 桌面 SwiftUI + AppKit 应用**（SwiftPM 构建，源码在 `macos/Sources/PiRemote/`，最低版本见 `macos/FRONTEND-REWRITE-PLAN.md` §2）。
- 假设：`ios` 是技能里最接近的 Apple 原生平台，因此记录为 `ios`。这个值只用于让技能加载 `reference/ios.md`；**它不代表目标是 iPhone / iPad**。
- 假设：`reference/ios.md` 里与「触控」相关的规则（例如 44 pt 触控目标、底部标签栏、手势返回）**不可直接迁移**到桌面；可迁移的是与设备形态无关的 HIG 规则：用系统组件优先、不做「网页移植感」控件、尊重系统深浅色、动态效果减弱、对比度、文字缩放、无障碍标签、系统语义颜色与 SF 字体。macOS 专属事项（菜单栏、窗口、键盘快捷键、悬停、文本选择、右键菜单）按 macOS HIG 另行判断。
- 项目里另有 iOS 客户端（`ios/`），是这个 Mac 助手的配对对象，不是本文件的设计对象。

## Users

- 主要用户：自己拥有一台 Mac、并在 Mac 上运行 pi / omp / Claude 等编程 Agent 的个人开发者。他在 Mac 上配置一次连接，之后用 iPhone 远程使用这台 Mac 上的 Agent。依据：`macos/README.md` 开头、`macos/FRONTEND-REWRITE-PLAN.md` §1、根 `README.md`。
- 使用情境：窗口多数时候是「配置一次、扫码、关掉」，之后只在菜单栏里看状态；出问题时再回来看原因。依据：`macos/README.md`「关闭窗口只会隐藏窗口，App 继续留在菜单栏」。
- 假设：用户技术熟练，知道什么是 WebSocket、Token、Cloudflare 隧道、Relay，也愿意自己部署服务器（方案 §14.1 有「部署到我的服务器」）。因此界面可以使用这些名词，但仍应把它们翻译成用户目标（「手机连接码」「临时公网地址」）。
- 假设：单用户、单台 Mac、自用。没有多人、多设备账户体系（`FRONTEND-REWRITE-PLAN.md` §1 明确不做设备管理、账户系统）。
- 假设：界面语言为简体中文；开发者本人是中文使用者（现有全部文案为简体中文）。

## Product Purpose

- 做什么：Mac 助手是本机常驻的菜单栏 App。它在 Mac 上托管 Agent 进程，并把它们交给 iOS 客户端访问。依据：`macos/README.md`。
- **产品范围（事实）**：Mac 助手同时管理两类本地服务，二者共用同一个 App、同一个窗口：
  1. **Pi Remote Relay 连接**：Mac 上的 Agent 通过「服务器模式」连接已部署的 Relay（默认 `wss://pi.anyyu.cyou/ws/agent`，可自建），或通过「Cloudflare 模式」在本机启动 Relay 并用 Quick Tunnel 暴露临时公网地址。含方案 §14 的一键部署 Relay 与 pi / omp 运行时选择。依据：`macos/README.md`、`FRONTEND-REWRITE-PLAN.md` §14。
  2. **Claude 本地服务**：管理本机的 Claude daemon（默认 `127.0.0.1:8788`），有两种模式：**本机**（仅回环地址）和 **Cloudflare 临时隧道**（额外拉起独立的 Quick Tunnel，拿到并验证 `https://*.trycloudflare.com` 地址）。依据：`macos/Sources/PiRemoteCore/ClaudeService.swift`（`ClaudeServiceMode.local / .cloudflare`）、`Services/ClaudeServiceController.swift`。撰写本文时，`Views/` 下尚无 Claude 相关界面，界面由并行任务实现中；本文只记录已存在的服务事实。
- 成功的样子：用户打开窗口，一眼知道「现在能不能用手机连」「还差哪一步」「出错了去哪处理」。状态必须是真实的：二维码只在健康检查确认当前设备后才出现，失效立即撤下。依据：`FRONTEND-REWRITE-PLAN.md` §1、§5.5、§6。
- 假设：对 Claude 服务，同样的「状态必须真实」原则适用——只有 daemon 健康检查通过（隧道模式还要公网健康检查通过）才显示可用。依据来自控制器里的 `checkHealth` / `checkPublicHealth` 流程，但界面呈现仍待确定。

## Positioning

- 机制（事实）：Agent 跑在用户自己的 Mac 上，代码和密钥不离开本机；手机只通过 Relay 或临时隧道与之通信。临时隧道模式无需 Cloudflare 账户、无需自建服务器。依据：`macos/README.md` Cloudflare 模式一节。
- 不可被邻近产品照搬的点：它是**同一个本机进程监督者**，既管 Relay 连接又管 Claude daemon；子进程通过 `runtime-supervisor.mjs` 启动，停止时只对自己的进程组发信号，端口被占用时直接报错而不去结束占用端口的进程（`ClaudeServiceController.swift`：「不会停止占用端口的进程」）。
- 假设：定位是「自托管、自用、可审计」而不是面向大众的托管服务；不与云端 Agent 产品比功能数量。

## Operating Context

- 菜单栏常驻，窗口按需打开；关闭窗口只隐藏，退出（菜单或 Cmd+Q）才停止所有受管进程并等待清理。依据：`macos/README.md`。
- 窗口布局：左配置栏、右状态与扫码舞台、底部折叠诊断。默认内容区 1040 × 720 pt，最小 900 × 640 pt。依据：`FRONTEND-REWRITE-PLAN.md` §4。
- 构建与验证：`./macos/build.sh`、`./macos/verify.sh`；产物是 arm64、ad-hoc 签名的 `.app`，约 267 MB（随包 node 与 cloudflared）。依据：`macos/README.md`。
- 配置存储：`~/Library/Application Support/Pi Remote/config.json`（0600）；服务器模式 Token 在系统钥匙串（`com.piremote.mac`）；Cloudflare 模式 Token 随机生成、只在内存。Claude 配置在 `claude-config.json`，不持久化公网地址或 Token。依据：`macos/README.md`、`ClaudeService.swift`。
- 假设：模式属于 **Operate**（操作类工具界面）——任务是配置、启动、监视、排错，不是浏览内容或品牌展示。设计应服从状态清晰、操作可达、可重复使用，而不是视觉表演。
- 假设：窗口常在多个应用之间被短暂切入；用户通常不会长时间盯着它。

## Capabilities and Constraints

- 保留：macOS 13 最低版本、SwiftPM、现有 `config.json` 字段与 `deviceId`、Keychain、Node Agent、Relay 协议、进程生命周期与自动恢复语义。依据：`FRONTEND-REWRITE-PLAN.md` §2、§13。
- 二维码内容是 `{"version":1,"serverUrl":"wss://<host>/ws/ios","token":"..."}`，含访问凭据：不得截图传播、不得做保存 / 分享按钮；屏幕上要始终标注「仅供自己的设备使用」。依据：`macos/README.md`、`PairingCodeView.swift`。
- 不得杜撰：手机在线 / 已配对、设备数、延迟、进度百分比。Mac 助手目前拿不到手机侧状态，只能说「可供手机连接」。依据：`FRONTEND-REWRITE-PLAN.md` §2、§6。
- 不自动杀进程：不得为「修复端口占用」去结束其他进程；旧 `com.piremote.agent` launchd 服务只允许用户手动接管。依据：`macos/README.md`、`ClaudeServiceController.swift`。
- 动画限制：必须由真实状态触发；支持「减弱动态效果」；窗口不可见时暂停循环动画；macOS 13 上不使用 macOS 14+ 动画 API。依据：`FRONTEND-REWRITE-PLAN.md` §7。
- 本机构建限制：`impeccable detect` / `live` 只支持网页，不适用本项目；视觉验收需通过实际渲染截图或真实窗口检查。
- Claude 服务（已实现，依据代码）：
  - 与 Relay 连接并列，顶栏「Pi Remote / Claude」切换；菜单栏两组分别显示状态和启停。依据：`ContentView.swift`、`MenuBarView.swift`。
  - 「仅本机」模式后端只监听 `127.0.0.1`（`BRIDGE_HOST`），手机无法直接连接，因此不显示连接码。依据：`PiRemoteCore/ClaudeService.swift` 的 `claudeJob`。
  - 「临时隧道」模式的配对码是 `claude-remote://setup?v=1&token=…&bases=…`，供 Claude Remote 手机端扫码，与 Relay 的 JSON 二维码不同；凭据只进二维码，复制地址不含凭据。依据：`ClaudePairInfo.setupLink`、claude-remote `app/src/lib/pairing.js`。
- 未决：「仅本机」模式的长期用途（假设：本机调试；仓库中未说明）。

## Brand Commitments

- 名称：**Pi Remote**。标志是圆润的 π 加一个独立的连接圆点，主色深绿 `#216B52`，浅色 `#F7F8F5`，字标 `#202522`；使用时保持比例，不拉伸、不移动独立圆点。依据：`assets/branding/README.md`。
- 视觉方向：暖白与深绿的原生桌面连接台，沿用 π 标志。依据：`macos/FRONTEND-REWRITE-PLAN.md` §1。具体 token 见 DESIGN.md，不在此重复。
- 语气（假设）：简体中文、直接、克制、用动词说明下一步（「连接」「断开连接」「查看诊断」）；错误只说有依据的原因，不推断（例如健康检查超时不说成「Token 错误」）；不用感叹号、不用拟人化吉祥物式文案。依据来自现有文案与 `FRONTEND-REWRITE-PLAN.md` §6 的错误措辞规则，「克制」这一整体评价为推断。

## Evidence on Hand

- 文档：根 `README.md`、`macos/README.md`、`macos/FRONTEND-REWRITE-PLAN.md`、`ios/DESIGN-SPEC.md`、`ios/CONNECTING.md`、`assets/branding/README.md`。
- 资源：`assets/branding/` 下的 Logo、标志、应用图标（SVG / PNG）。
- 测试：`macos/verify.sh` 覆盖 40 项 Swift 单元测试、supervisor 生命周期、产物校验。依据：`macos/README.md`。
- 基线截图：上一轮改动前的界面快照在 `/tmp/pi-remote-baseline/`（临时目录，可能被清理）。
- 缺失（不得捏造）：真机扫码验收记录、真实用户访谈、使用数据、竞品对比、客户或评价。

## Product Principles

1. **状态真实优先于状态好看。** 任何「已连接」「可扫码」的表现，必须来自真实的健康检查结果；失效即刻撤下，不用动画掩饰。
2. **凭据不出屏。** 二维码和 Token 永不出现在日志导出、复制地址、预览截图里；展示用夹具只用测试凭据并标注「演示」。
3. **不替用户做危险决定。** 不自动结束他人进程、不自动抢占已有 Agent、不静默换端口；需要时给出原因和手动处理建议。
4. **一个窗口，两类服务，同一套语言。** Relay 连接与 Claude 本地服务共享状态词汇、按钮层级和诊断入口，不为每类服务另起一套界面习惯。（假设：这是对「Mac 助手同时管理两者」的合理推论，用户未明确确认。）
5. **常驻工具，安静为先。** 稳定状态下画面静止，打扰只留给需要用户行动的时刻。

## Accessibility & Inclusion

- 事实（来自方案 §7、§9，已在代码中体现）：支持「减弱动态效果」（`Motion.resolved`）、深浅色、键盘焦点环（`focusRing`）、VoiceOver 标签（例如二维码标签「手机连接二维码，包含连接凭据」，状态徽标「状态：…」）。
- 方案要求但需另行核实实现：普通文字对比度 ≥ 4.5:1，大字与关键控件图形 ≥ 3:1；增加对比度与减少透明度模式适配。
- 状态与错误不得只靠颜色表达，需配图标与文字。
- 假设：用户主要使用简体中文；没有额外的本地化或无障碍法规要求。
