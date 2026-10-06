# pi-remote

Remote gateway for the [pi](https://github.com/earendil-works/pi) coding agent.

**Phase 1:** a runnable Node + TypeScript skeleton plus a verified RPC subprocess layer.
**Phase 2 (this code):** the relay HTTP/WebSocket gateway and the Mac agent process that drives
`PiProcessManager` over it. No prompt is invoked automatically; a pi subprocess starts only when
a client sends `session.start`.

## Requirements

- Node.js >= 22.18 (uses built-in TypeScript type stripping and `node:test`; developed on Node 24)
- pi CLI on `PATH` (verified against pi **0.85.1**)

## Commands

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test, fake process only, never calls a model
npm run test:live   # opt-in: spawns real pi and sends only `get_state`
npm start           # start the relay HTTP/WS gateway
npm run dev         # same, with --watch and .env support
npm run agent       # start the Mac agent (connects to the relay)
npm run start-agent # alias of `agent`
npm run dev-agent   # `agent` with --watch and .env support
```

## 服务端部署安装 (Server Installation)

`pi-remote` 提供了面向服务器的一键安装与升级脚本 `scripts/install-server.sh`，支持 `standalone`（独立全托管，内置 Caddy 自动申请 TLS）以及 `external-proxy`（外部反向代理）两种模式。

详细部署文档、参数说明与运维指引请参阅 [deploy/README.md](deploy/README.md)。

快速启动命令（在服务器源码目录下运行）：

```bash
# 预检演练（dry-run，不修改系统、不写入文件）
./scripts/install-server.sh --domain pi.example.com --dry-run

# 独立全托管安装（需 root 权限）
sudo ./scripts/install-server.sh --domain pi.example.com --mode standalone
```

## Layout

```
src/config.ts               env parsing and strict validation
src/protocol/types.ts       normalized event types shared with the relay
src/protocol/relay-types.ts relay frame schema and parsing
src/relay/server.ts         HTTP + WebSocket relay gateway
src/relay/session-router.ts request/event routing between iOS and the agent
src/pi/rpc-client.ts        JSONL stdin/stdout client for one `pi --mode rpc` process
src/pi/process-manager.ts   one controlled child process per session
src/agent/agent-client.ts   outbound relay client (connection + framing)
src/agent/pi-agent-handler.ts  relay requests -> PiProcessManager, events -> session_event
src/agent/run.ts            Mac agent entry point with reconnect and graceful shutdown
src/index.ts                relay entry point
tests/                      node:test suites + fake child-process/socket helpers
```

## Verified RPC protocol

Everything below was confirmed by reading pi 0.85.1 sources
(`dist/modes/rpc/rpc-client.js`, `rpc-types.d.ts`, `jsonl.js`, `rpc-mode.js`) and by a live
`get_state` probe. It is the contract `src/pi/rpc-client.ts` implements.

**Process and framing**

- A session process is started with `pi --mode rpc [options]` (`--provider`, `--model`,
  `--no-session`, `--session-dir`, ...).
- Transport is strict JSONL over stdin/stdout. `\n` is the **only** record delimiter.
  Trailing `\r` must be stripped on read. Node `readline` must not be used because it also
  splits on `U+2028`/`U+2029`, which are valid inside JSON strings.
- Chunks can split anywhere; the client decodes incrementally with `StringDecoder`.
- When stdin ends, pi shuts down and exits (`process.exit(0)`). `SIGTERM` triggers graceful shutdown.
- stderr is diagnostics only; it is never protocol.

**Requests and responses**

- A command is a JSON object with a `type` field and an optional `id`.
- The response is `{"id": ..., "type": "response", "command": ..., "success": true, "data": ...}`
  or `{"id": ..., "type": "response", "command": ..., "success": false, "error": "..."}`.
  The `id` is echoed, so responses match requests by id.
- A malformed command line produces an **id-less** response:
  `{"type":"response","command":"parse","success":false,"error":"Failed to parse command: ..."}`.
- `prompt` resolves once the prompt is accepted/queued; failures after acceptance arrive on the
  event stream, not as a second response. While streaming, `prompt` needs
  `streamingBehavior: "steer" | "followUp"`.
- `abort` responds only after the session becomes idle.
- Verified live: `get_state` returns `model`, `thinkingLevel`, `isStreaming`, `isCompacting`,
  `steeringMode`, `followUpMode`, `sessionId`, `autoCompactionEnabled`, `messageCount`,
  `pendingMessageCount`, with optional `sessionFile` / `sessionName`.

**Events**

- Agent events stream on stdout as JSON lines and normally have **no** `id`.
  `bash_execution_update` carries the `id` of the originating `bash` command.
- Lifecycle: `agent_start`, `agent_end` (`willRetry`), `agent_settled`, `turn_start`, `turn_end`,
  `message_start`, `message_end`.
- Streaming: `message_update` with `assistantMessageEvent` deltas
  (`text_start|text_delta|text_end`, `thinking_*`, `toolcall_start|toolcall_delta|toolcall_end`).
  `message_update` does **not** include a cumulative message; `message_end.message` is authoritative.
- Tools: `tool_execution_start|update|end`. `tool_execution_update.partialResult` is accumulated,
  not a delta.
- Other: `bash_execution_update`, `queue_update`, `compaction_start|end`, `auto_retry_start|end`,
  `summarization_retry_*`, `extension_error`.
- **Extension UI:** extensions can emit `extension_ui_request`. `notify`, `setStatus`, `setWidget`,
  `setTitle`, `set_editor_text` are fire-and-forget. `select`, `confirm`, `input`, `editor` block
  until the client answers with `{"type":"extension_ui_response","id":..., ...}`. These requests
  were observed on stdout **before** the first command response, so clients must tolerate them at
  any time.

**Important design consequence:** raw pi events are not exposed upward. `rpc-client.ts` maps them to
the normalized `GatewayEvent` union in `src/protocol/types.ts`.

## Isolated verification

Tests use a fake child process (in-memory `PassThrough` streams) and never call a model. The live
check is opt-in and only sends `get_state`:

```bash
PI_LIVE_RPC=1 npm run test:live
```

Equivalent manual probe (temporary cwd, no session persistence, query only):

```bash
TMP=$(mktemp -d); cd "$TMP"
printf '%s\n' '{"id":"req_1","type":"get_state"}' | pi --mode rpc --no-session
```

This was run successfully against pi 0.85.1. It does not read or modify user sessions.

## Configuration

`loadConfig()` reads and validates (see `.env.example`):

| Variable | Default | Rule |
| --- | --- | --- |
| `RELAY_HOST` | `127.0.0.1` | bare host or IP, no scheme/port/path |
| `RELAY_PORT` | `8789` | integer 1-65535 |
| `RELAY_TOKEN` | required | shared secret, >= 32 chars |
| `RELAY_URL` | `ws://$RELAY_HOST:$RELAY_PORT/ws/agent` | `ws://`/`wss://` URL; must not embed a token |
| `AGENT_TOKEN` | `RELAY_TOKEN` | Mac agent token, >= 32 chars |
| `AGENT_DEVICE_ID` | `pi-mac-agent` | 1-128 chars from `[A-Za-z0-9._:-]`, first char alphanumeric |
| `PI_RUNTIME` | `pi` | exactly `pi` or `omp` (managed sessions only) |
| `PI_BIN` | `pi` / `omp` | selected by `PI_RUNTIME` when unset; explicit non-empty override |
| `PI_WORKSPACE_ROOT` | `~/Desktop` | absolute, non-root directory; session cwds are confined to it |
| `MAX_SESSIONS` | `16` | integer 1-128 |

Tokens are never logged. `describeConfig()` prints only the relay URL, device id, runtime, binary,
workspace root, and session cap; `RELAY_URL` rejects embedded tokens for the same reason.

## Mac agent

`npm run agent` starts the local agent. It connects to the relay as `role=agent`, forwards relay
requests to `PiProcessManager`, and reconnects with exponential backoff (1s up to 30s) when the
socket drops. Set `PI_RUNTIME=omp` to launch `omp --mode rpc` for managed sessions; terminal
sessions from both pi and omp are discovered regardless of this setting. `PI_BIN` overrides the
selected CLI, including an absolute executable path supplied by the Mac app. It starts no
session until a client asks for one and never invokes a model on its own.

```bash
RELAY_URL=wss://relay.example.com/ws/agent \
AGENT_TOKEN=$(openssl rand -hex 32) \
AGENT_DEVICE_ID=macbook-pro \
PI_WORKSPACE_ROOT="$HOME/Desktop" \
npm run agent
```

### Relay protocol examples

Every frame carries `version: 1` and a `type`. The agent announces itself with a hello whose role
must match the endpoint (`/ws/agent`):

```json
{"version":1,"type":"hello","deviceId":"macbook-pro","payload":{"role":"agent"}}
```

`session.start` resolves `params.cwd` inside `PI_WORKSPACE_ROOT`. Relative cwds are resolved
against the root and absolute cwds must stay inside it; `..` escapes are rejected with
`invalid_frame` and no process is spawned. `sessionId` is optional and generated as a UUID when
absent.

```json
{"version":1,"type":"request","requestId":"r1","payload":{"method":"session.start","params":{"cwd":"my-project"}}}
{"version":1,"type":"response","requestId":"r1","sessionId":"5b1c...","payload":{"ok":true,"data":{"sessionId":"5b1c...","status":{"sessionId":"5b1c...","state":"running","pid":4242,"exitCode":null,"signal":null,"startedAt":1730000000000}}}}
```

A successful `session.prompt` only means the message was **queued** (the manager accepts one
in-flight prompt per session). Output arrives as `session_event` frames whose `event` is a
normalized `GatewayEvent` and that always include the `sessionId`:

```json
{"version":1,"type":"request","requestId":"r2","sessionId":"5b1c...","payload":{"method":"session.prompt","params":{"message":"summarize README.md"}}}
{"version":1,"type":"response","requestId":"r2","sessionId":"5b1c...","payload":{"ok":true,"data":{"sessionId":"5b1c...","queued":true}}}
{"version":1,"type":"session_event","sessionId":"5b1c...","payload":{"event":{"type":"text_delta","sessionId":"5b1c...","contentIndex":0,"text":"README"}}}
```

`session.abort` stops the running turn, and `session.list` returns the process state of every
session the agent started:

```json
{"version":1,"type":"request","requestId":"r3","sessionId":"5b1c...","payload":{"method":"session.abort"}}
{"version":1,"type":"request","requestId":"r4","payload":{"method":"session.list"}}
```

Extension dialogs blocked in pi are surfaced as `ui_request` gateway events. The client answers
them with `ui.response`, which the agent converts to the pi RPC `extension_ui_response`:

```json
{"version":1,"type":"request","requestId":"r5","sessionId":"5b1c...","payload":{"method":"ui.response","params":{"requestId":"ui-1","response":{"confirmed":true}}}}
```

Methods without a verified mapping return `{"ok":false,"error":{"code":"not_implemented",...}}`
rather than guessing at pi RPC semantics.

## Known limitations

- Only `get_state` has been exercised against real pi. Other commands are implemented from the
  typed protocol but not live-tested.
- No model/prompt is ever invoked in this phase, so streaming behavior is validated against
  fixtures rather than a real provider.
- No persistence or replay of events.
- `message_update` deltas are forwarded as-is; a consumer that needs a full partial message must
  assemble it from `message_start` plus deltas.
- Extension dialog requests are surfaced as `ui_request` events and can be answered with
  `ui.response`; no policy/timeout logic beyond pi's own exists yet.

## Next phase

1. An opt-in integration test that drives a real prompt from an iOS client through the relay to
   the Mac agent (never enabled by default).
2. Per-session backpressure/limits and structured logging.
3. Event persistence/replay so a reconnecting iOS client can catch up.
