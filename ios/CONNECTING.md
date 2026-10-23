# iOS 连接与构建

首页「扫码连接 Mac」打开系统相机扫码器；首次使用请求相机权限。识别成功后先关闭相机，再显示「确认连接」表单，用户确认后才连接 Relay。「手动连接」打开原有配置表单；「帮助」打开独立教程占位页。

拒绝相机权限后可跳转 App 设置，或使用手动连接。离开扫码页、切到后台或识别成功后停止扫描，回到前台重新检查相机权限。

## 连接二维码 v1

二维码内容为 UTF-8 JSON：

```json
{
  "version": 1,
  "serverUrl": "wss://relay.example.com/ws/ios",
  "token": "replace-with-your-relay-token-at-least-32-characters"
}
```

- `serverUrl` 使用 `ws` 或 `wss`，必须包含主机，路径为 `/ws/ios`；端口若指定需为 1–65535。不得包含用户信息、查询参数、片段、空白或控制字符。公网部署使用 `wss`。
- `token` 为现有 Relay Token，至少 32 个 UTF-16 代码单元，与服务端长度规则一致；不得包含空白或控制字符。
- `version` 必须为 `1`，整个载荷最多 4096 字节。设备名称保留手机原有设置，不从二维码导入。
- 普通网页二维码、非法地址、无效凭据不触发连接，扫码页会显示提示并继续扫描。扫描及解析过程不记录二维码原文或 Token。

这是现有 Relay 凭据的导入格式。Mac 端二维码生成界面、短配对码兑换和设备撤销机制尚未实现。生成二维码时使用离线工具；二维码包含访问凭据，不应上传到在线二维码服务或公开分享。

## 终端会话接入

手机可以看到 Mac 上正在运行的终端 pi 会话，并继续输入、停止任务。这是与受管会话（session.start 创建）并列的第二种来源。

协议约定：`session.list` 的每条会话在原有字段基础上增加 `source`（`managed` | `terminal`）、`title`、`cwd`（可选）和 `activity`（`busy` | `idle` | `unknown`）。`state=running` 只表示进程存活，手机端的「进行中」计数与筛选只认 `activity=busy` 或明确等待回应，`idle` 不算运行；缺少 `activity` 的旧 server 归为 `unknown`，不会误报忙。

终端会话 id 形如 `terminal:<uuid>`。真实终端连接由 Mac 上的 pi 扩展在首次运行或 reload 时注册；尚未注册的终端会话不会在手机上伪造，读取时会返回明确错误。因此：**Mac 侧需要先安装/加载扩展，改动后 reload，终端才会出现在列表里**。runtime 与终端对同一 session 保留单 writer，不要用受管方式再启动一份。

终端会话不订阅 `session_event`，只对当前会话按 `session.get` 轮询：手机每 2 秒取一次完整快照，用返回的 user/assistant 消息数组整体替换，不做增量拼接，避免重复；切换会话、断开连接或离开会话页都会取消轮询并用 generation 校验丢弃过期回调，重连后自动恢复。`session.get` 单次最多返回 100 条、256 KiB 文本，正在生成的 assistant partial 在末尾出现一次；被裁剪时快照带 `truncated=true`。会话列表在连接期间每 4 秒刷新，用于发现新终端和 busy 变化。

`session.get` 失败时手机显示明确错误：未实现（`not_implemented`）或未注册（`unknown_session`）会提示更新扩展或重载；连接失败或快照 `activity=unknown` 视为终端离线，此时禁止继续发送。终端会话的审批仍只发生在 Mac 上，手机不做伪装支持。

## 本地验证

从仓库根目录运行解析回归检查，编译和执行均在 Mac 上完成：

```sh
xcrun swiftc -swift-version 5 \
  ios/PiRemote/Models/Models.swift ios/PiRemote/Models/TimelineModels.swift \
  ios/PiRemote/Models/TransportSecurity.swift ios/PiRemote/Models/ConnectionQRCode.swift \
  ios/Tests/ConnectionQRCodeTests.swift \
  -o /tmp/pi-remote-qr-tests
/tmp/pi-remote-qr-tests
```

会话字段解析、运行判定（idle 不计运行、busy/待回应计运行）与终端快照替换回归检查：

```sh
xcrun swiftc -swift-version 5 \
  ios/PiRemote/Models/Models.swift ios/PiRemote/Models/TimelineModels.swift \
  ios/PiRemote/Models/TransportSecurity.swift ios/Tests/SessionParsingTests.swift \
  -o /tmp/pi-remote-session-tests
/tmp/pi-remote-session-tests
```

Claude 后端客户端纯逻辑（配对码、深链、WS 帧、流式草稿、转录分页定位、搜索映射、审批答案）回归检查：

```sh
xcrun swiftc -swift-version 5 \
  ios/PiRemote/Models/TransportSecurity.swift ios/PiRemote/Models/ClaudeModels.swift \
  ios/Tests/ClaudeModelsTests.swift \
  -o /tmp/pi-remote-claude-tests
/tmp/pi-remote-claude-tests
```

真机签名构建：

```sh
xcodebuild -project ios/PiRemote.xcodeproj -scheme PiRemote \
  -configuration Debug -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/pi-remote-review-device-build \
  -allowProvisioningUpdates build
```

相机画面、权限提示、扫码后确认页、帮助页及前后台切换需要在 iPhone 上验证。Mac 上的解析检查和编译通过不能代替相机实测。

## 无线安装与远程构建

Xcode 在 Mac 上编译和签名。iPhone 首次用 USB 配对并完成信任、开启开发者模式后，可在可达的同一局域网中无线安装和调试。Xcode 27 的设备管理入口为 Xcode → Open Developer Tool → Device Hub；旧版使用 Devices and Simulators。仅在手机确认开发者信任，不会自动建立无线连接；无线可用状态需在设备管理中确认。本次修复版通过 USB 安装和启动，无线安装尚未验证。

外网或移动网络下分发通常使用 TestFlight，需要 Apple Developer Program 及 App Store Connect 配置。真正的远程构建可以在另一台受控 Mac 上运行 `xcodebuild`，或配置 Xcode Cloud；当前项目尚未配置这些服务。

## Claude 后端（第二种后端）

除 Pi Relay 外，App 可以直连 Mac 上的 Claude 后端（`backend/claude`，由 Mac 助手的 Claude 页或 `pi-remote start --service claude` 启动）。连接页点「连接 Claude 后端」，或在设置里「切换到 Claude 后端」；两种后端互斥，切换时断开另一边。

- 配对：扫描或粘贴 `claude-remote://setup?v=1&token=…&bases=…`（也可手动填写 `http://<Tailscale/局域网 IP>:8788` 与 `BRIDGE_TOKEN`）。App 依次探测候选地址的 `/api/health`，第一个鉴权通过的地址生效；地址存 UserDefaults，Token 存 Keychain（`com.piremote.app.claude-token`，仅本机、解锁后可读）。断线重连时会重新探测全部候选地址。
- 传输：明文 `http://`/`ws://` 只允许本机、局域网、`.local`、`*.ts.net` 与 Tailscale `100.64.0.0/10`；公网必须 `https://`/`wss://`。WS 端点为 `/ws?token=…`（daemon 只认查询串 token），HTTP 一律 `Authorization: Bearer`。
- 功能：会话列表（按 `/api/projects` 的项目筛选、分页）、新建会话（显式选择已知工作目录）、会话页（尾页 + 向上翻页、订阅快照、`stream` 草稿在末尾显示并在消息落盘后替换、`resync` 重拉、重连补缺口）、搜索（先标题/路径再全文，正文命中跳转到对应 `seq` 并高亮）、审批（每次连上都拉 `/api/interactions/pending`，支持允许一次/拒绝/回答问题）、停止与「解除占用」（无 daemon run 时 `/abort` 返回 `released`）、run 以 `error`（含 CLI `is_error`）结束时显示错误卡片。
- 深链：注册了 `claude-remote` URL scheme（`ios/PiRemote-Info.plist`），支持 `claude-remote://setup?…`、`claude-remote://approval/<id>?session=<sid>`、`claude-remote://session/<sid>`。若同一台手机还装了 claude-remote App，两者会争用该 scheme，iOS 不保证由哪个 App 打开。

