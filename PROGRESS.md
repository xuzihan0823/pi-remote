# pi-remote 开发进度

更新时间：2026-09-14

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

- [ ] 对 `scripts/install-server.sh` 做一次最终人工 diff review，重点确认：
  - 升级回滚时目录内容删除是否包含隐藏文件。
  - 备份恢复失败时是否明确返回失败。
  - 现有容器项目标签和工作目录识别是否可靠。
  - external-proxy 非网络模式的自定义宿主机端口映射与健康检查契约一致。
  - 生产 Linux 上 Bash 版本兼容性。
- [ ] 在隔离 Linux + Docker 环境执行一次真实安装演练。
- [x] 源码确认 Relay 健康状态包含 `status: "ok"`（`src/relay/server.ts`）；真实容器探测仍待验证。
- [ ] 增加 Agent 端安装/启动脚本，让用户可配置：
  - Relay URL
  - Agent Token
  - Agent Device ID
  - pi 二进制路径
  - 工作区路径
  - 最大会话数
- [ ] 确定 iOS 工程技术栈和最低 iOS 版本。

### 中优先级

- [ ] iOS MVP：服务器配置、Token/设备配对、会话列表、会话详情、prompt 输入、流式输出、停止按钮、断线重连。
- [ ] iOS 安全存储：Keychain 保存 Relay URL/Token/Agent Token，避免明文 UserDefaults。
- [ ] 增加配对流程和设备撤销机制。
- [ ] 校准现有部署文档：发行版范围应与预检一致，仅列 Ubuntu、Debian、Rocky Linux、AlmaLinux、Fedora；移除未经验证的原子回滚承诺。
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

Relay MVP、服务端 Docker 部署文件、安装器和预检库已有实现，本地类型检查及自动化测试通过。安装器仍有安全边界待复核，尚不能视为已通过生产部署验收。

下一步不应直接在东京服务器上强行安装；应先完成东京现有 `/opt/pi-remote` 的只读识别，或选择新的隔离安装目录，再进行备份、安装和联调。iOS 客户端仍未开始实现，后续应先固定协议与配置/配对流程，再建立 Xcode 工程。
