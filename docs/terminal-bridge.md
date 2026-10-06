# 终端桥接（terminal bridge）

## 背景

iOS 端之前只能看到 Mac 上由 `PiProcessManager` 拉起的受管会话（`session.start` 启动的 `pi --mode rpc` 进程）。
用户直接在终端里运行的交互式 `pi` 会话虽然在 Mac 上活着，但不在 `session.list` 里，所以手机端显示为空。

终端桥接用一个可安装的 pi 扩展，把**用户原始终端进程**里的当前会话暴露给本机的 Mac Agent。
扩展运行在真实原进程内，读取该进程自己的会话状态、并把 `session.prompt` / `session.abort`
转发给同一个进程，因此不会对同一会话产生第二个写入者。

## 安装

```bash
bash scripts/install-terminal-bridge.sh              # 安装到 ~/.pi/agent/extensions/pi-remote-bridge/index.ts
bash scripts/install-terminal-bridge.sh --dry-run    # 只演练
bash scripts/install-terminal-bridge.sh --runtime pi       # 默认行为
bash scripts/install-terminal-bridge.sh --runtime omp
bash scripts/install-terminal-bridge.sh --runtime all
bash scripts/install-terminal-bridge.sh --dir <dir>  # 单运行时自定义 extensions 目录（测试用）
```

安装器只写 `pi-remote-bridge/` 子目录，不会覆盖其他扩展。默认 `pi`，`--runtime all` 会先校验两个目标再安装；`--dir` 只适用于单一运行时。扩展是单文件、零本地依赖，只用 Node builtin。已安装的 pi 扩展无需重装，Agent 在 `PI_RUNTIME=omp` 下仍会发现 pi 终端会话。omp 安装路径为 `~/.omp/agent/extensions/pi-remote-bridge/index.ts`。

安装后：

- 如果 pi 已经在运行，需要在**空闲状态**下执行 `/reload` 才会加载扩展。正在跑回合时不要 reload。
- 新建的 pi 交互式会话会自动加载。
- 校验：`ls ~/.pi/agent/extensions/pi-remote-bridge/index.ts`，然后在 pi 里 `/reload`，再在手机上刷新会话列表。

## 运行条件与限制

- 只在**交互式 TUI** 会话（`ctx.mode === "tui"` 且 `ctx.hasUI`）里启动桥接。RPC/print/json 模式不启动，
  这样 Mac Agent 自己拉起的 `pi --mode rpc` 进程不会被重复暴露成终端会话。
- 桥接只作用于当前会话：`/new`、切换会话、`/reload`、退出都会停掉旧 socket 并在新会话重新开始。
- 手机端目前轮询刷新：`session.list` 每 4 秒、`session.get` 每 2 秒，不依赖事件流。
- 不支持远程处理扩展 UI 对话框：`ui.response` 对终端会话返回 `not_implemented`，需在 Mac 终端里回答。
- 不实现 steer / approval 之类的中途输入桥。
- 进程被 `SIGKILL` 等异常终止时 socket 文件可能残留；客户端会忽略无响应的 stale socket。正常
  `/reload`、切换会话和退出都会清理。

## 安全边界

- 只用 Unix domain socket，不开任何公网或 TCP 端口。
- 目录 `~/.pi/agent/pi-remote-bridge`（pi）与 `~/.omp/agent/pi-remote-bridge`（omp）权限 `0700`，socket 权限 `0600`，仅当前用户可访问。
  Agent 默认同时扫描这两个目录；`PI_REMOTE_BRIDGE_DIR` 设置后仅扫描该目录。安装器可用 `PI_AGENT_DIR` / `OMP_AGENT_DIR` 分别覆盖扩展安装根目录。
- Mac Agent 侧每次都会检查：文件必须是 socket（不是符号链接/普通文件）、owner 是当前用户、
  会话 `cwd` 经 `realpath` 后仍在本机 workspace 根目录内（防 symlink 逃逸），否则忽略该 socket。
- 所有 socket 调用都有超时上限，一个卡住的终端不会拖死 `session.list`。
- 关闭 Mac Agent 只销毁桥接的客户端 socket，**不会** kill 用户的终端进程。

## 协议

### Relay（iOS ↔ Relay ↔ Mac Agent）

`session.list` 每项在原有字段上新增：

| 字段 | 说明 |
| --- | --- |
| `source` | `"managed"`（Agent 拉起的进程）或 `"terminal"`（用户终端会话） |
| `state` | 终端会话固定为 `"running"`：只有桥接 socket 真的在响应时才会出现在列表里 |
| `title` | 优先 `sessionName`，否则最后一条用户文本截断；受管会话用最后一次 prompt |
| `cwd` | 可选，会话工作目录 |
| `activity` | `"busy"` / `"idle"` / `"unknown"`；`busy` 表示真实回合进行中 |

受管会话的 `state`（`running`/`exited`/`failed`）仍表示**进程是否活着**，与 `activity` 是两件事。

新增 `session.get`（需要 `sessionId`，可放在帧上或 `params.sessionId`）：

```json
{
  "sessionId": "terminal:<pi uuid>",
  "activity": "busy",
  "messages": [{ "role": "user", "text": "..." }, { "role": "assistant", "text": "..." }],
  "truncated": false
}
```

- `messages` 只包含当前 branch 的 user/assistant 文本，工具内容不算 assistant 正文；
  最近最多 100 条、总文本最多 256 KiB，超出则 `truncated: true`。
- 正在流式输出的 assistant 文本作为末尾一条附加，回合结束后就不会重复。
- 受管会话没有历史接口，返回 `not_implemented`；目前只有终端会话使用 `session.get`。
- `session.prompt` / `session.abort` 对 `terminal:` 前缀的会话转发到原终端进程；
  忙碌时 `session.prompt` 返回 `session_busy`。
- `ui.response` 对终端会话返回 `not_implemented`（在 Mac 终端处理）。

终端会话 ID 统一带 `terminal:` 前缀（`terminal:<pi uuid>`）。

### 扩展 ↔ Mac Agent（Unix socket，newline JSON）

请求：`{"id": "...", "op": "list|get|snapshot|prompt|abort", "sessionId"?: "...", "message"?: "..."}`
响应：`{"id": "...", "ok": true, "data": ...}` 或 `{"id": "...", "ok": false, "error": {"code": "...", "message": "..."}}`

- `list` → `{ sessions: [meta] }`（每个实例只返回它自己那一个会话）
- `get` → `meta`
- `snapshot` → `{ sessionId, activity, messages, truncated }`
- `prompt` → `{ sessionId, queued: true }`；忙碌时错误码 `session_busy`
- `abort` → `{ sessionId, aborted: true }`

错误码：`invalid_request`、`stale_session`（请求的 sessionId 与当前会话不一致）、`session_busy`、
`not_ready`、`unsupported_op`、`internal_error`。`prompt` 与 `abort` 必须显式带上 sessionId。

## 验收命令

```bash
npm run typecheck
node --test tests/terminal-bridge.test.ts tests/terminal-extension.test.ts tests/terminal-session-routing.test.ts tests/install-terminal-bridge.test.ts

# 手动端到端（本机）：
bash scripts/install-terminal-bridge.sh --dry-run
# 在 pi 里 /reload 后：
ls ~/.pi/agent/pi-remote-bridge/          # 应出现 b-*.sock
# 手机刷新会话列表，应看到 source=terminal 的当前会话
```
