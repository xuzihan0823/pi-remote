# pi-remote 开发进度

更新时间：2026-10-08

## 2026-10-08：《Pi Remote 修复顺序》第一、二阶段

本条为本次新增进度；后续旧章节保留原有历史记录，不代表本次重新验收了安装器、服务器或其他前端功能。

- [x] 第一阶段 1.1：模型切换绑定连接/会话/请求，换会话、断线、重连作废旧操作，A→B→A 旧响应不解除新操作。
- [x] 第一阶段 1.2：模型查询序号与连接保护，切换作废先前查询；失败、超时和缺少确认时重新查询真实模型，未确认前不发送。
- [x] 第一阶段 1.3：切换及发送等待期间禁止发送；只有成功确认且草稿未被编辑才清空；明确拒绝及未知投递保留草稿，不自动重发；退页/换会话的晚到确认不清空新草稿。
- [x] 第二阶段：恢复协调器支持指定模型，身份与唯一实例验证之后应用；保存请求模型及一次性结果，旧版等待和新版/重连查询一致；不同模型请求返回冲突；模型失败保留真实 ID 和草稿，应用中重启报告 unknown、不重放切换。
- [ ] 第三至第五阶段：后台无 Terminal 续接、子 agent 模型隔离、前端定点收尾与最终联合验收，未纳入本次实施。

验证结果：`npm run typecheck` 通过；`npm test` 219 项，218 通过、1 项 live RPC 按预设跳过、0 失败。首次与 iOS 构建并行时既有心跳测试失败，单项及无并行构建的全量复跑通过，未改无关心跳逻辑。Swift `SessionCreationTests`（含新增模型/草稿/恢复回归）和 `TerminalCallbackGuardTests` 通过，iOS Debug 模拟器构建通过。新增真实本地 socket、桥接扩展与生产权限守卫验证；运行时为隔离模拟，不冒充真机或真实 OMP 验收。

交付边界：只完成源码、协议文档和自动化验证。未安装到 iPhone，未重新打包或重启运行中的 Mac 助手，未部署 Relay，未控制用户真实工作会话。模拟器构建产物位于 `/tmp/pi-remote-model-fix-build/Build/Products/Debug-iphonesimulator/PiRemote.app`。

方案中的逐项进度已同步至桌面 `Pi Remote 修复顺序.md`；恢复模型的请求、状态与冲突规则详见 [模型选择契约](docs/model-selection.md)。

## 1. 项目目标

开发一款 iOS 客户端，用于远程控制用户本地运行的 pi（Pi coding agent）进程。

当前推荐部署模型：

- 每位用户在自己的 Linux 服务器上安装 Relay 服务端。
- 用户本地的 pi 进程通过 Agent WebSocket 连接 Relay。
- iOS 通过 HTTPS/WSS 连接 Relay，查看会话、发送 prompt、接收流式事件、终止会话。
- 东京服务器仅用于试验和联调，不作为所有用户的永久共享中转节点。
- Cloudflare Tunnel 可作为无公网 IP 用户的后续可选方案，当前不纳入安装器主路径。

## 2. 已完成内容

### 2.1 Relay 核心服务

目录：`/Users/mac/Desktop/pi-remote/src`

已具备：

- iOS 客户端连接与请求路由。
- Agent WebSocket 连接、身份认证和单 Agent 连接约束。
- Agent hello 握手。
- `session.list`、`session.start`、`session.prompt`、`session.abort` 等会话控制。
- JSONL pi RPC 进程管理。
- 会话输出、生命周期事件和错误事件转发。
- 心跳、超时、断线和 in-flight 请求失败处理。
- `/api/health` 公共健康检查。
- 其他状态接口和 WebSocket 使用 Relay Token 认证。
- 配置项校验，包括 Token、Relay URL、Agent Token、设备 ID、端口、工作区、最大会话数等。

### 2.2 服务端安装器

文件：`/Users/mac/Desktop/pi-remote/scripts/install-server.sh`

已实现：

- `--domain`、`--mode`、`--install-dir`、`--port`、`--proxy-network`、`--dry-run`、`--help` 参数。
- `standalone` 模式：Relay + Caddy，Caddy 占用 80/443 并自动管理证书。
- `external-proxy` 模式：仅部署 Relay，支持宿主机端口反代或外部 Docker 网络反代。
- 受管目录标记：`.pi-remote-managed`，内容必须为 `pi-remote-installer-v1`。
- 拒绝非受管目录、路径符号链接和明显不安全的目标路径。
- 首次安装随机生成 `RELAY_TOKEN`；升级时保留已有 Token，不在终端打印 Token。
- 升级前备份安装目录，生成 SHA256 校验文件。
- 构建失败时停止安装；Compose 启动失败、健康检查失败时尝试回滚。其他写入失败的回滚覆盖仍待补齐。
- Docker 构建上下文排除 `.env`、`.env.*`、`node_modules`、`.git` 等内容。

相关部署文件：

- `deploy/docker-compose.standalone.yml`
- `deploy/docker-compose.external-proxy.yml`
- `deploy/docker-compose.external-proxy-network.yml`
- `deploy/Caddyfile.standalone`
- `deploy/README.md`

### 2.3 服务端预检库

文件：`/Users/mac/Desktop/pi-remote/scripts/lib/server-preflight.sh`

已实现：

- source 时不自动执行。
- FQDN、模式、端口校验。
- 绝对安装目录和受管标记校验。
- 路径符号链接检查。
- Linux 发行版与 CPU 架构检查。
- Docker、Compose 插件及 Docker daemon 检查。
- standalone 80/443 端口冲突检查。
- external-proxy 指定端口冲突检查。
- 外部 Docker 网络存在性检查。
- 已有 pi-remote Compose 容器归属识别。
- 检查失败只输出指导信息，不自动安装软件或修改系统。

### 2.4 测试

测试文件：

- `tests/server-install.test.ts`
- `tests/server-preflight.test.ts`
- 其他 Relay、协议、Agent、Pi RPC 测试。

当前本地验证结果（安装流程使用 Docker 桩及临时脚本副本，不等同于真实 Linux/Docker 集成验证）：

```text
npm run typecheck       通过
npm test                92 pass, 1 skipped, 0 fail
```

测试共 93 个，其中 1 个 live pi 测试按预设跳过。

2026-09-16 已复跑上述检查，结果不变；另在隔离 Debian 12 / arm64 / Docker 29.8.1 环境完成 external-proxy 首装、升级和失败场景演练，并用原始 Swift 客户端接入真实 Relay 复核事件行为。确认 10 个待修问题，详见 [复核记录](REVIEW.md)。

## 3. 当前代码状态

最近一次本地验证前，已针对安装器做了直接收尾修改：

- 缺少预检库或缺少 `preflight_check` 时直接失败，不再 fallback 绕过安全检查。
- 安装脚本设置 `umask 077`。
- 备份默认位置调整为 `/var/backups/pi-remote`。
- 备份文件使用临时唯一名称，并校验旧备份路径位于备份目录命名空间内。
- 升级时无效或缺失 Token 不再静默轮换。
- Docker 镜像 rollback tag 失败时不再静默吞错。
- 健康检查改为容器内 Node `fetch`，访问 Relay 容器内部固定端口 8789，并使用超时和 `/api/health` JSON 状态判断。
- Compose 启动使用 `--remove-orphans`。
- 预检在生产安装中要求 Linux、支持发行版、支持架构及 Docker daemon。
- 测试在临时 fixture 中运行安装器，避免 macOS 的 `/var/folders` 系统符号链接影响生产安全规则。

## 4. 已验证但尚未完成的事项

### 4.1 东京服务器没有执行实际安装

曾经通过 SSH 向东京服务器上传临时打包文件，并仅执行了 `--dry-run`。

结果：安装器正确拒绝当前 `/opt/pi-remote`，因为该目录存在但没有 `.pi-remote-managed` 标记：

```text
错误: 目标目录 '/opt/pi-remote' 已存在且非空，但未包含受管标记文件 (.pi-remote-managed)，拒绝覆盖。
```

这意味着：

- 没有删除或覆盖东京服务器现有 `/opt/pi-remote`。
- 没有执行真实安装、Docker build、Compose up 或服务切换。
- 东京服务器现有项目仍需人工确认，不能直接由当前安装器接管。
- 远程命令因预检失败提前退出，末尾清理未执行；`/tmp/pi-remote-installer-check` 和 `/tmp/pi-remote-installer.tgz` 可能仍存在，待核实后仅清理本次临时产物。

### 4.2 东京服务器后续处理

如需部署，需要先确认现有 `/opt/pi-remote` 是否属于当前项目：

1. 查看现有目录内容、Compose 配置、容器标签和运行状态。
2. 如果是旧项目且允许迁移：先按服务器规范创建并验证项目备份，再决定迁移方式。
3. 如果不是本项目：改用新的安全安装目录，例如 `/opt/pi-remote-v2`，并使用外部代理模式避免端口冲突。
4. 未得到明确授权前，不删除、覆盖或停止现有项目。

## 5. 当前主要风险 / 待办

### 高优先级

- [x] 完成 `scripts/install-server.sh` 最终人工复核（2026-09-16，详见 [复核记录](REVIEW.md)）：
  - 回滚遗漏新增隐藏文件，待修。
  - 备份解包失败明确返回非零；镜像恢复失败被忽略，待修。
  - 正常升级的项目与工作目录识别通过；端口占用豁免过宽，待修。
  - external-proxy 自定义宿主机映射与容器内固定 8789 健康检查契约一致。
  - Debian 12 / Bash 5.2.15 运行通过，其他生产环境尚未实测。
- [x] 在隔离 Linux + Docker 环境执行真实安装演练，覆盖 external-proxy 非网络模式的首装、升级和失败恢复；其他部署模式仍待验证。
- [ ] 修复复核确认的安装器问题：目标内部符号链接越界写入、复制失败未回滚、旧镜像恢复错误被忽略、隐藏文件残留及无关端口占用通过预检。
- [ ] 修复 iOS 重连后订阅丢失、流式输出期间停止按钮失效，以及列表状态、输入对话框和 Agent 在线状态错误。
- [x] 源码及隔离 Linux 真实容器探测均确认 Relay 健康状态包含 `status: "ok"`（`src/relay/server.ts`）。
- [ ] 增加 Agent 端安装/启动脚本，让用户可配置：
  - Relay URL
  - Agent Token
  - Agent Device ID
  - pi 二进制路径
  - 工作区路径
  - 最大会话数
- [x] 确定 iOS 工程技术栈和最低版本：SwiftUI，工程位于 `ios/PiRemote.xcodeproj`；当前 Swift 语言模式为 5.0，最低 iOS 26.0，本次使用 Xcode 27.0 / iOS 27.0 SDK 构建。

### 中优先级

- [ ] iOS MVP：服务器配置、Token/设备配对、会话列表、会话详情、prompt 输入、流式输出、停止按钮、断线重连。
  - 已实现：服务器配置（Relay URL + Token）、会话列表（`session.list`）、会话详情（`subscribe` + `session_event` 流式渲染）、prompt 输入（`session.prompt`）、停止按钮（`session.abort`）、断线重连、`ui_request` 确认弹层（`ui.response`）。
  - 已接入相机扫码、连接二维码解析和确认表单；帮助使用独立教程页，次级入口更名为「手动连接」。二维码导入规范见 [ios/CONNECTING.md](ios/CONNECTING.md)。
  - 未实现：Mac 端二维码生成界面、短配对码兑换、设备撤销机制；`session.start` 的项目选择仍是手填相对路径。
- [ ] iOS 安全存储：Keychain 保存 Relay URL/Token/Agent Token，避免明文 UserDefaults。
- [ ] 增加配对流程和设备撤销机制。
- [x] 校准部署文档：发行版范围与预检一致，移除原子回滚及日志保留承诺，明确备份不包含 Docker 命名卷，并记录实际验收范围。
- [ ] 增加日志脱敏检查，确保 Token、环境变量和命令输出不泄漏。
- [ ] 增加版本升级/迁移策略。

### 低优先级

- [ ] Cloudflare Tunnel 可选安装与文档。
- [ ] 多 Agent / 多设备管理。
- [ ] 会话历史持久化。
- [ ] 推送通知。
- [ ] 细粒度权限与审计日志。

## 6. 关键安全约束

- 不允许安装器把非受管目录当作自己的目录覆盖。
- 不允许通过符号链接路径写入未知位置。
- 不允许自动安装 Docker、修改系统软件源或自动修改已有反代配置。
- 不允许在日志中打印 Relay Token、Agent Token 或完整环境变量。
- 升级前必须完成并验证新备份，再清理旧备份。
- 真实部署到服务器前必须先确认目标项目，并按服务器规范备份当前项目。
- 未经明确授权，不执行删除数据、强制覆盖、停止现有生产容器等不可逆操作。

## 7. 当前结论

Relay MVP、服务端 Docker 部署文件、安装器和预检库已有实现，本地类型检查及自动化测试通过。安装器人工复核及隔离 Linux 演练已完成，确认的失败恢复和写入边界问题仍待修复，尚未通过生产部署验收。

下一步先修复 [复核记录](REVIEW.md) 中的问题，再安排部署验收。iOS 客户端已通过 Xcode 27.0 真机签名构建，但重连、停止和会话状态行为仍有缺陷；安全存储（Keychain）、配对流程与真实模型联调继续保留为待办。

## 8. Xcode 与真机安装（2026-09-16）

- Xcode 已升级为 27.0，而原许可记录停留在 26.4，导致 `xcrun` 和构建被阻止。用户完成 `sudo xcodebuild -license` 与 `sudo xcodebuild -runFirstLaunch` 后已恢复。
- 工程 Debug / Release 已配置可用开发团队，使用工程自身配置的 Debug iphoneos 构建通过。
- App `com.piremote.app` 已安装到用户的 iPhone 17（iOS 27.0），本地代码签名及设备授权校验通过。用户已完成开发者信任；2026-09-17 USB 连接恢复后，修复版安装和启动成功，并通过真机截图确认首页正常显示。
- 当前开发描述文件有效期至 2026-09-23 19:30（北京时间），到期后需要重新构建安装。
- 按用户要求采用真机安装；未安装 App 到模拟器，也未启动模拟器。本轮创建的临时模拟设备已删除。

## 9. 扫码与帮助入口修复（2026-09-16）

- 「扫码连接 Mac」使用 VisionKit 相机扫码器，仅识别 QR 码；补齐相机用途声明、权限拒绝/受限提示、设置跳转和手动连接入口。
- 识别有效连接二维码后预填确认表单，确认前不联网；普通二维码或非法凭据继续显示识别提示。退出、后台或识别成功时停止扫描。
- 「帮助」打开独立教程占位页；手动配置入口更名为「手动连接」。
- 解析回归检查覆盖有效 TLS/LAN/IPv6 地址、保留本机名称、无关/非法二维码、版本、端口、端点和凭据校验。真机签名构建通过；2026-09-17 已通过 USB 安装修复版并启动，截图确认首页显示「手动连接」。相机授权、实际扫码及帮助页交互仍待手机端验证。
- 本次安装及启动记录：`/tmp/pi-remote-scanner-install-latest.json`、`/tmp/pi-remote-scanner-launch-foreground.json`；首页截图：`/tmp/pi-remote-scanner-foreground.png`。未安装或启动模拟器。
