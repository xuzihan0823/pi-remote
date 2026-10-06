# 东京公网 Relay 部署说明

本文档只覆盖东京服务器上 `pi-remote-relay` 的公网部署配置与连通性验证，不改变服务器上其它服务。

## 当前部署状态（2026-09-18）

- 东京服务器：`43.130.228.225`。已更新 `/opt/pi-remote` 和 Relay 容器，镜像 `pi-remote-relay:terminal-bridge-20260918`（同时标记为 `latest`），平台 `linux/amd64`；镜像在 Mac 本地构建后传入服务器，支持终端快照接口 `session.get`。
- 本次更新前的项目备份：`/var/backups/pi-remote/20260918-before-terminal-bridge/project.tar.gz`，已通过 gzip 和 tar 可读性检查。SHA-256：`500d4b83901a4e0f4ce73f64a63f5d4e6bc9e4f7c057bde0b427347cede3402f`。旧的 `20260917-before-stability` 备份在验证新备份后已删除。旧镜像保留为 `pi-remote-relay:before-terminal-bridge`。
- Relay 容器已按本仓库 `deploy/docker-compose.tokyo.yml` 的稳定性配置重建，重建后健康状态为 `healthy`，`restart: unless-stopped` 生效；本次重建没有重启服务器上的其他容器，容器 ID 均未变化。
- Mac App 已更新到 `/Users/mac/Applications/Pi Remote.app` 并重新连接，当前线上 Agent ID 为 `pi-mac-d5c770bc`；旧 launchd Agent 当前未运行。App 配置和钥匙串凭据保持不变。
- 终端桥接扩展已安装到 `~/.pi/agent/extensions/pi-remote-bridge/index.ts`。已有终端需待当前任务结束后执行 `/reload`；未加载扩展的终端不会自动出现在列表中。详见 `docs/terminal-bridge.md`。
- 手机地址：`wss://pi.anyyu.cyou/ws/ios`。本地连接二维码：`/Users/mac/.config/pi-remote/tokyo-connection.png`；配套 JSON 同目录。二维码含连接凭据，仅供自己的手机扫码，不应公开分享。
- 实测通过：公网 TLS、HTTP/WS 无凭据访问返回 401、模拟 iOS 握手、真实 Mac 的 `session.list`，以及 Relay 重启后 Mac 自动重连。
- 本次更新后通过公网 TLS、鉴权、iOS 握手与 `session.list` 检查；`session.get` 对未知会话返回 `unknown_session`，确认新接口已贯通。尚未 reload 的用户终端未注册，线上列表为 0。
- iOS 新版已完成签名真机构建，但手机显示 unavailable，尚未安装本次新版、未完成真机操作验证。协议检查未创建用户会话或调用模型。

在手机 Pi Remote 中选择「扫码连接 Mac」，扫描上述图片并确认即可；Mac 需要保持唤醒且联网。

## 架构

- 服务器用 ssh 别名 `tokyo-server` 登录，项目目录 `/opt/pi-remote`，容器名 `pi-remote-relay`。容器只在宿主机监听 `127.0.0.1:8789`，不直接暴露到公网。
- 公网入口由服务器上已有的反向代理容器 `new-api-caddy` 提供：域名 `https://pi.anyyu.cyou`，内部转发到 `pi-remote-relay:8789`。
- 因为反代按容器名转发，relay 必须加入外部 Docker 网络 `new-api_new-api-net`。此前是靠手工 `docker network connect` 临时挂上的，`deploy/docker-compose.tokyo.yml` 把它写进配置，重建容器后依然生效。
- 该 override 只做三件事：声明镜像来源、把 relay 加入 `default` 与 `new-api_new-api-net`，以及附加本地可靠性配置（healthcheck、`init`、`stop_grace_period`、json-file 日志轮转）。它不部署 Caddy，也不新增任何公网端口。
- 对外的地址：iOS 用 `wss://pi.anyyu.cyou/ws/ios`，Mac Agent 用 `wss://pi.anyyu.cyou/ws/agent`，健康检查 `https://pi.anyyu.cyou/api/health`。

服务器上现有的 Caddy 站点（由 `new-api-caddy` 管理）应包含以下已有配置，**不要覆盖或重写它**：

```caddy
pi.anyyu.cyou {
    encode zstd gzip
    reverse_proxy pi-remote-relay:8789
}
```

## Compose 命令

`deploy/docker-compose.tokyo.yml` 是基础文件 `deploy.docker-compose.yml` 的 override，必须叠加使用：

```bash
cd /opt/pi-remote

# 使用父代理本地构建并导入的镜像，默认 pi-remote-relay:latest
docker compose -f deploy.docker-compose.yml -f deploy/docker-compose.tokyo.yml up -d --no-build --pull never relay

# 需要指定具体镜像标签时用 PI_REMOTE_IMAGE
PI_REMOTE_IMAGE=pi-remote-relay:<tag> \
  docker compose -f deploy.docker-compose.yml -f deploy/docker-compose.tokyo.yml up -d --no-build --pull never relay
```

`--no-build --pull never` 强制使用本地已存在的镜像：服务器不会重新构建，也不会从镜像仓库拉取（镜像由父代理在本地构建后导入）。

部署与排查：

```bash
docker compose -f deploy.docker-compose.yml -f deploy/docker-compose.tokyo.yml ps
docker inspect pi-remote-relay --format '{{json .NetworkSettings.Networks}}'   # 应同时包含 default 与 new-api_new-api-net
docker logs --tail 100 pi-remote-relay                                          # 日志中不含 Token
```

只操作 `relay` 这一个服务，不要执行 `docker compose down`，不要重启或停止服务器上的其他容器（例如 `new-api-caddy` 及其上游服务）。

## 可靠性配置

`deploy/docker-compose.tokyo.yml` 里的可靠性设置只作用于 `relay` 容器，不覆盖基础文件里的任何配置：

- 健康检查：容器内用 node 内建的 `fetch` 请求 `http://127.0.0.1:8789/api/health`，`interval` 30s、`timeout` 5s、`retries` 3、`start_period` 10s。
- `init: true`：用轻量 init 作为 PID 1 负责回收子进程，避免 node 之外残留的僵尸进程。
- `stop_grace_period: 10s`：停止容器时给进程 10 秒正常退出，超时后才发送 SIGKILL。
- 日志轮转：`json-file` 驱动，`max-size=10m`、`max-file=3`，单个容器日志最多约 30MB。

健康检查只是监控，不负责拉起进程。它失败只会把容器标记为 `unhealthy`，不会重启容器；进程真正退出时由基础文件里的 `restart: unless-stopped` 重新拉起。需要按健康状态自动重启的话还要额外的 watch 工具，当前没有引入。

这套配置已在东京服务器上生效：relay 容器重建后健康状态为 `healthy`，其他容器未受影响。

查看健康状态与日志占用：

```bash
# 健康状态：healthy / starting / unhealthy
docker inspect pi-remote-relay --format '{{.State.Health.Status}}'
docker inspect pi-remote-relay --format '{{json .State.Health}}'   # 最近几次检查的退出码

# 容器内手工执行同一条检查（退出码 0 表示健康）
docker exec pi-remote-relay node -e "fetch('http://127.0.0.1:8789/api/health').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"

# 查看健康检查的响应内容（容器内执行）
docker exec pi-remote-relay node -e "fetch('http://127.0.0.1:8789/api/health').then(async (r) => console.log(r.status, await r.text()))"

# 日志驱动与轮转参数
docker inspect pi-remote-relay --format '{{json .HostConfig.LogConfig}}'
```

排障时只针对 `relay` 操作：`docker restart pi-remote-relay` 或重新执行上面的 `up -d relay`。不要对其他容器执行 `down`/`stop`/`restart`，也不要用 `docker compose down`（它会连项目里其他服务一起处理，且可能删掉网络）。

## Token 与 .env

- `RELAY_TOKEN` 用 `openssl rand -hex 32` 生成，写入服务器 `/opt/pi-remote/.env`（权限 0600）以及 Mac 本地仓库根目录的 `.env`（已被 `.gitignore` 忽略）。
- 不要把 Token 提交到仓库、写进文档、贴到聊天或日志里。本文档不记录任何真实凭据。
- Mac 本地 `.env` 关键项（值自行填写）：

```
RELAY_URL=wss://pi.anyyu.cyou/ws/agent
RELAY_TOKEN=<与服务器一致的 token>
AGENT_TOKEN=<与服务器一致的 token>
AGENT_DEVICE_ID=pi-mac-agent
PI_BIN=pi
PI_WORKSPACE_ROOT=<Mac 上作为会话工作区的绝对路径>
```

`RELAY_URL` 里不允许携带任何凭据：userinfo、查询串、fragment 都会被配置与检查脚本拒绝，凭据只能通过环境变量传入。

## Mac 启动

```bash
cd <pi-remote 仓库目录>
npm install
npm run agent
```

Agent 会连接 `wss://pi.anyyu.cyou/ws/agent`，断线后自动指数退避重连，自身不会启动会话。

### 常驻运行（launchd 模板）

`deploy/macos-agent.plist.example` 是给当前 Mac 用的 launchd 常驻模板，**只是示例，不会被自动安装**。它固定了 `Label com.piremote.agent`、`RunAtLoad`/`KeepAlive` 为 true、`ThrottleInterval` 10 秒、工作目录为本仓库、参数为绝对路径的 node + `--env-file=.env` + `src/agent/run.ts`，PATH 含 `/usr/local/bin`、`/opt/homebrew/bin` 与系统默认目录，日志写入 `~/Library/Logs/PiRemote/agent.log` 与 `agent-error.log`。模板不含任何 Token；`.env` 由父代理准备，模板不读取也不写入它。

按需手动使用：

```bash
mkdir -p ~/Library/LaunchAgents ~/Library/Logs/PiRemote
cp deploy/macos-agent.plist.example ~/Library/LaunchAgents/com.piremote.agent.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.piremote.agent.plist

# 停止并卸载
launchctl bootout gui/$(id -u)/com.piremote.agent
```

如需修改 node 路径或工作目录，请先编辑复制后的 plist；本仓库模板中的 node 路径已用 `command -v node` 在本机核实为 `/usr/local/bin/node`。

## 无模型连通性验证

```bash
cd <pi-remote 仓库目录>
# RELAY_URL 与 RELAY_TOKEN 从本地 .env 读取，Token 不出现在命令行或 shell 历史里
node --env-file=.env scripts/check-relay.ts
```

脚本依次验证：TLS 证书校验（默认不跳过）、`/api/health`、无凭据请求被拒绝、`/ws/ios` WebSocket 握手、`session.list` 确认 Mac Agent 在线。无凭据的 WebSocket 必须收到明确的 `HTTP 401` 才算通过，其他连接异常（TLS 失败、超时、非 401 状态码等）都按失败处理；`session.list` 的响应还必须与请求 ID 对应。它只调用 `session.list`，不会创建会话或调用模型；不会打印 Token。任一步失败都以非 0 退出并打印原因；整体超时（默认 15000ms，可用 `RELAY_TIMEOUT_MS` 或 `--timeout-ms` 调整）同样非 0 退出。Agent 离线时 `session.list` 会返回 `no_agent_connected`，脚本按失败处理，不会误报成功。

`RELAY_URL` 不允许携带 userinfo、查询串或 fragment，凭据一律通过 `RELAY_TOKEN` 环境变量传入。

可选参数：

- `--insecure`：跳过 TLS 证书校验，仅在自签证书或临时域名时使用，默认关闭。
- `--help`：查看用法。

手工补充确认（可选）：

```bash
curl -sS https://pi.anyyu.cyou/api/health
```

### 为什么没有 `--probe-session`

Relay 协议目前支持 `subscribe`、`unsubscribe`、`session.list`、`session.start`、`session.get`、`session.prompt`、`session.abort`、`ui.response`（见 `src/protocol/relay-types.ts`）。`session.get` 用于终端快照，仍没有 `session.stop`/`close` 之类的会话关闭接口：`session.abort` 只会中止当前回合，不会结束 `pi` 进程。因此无法保证探测创建的测试会话被清理，按约定不提供该选项，只保留默认的只读检查。

## 部署注意事项

- 服务器上运行着其他生产服务。父代理会在部署前先备份 `/opt/pi-remote` 再执行变更；本次交付只涉及 `relay` 容器与其网络接入。
- 反代配置已存在于 `new-api-caddy`，本仓库的 override 不会触碰它；如需修改反代，请在服务器上单独确认，不要用本仓库文件覆盖现有 Caddy 配置。
