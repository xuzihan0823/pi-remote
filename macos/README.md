# Pi Remote · macOS 客户端

本机运行的菜单栏常驻 App：在 Mac 上托管 pi Agent，让 iOS 客户端通过 Relay（服务器模式）或临时公网地址（Cloudflare 模式）连接。

## 构建

```sh
./macos/build.sh          # 产出 macos/dist/Pi Remote.app
./macos/verify.sh         # 单元测试 + supervisor 生命周期验证 + 构建与产物校验
PI_REMOTE_SKIP_BUILD=1 ./macos/verify.sh   # 只跑测试
```

构建产物为 arm64、ad-hoc 签名的标准 `.app`，不依赖 Apple 开发者账号，也不需要联网。`macos/dist/` 已被仓库根 `.gitignore` 忽略。

构建脚本会做这些事：

- `swift build -c release` 构建 SwiftPM 包（`PiRemoteCore` 纯逻辑 + `PiRemote` 可执行）。
- 用 `assets/branding/pi-remote-app-icon.png`（1024×1024，与用户 `.fig` 的 App icon 节点一致：底色 `#216B52`、图形 `#F7F8F5`）通过 `sips`+`iconutil` 生成 `AppIcon.icns`。
- 复制运行时到 `Contents/Resources/runtime/`：`/usr/local/bin/node`、`/opt/homebrew/bin/cloudflared`、仓库 `src/`、`package.json`、`node_modules/ws`、`runtime-supervisor.mjs`。
- 复制前用 `lipo` 核对 node/cloudflared 含 arm64；不复制 `.env`、凭据或开发依赖（复制后还会断言运行时目录没有 `.env`/`*.pem`/`*.key`）。
- 对 App 与嵌套二进制做 ad-hoc 签名（已有有效签名的 node/cloudflared 不重新签名）。

`runtime/` 中只有 `node_modules/ws`（`src` 唯一运行时依赖），没有 TypeScript 等开发依赖。node 24 直接运行 `.ts`（类型剥离），因此不需要编译步骤。

## 使用

左侧选择连接方式并填写配置，右侧显示二维码与状态。关闭窗口只会隐藏窗口，App 继续留在菜单栏；从菜单栏「退出」或 Cmd+Q 退出时会停止所有受管进程。

### 服务器模式（默认）

- 服务器地址默认 `wss://pi.anyyu.cyou/ws/agent`，可改成自建 Relay。
- 连接 Token 至少 32 个字符，与手机扫码使用的是同一个 Token；保存在系统钥匙串（`com.piremote.mac`）。
- 工作区与 `PI_BIN` 传给 Agent；`PI_BIN` 可以写裸命令名（例如 `pi`），连接前会按 PATH 解析成绝对可执行路径。
- 配置保存到 `~/Library/Application Support/Pi Remote/config.json`（0600）。有效配置存在时，下次启动会自动连接。

### Cloudflare 模式

- 本机启动 Relay（固定 `127.0.0.1:8789`），再用 `cloudflared --no-autoupdate tunnel --config <空配置> --url http://127.0.0.1:8789` 建立 Quick Tunnel，无需 Cloudflare 账户。
- `--config` 指向应用生成的空配置，避免读取用户已有的 `~/.cloudflared/config.yml`。
- 公网地址每次连接都会变化，手机需要重新扫码；Token 由 `SecRandomCopyBytes` 生成 32 字节并只在内存中保留。
- 本地端口被占用时直接报错，不会静默换端口。
- 超时：隧道注册最多 90 秒；拿到公网地址后 Agent 握手与健康检查最多 60 秒（服务器模式为 30 秒）。

### 二维码显示条件

二维码内容为 `{"version":1,"serverUrl":"wss://<host>/ws/ios","token":"..."}`，与 iOS 端 `CONNECTING.md` 的 v1 契约一致。

只有同时满足以下条件才显示：本机 Agent 已与 Relay 完成握手，且 `https://<host>/api/health` 返回 `agentConnected=true` 并且 `agentDeviceId` 等于本 App 的稳定设备号（避免把已有其他 Agent 误判为成功）。健康检查失败会立即隐藏二维码；随后进入「连接恢复中」，保留受管进程让 Agent 自动重连，恢复后重新显示，90 秒内未恢复才清理进程并报错。健康检查始终使用系统 TLS 校验，不关闭验证。

### 旧 launchd 服务接管

启动时会检测 `launchctl print gui/<uid>/com.piremote.agent`。若存在，界面显示「接管旧服务」按钮，点击后只对这一个 label 执行 `bootout` + `disable`（不做泛杀）。退出 App 不会自动恢复它，需要恢复时执行：

```sh
launchctl enable gui/$(id -u)/com.piremote.agent
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.piremote.agent.plist
```

### .env 导入

「导入 .env 文件…」打开的文件面板会显示隐藏文件。只读取 `RELAY_URL`、`RELAY_TOKEN`、`AGENT_TOKEN`、`PI_BIN`、`PI_WORKSPACE_ROOT` 五个键：不执行 shell（`$(...)`/反引号只当普通字符串），不输出密钥到日志，也不把文件复制进 App。`PI_BIN` 若是裸命令名会解析成绝对路径，解析不到就保留原值并提示，不会让导入把配置改坏。

## 进程管理

所有受管进程（Agent / 本地 Relay / cloudflared）都通过 `runtime-supervisor.mjs` 启动：

- 子进程在独立进程组中运行，supervisor 转发其 stdout/stderr。
- 停止顺序：先对子进程本身发 `SIGTERM`（Agent 借此关闭 pi 会话），至少等 3 秒（实际 5 秒）后对整个进程组发 `SIGKILL` 兜底。不会向无关进程发信号。
- 触发清理的三种情况：App 关闭 supervisor stdin、supervisor 收到 SIGTERM/SIGINT/SIGHUP、App 被强退（父进程消失，supervisor 通过 ppid 变化与 stdin EOF 检测）。
- 任一关键进程自行退出都会进入错误状态并清理，不会伪装成连接成功。

## 验证

`./macos/verify.sh` 覆盖：

- 40 项 Swift 单元测试：URL/Token 契约（ws/wss、无 userinfo/query/fragment、路径必须是 `/ws/agent` 或 `/ws/ios`、Token ≥32 且无空白）、二维码 v1 载荷与 CoreImage 生成、配置读写与权限、设备号格式、Token 随机性、任务构造（PATH 顺序、cloudflared 参数）、`.env` 解析、PI_BIN 解析、端口探测。
- supervisor 生命周期：作业 JSON 分包写入、取消后子进程与孙进程都被清理、父进程被 SIGKILL 后同样被清理。
- 产物校验：App/主程序/node/cloudflared 均为 arm64、`AppIcon.icns` 存在、`CFBundleIdentifier` 正确、运行时无凭据文件、签名有效。

未覆盖（需真机或联网，由父代理在有授权的环境执行）：真实 GUI 交互、真实公网 Relay 握手与扫码、真机 pi 会话、手机端配对。

## 已知限制

- 应用体积约 267 MB，主要是随包的 node 与 cloudflared。
- Cloudflare 模式每次连接的地址与 Token 都会变，手机需重新扫码。
- 二维码包含访问凭据，不要截图或分享。
- 本里程碑不做会话列表/聊天界面；终端用户操作全部通过手机端完成。
