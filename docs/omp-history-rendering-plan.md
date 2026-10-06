# OMP 历史会话、工具时间线与 iPhone 渲染实施方案

> 状态：待实施；本次只交付方案，不代表代码已修改、构建通过或真机验收完成。
> 目标：补齐已关闭 OMP 主终端会话的只读浏览、主终端工具详情与会话阅读体验；不是重写应用。

## 1. 范围与已确认问题

- 用户已在真机看到进行中的 OMP 会话；主要缺口是**已关闭的历史会话**，不是单纯增加当前快照的消息数量。
- 历史第一阶段只读；“恢复历史并继续控制”单独立项，不能为读取历史启动 OMP，更不能双进程写同一 session。
- 工具详情缺失须覆盖 OMP 扩展 → Mac Node Agent → Relay → iOS 模型 → 视图整条链，不能只增加一个空卡片。
- 用户截图中粗体、列表已有渲染；具体 Markdown 异常尚未明确，须用用户确认的脱敏文本、视口和操作复现。
- 截图上半截文字可能已滚出视口，不能据此认定 safe area 缺陷；滚动行为与解析缺陷分别验证。
- 本期只展示主终端实际记录的工具调用；不默认展开子 agent 完整工具树、思考链、图片和附件。
- iPhone 设计依据为 `ios/DESIGN-SPEC.md`、`ios/PiRemote/Theme/DesignTokens.swift` 与现有原生组件。
- 根 `PRODUCT.md:13-16`、`DESIGN.md` 的对象是 macOS 助手；仅继承状态真实、凭据保护等通用原则，不搬用桌面布局和令牌。
- 主会话此前仅执行过 `npx impeccable skills check`，安装存在并提示更新，未更新、未调用 `/impeccable` slash；本文不声称使用了设计技能。

## 2. 源码事实与根因

| 已核对位置 | 当前行为及影响 |
| --- | --- |
| `src/terminal/extension.ts:3-7,356-375` | 扩展必须是仅依赖 Node builtins 的自包含文件；`getBranch()` 后只保留 user/assistant 的 text，丢弃 toolCall/toolResult。 |
| 同文件 `27-29,372,399-416` | 快照限制 100 条、256 KiB 文本；流式 partialAssistant 追加到尾部，完成时清空；结构化升级必须保留防重复语义。 |
| `src/terminal/bridge-client.ts:48-51,159-220,348-395` | 只发现 `.pi/.omp` 的活跃私有 socket；按 owner、socket 类型和 cwd realpath 限制工作区；解析器仍只有 role/text。 |
| 同文件 `16-19,267-271` | 最多探测 64 个 socket，探测 500 ms、请求 2 s，响应名义上限 4 MiB；当前用字符串 length，不能当成严格 UTF-8 byte 预算。 |
| `src/agent/pi-agent-handler.ts:39-83` | 列表合并 managed 与活跃 terminal；`session.get` 仅支持活跃 terminal，managed 历史返回 not_implemented。 |
| `src/protocol/relay-types.ts:3,18-35` | 外层协议 version=1，方法有白名单；不是任意新方法都能透传。 |
| `src/relay/{server.ts,session-router.ts}` | WebSocket 默认 maxPayload=4 MiB；路由超时默认 30 s；response data 原样转发，session.get 要求 sessionId。 |
| `ios/PiRemote/Models/Models.swift:191-239` | TerminalMessage 只有 role/text，快照整批替换；SessionSource 目前仅 managed/terminal。 |
| `ios/PiRemote/Services/RelayClient.swift:48-75,122-125` | terminal 每 2 秒轮询，发送/停止由在线和 activity 推导；不能把 history 当普通 terminal 自动获得控制权。 |
| `ios/PiRemote/Views/ConversationView.swift:60-63,113,247-278` | 消息变化无条件滚底、数组 offset 当 ID；Terminal 只呈现文字，Managed 的 ExecutionStep/stepsCard 可复用视觉但不是完整工具模型。 |
| `MarkdownMessageView.swift:197-282,300-312,346-351` | 任意 fenceStart 都能关闭代码块；列表 trim 掉缩进、续行拆段且不保留起始序号；表格直接 split 管道字符。 |
| 同文件 `8-15,68-76,107-139` | 每次 body 重新解析，块用 offset 作 ID，表格列宽固定 128 pt；长流式输出和长表格需性能/布局验证。 |

主会话补充的隔离解析实验：嵌套列表被展平、续行变成 list/paragraph/list、反引号代码块被 `~~~` 提前关闭、`a\|b` 被拆成多列。这些是确定的解析缺陷，**仍不是截图具体异常已复现**；本方案编写角色未重复运行实验。

## 3. OMP 持久化事实与 reader 选择

- 版本依据：安装二进制内嵌 `packages/coding-agent/package.json` 为 **18.6.3**；公开源码固定到 commit `093275112f7adff207608673c0e33c7f3d16e27f`，不依赖浮动 main。
- [`session-entries.ts`](https://raw.githubusercontent.com/can1357/oh-my-pi/093275112f7adff207608673c0e33c7f3d16e27f/packages/coding-agent/src/session/session-entries.ts)：`CURRENT_SESSION_VERSION=3`；可选首行是固定 256-byte title slot，随后才是 session header；不能把第一行一律当 header。
- Header 包含 id、version、cwd、可选 additionalDirectories/parentSession；条目由 `id/parentId` 形成树，message、compaction、branch_summary、reset_boundary 等并存；credential_pin/session_init 等不是手机正文。
- 安装资源中 `packages/utils/src/dirs.ts`：无覆盖时根为 `~/.omp/agent/sessions`；profile、PI_CODING_AGENT_DIR、PI_CONFIG_DIR 与有效 XDG data 根会影响目录，不能假设所有用户只用默认根。
- [`session-paths.ts`](https://raw.githubusercontent.com/can1357/oh-my-pi/093275112f7adff207608673c0e33c7f3d16e27f/packages/coding-agent/src/session/session-paths.ts)：home 内工作区使用 home-relative bucket（例如合成项目 `~/work/demo` → `-work-demo`）；临时目录优先，另有旧绝对编码/短期 hash bucket。
- `sessionDirForCwd` 是无迁移的路径查询；`computeDefaultSessionDir` 会迁移旧目录并创建目录，**禁止用于只读历史扫描**。
- [`session-manager.ts`](https://raw.githubusercontent.com/can1357/oh-my-pi/093275112f7adff207608673c0e33c7f3d16e27f/packages/coding-agent/src/session/session-manager.ts)：主文件为 `<bucket>/<timestamp>_<id>.jsonl`；同名去后缀目录存 artifacts，子会话可在其中写 `<agentId>.jsonl`，不递归纳入主会话列表。
- [`session-listing.ts`](https://raw.githubusercontent.com/can1357/oh-my-pi/093275112f7adff207608673c0e33c7f3d16e27f/packages/coding-agent/src/session/session-listing.ts)：主扫描模式是 `*/*.jsonl`；有 `listSessionsReadOnly`，但普通 `listSessions` 会恢复孤立 `.bak`，部分 recent 查询还记录标题索引，不能盲用“list”。
- [`session-loader.ts`](https://raw.githubusercontent.com/can1357/oh-my-pi/093275112f7adff207608673c0e33c7f3d16e27f/packages/coding-agent/src/session/session-loader.ts)：解析 title slot、流式 JSONL、迁移/外部 blob 等路径依赖 Bun 与 @oh-my-pi 包；本项目是 Node ≥22.18，不能直接承诺导入这些 TS 函数即可工作。
- [`session-context.ts`](https://raw.githubusercontent.com/can1357/oh-my-pi/093275112f7adff207608673c0e33c7f3d16e27f/packages/coding-agent/src/session/session-context.ts)：从 leaf 沿 parentId 回溯；plain transcript 保留压缩前路径，collapsed live/model context 会处理 compaction/reset_boundary；模型上下文不能冒充完整历史。
- [`session-persistence.ts`](https://raw.githubusercontent.com/can1357/oh-my-pi/093275112f7adff207608673c0e33c7f3d16e27f/packages/coding-agent/src/session/session-persistence.ts)：一般大字符串有 500,000 字符持久化截断，但签名/加密块有例外；图片可能外置 blob，jsonlEvents 会被剔除，不能承诺磁盘中仍有完整原始结果。
- [`session-storage.ts`](https://raw.githubusercontent.com/can1357/oh-my-pi/093275112f7adff207608673c0e33c7f3d16e27f/packages/coding-agent/src/session/session-storage.ts)：写入具备 claimSession/发布锁/原子替换等机制；`SessionManager.open(filePath, sessionDir?, storage?, options?)` 仍可能迁移、写 breadcrumb 或创建文件，不是只读接口。
- 安装资源的 CLI 参数表确认 `--resume`、`-r`、`--session` 共享恢复选择器，`--continue` 是继续最近会话；它们用于后续控制阶段，绝不用作历史 reader。

**推荐：独立、版本限定、无执行的 Node 只读 reader，移植最小格式兼容子集。** 借鉴官方解析/树语义并保留来源与许可证说明，不引入完整 OMP/Bun SDK，不运行安装二进制做解析；官方稳定且可实际导入的只读 API 若未来出现，再替换适配器。首批保证 v3，v1/v2 暂报告“不支持的历史版本”，实现内存迁移并补齐合成测试前不宣称兼容。

## 4. 推荐架构与语义

```text
活跃 OMP/Pi 扩展：当前 getBranch + 流式/工具运行事件 → 安全结构化投影
OMP ArchiveReader：限定根/工作区 → 只读索引 → 选定分支 → 同一投影
Mac Agent：能力协商、live/archive 去重、分页与权限 → Relay v1 response
Swift 会话 store：稳定 ID + revision + 分页 → 原生消息/工具/Markdown 行
```

- 投影只输出白名单字段，不传整个 SessionEntry。建议在自包含 `extension.ts` 中导出纯 `projectTranscript` 与结构类型供 Node reader 复用；导入不得启动 socket，默认扩展函数仍负责注册生命周期。
- 不给扩展添加第三方或相对运行时依赖，不要求安装器把额外模块复制到全局扩展；reader/索引/分页放在 Agent，不把文件系统历史扫描塞进每个终端。
- 主分支默认选择最后有效持久化 entry，按 parentId 回根再反转；live 以 getBranch 为准。内存中仅移动 leaf 但未落盘的选择无法从 archive 恢复，界面称“最后记录分支”，不伪称关闭时精确视口。
- 树索引先覆盖整份允许大小的文件，再分页投影；不能只倒读最近 N 行就连接分支。多叶分支提供轻量只读选择器，分页/详情引用绑定 branchId；分支切换不是恢复执行。
- 历史用完整选定路径阅读：保留压缩前可用正文，在实际位置插入“上下文已压缩”“上下文已清空”边界及可折叠安全摘要；摘要不替换正文，不重新拼接 provider replay、snapcompact 图像或兄弟分支。
- 记录已物理删除/截断时显示“不完整历史”；不能把 compaction 摘要展开成猜测出的逐条消息。custom_message 仅允许明确 display=true 且已知安全类型，其余隐藏或给无内容占位。
- 保留 source=terminal/managed 表示来源，新增 runtime、availability、lastOutcome、canControl；archive 不用 busy/idle 推断运行，不把“无 socket”写成“任务成功”。
- 以 `(runtime, canonicalWorkspace, persistedSessionId)` 对齐 live/archive，live 优先；冲突副本不能只按 UUID 静默合并，显示冲突并禁控。旧扩展不提供可靠 runtime 时不能猜合并。
- socket 暂时失联时可以提供“历史快照·只读”，但状态仍是未知/未连接，不能断言进程已退出。真正持久化末态只是 lastOutcome，不是进程存活证据。
- `canControl` 由服务端每次重新授权，历史 ID 的 prompt/abort/ui.response/start-resume 一律拒绝；不能依赖手机隐藏按钮，也不能落入 managed manager 路由。

## 5. 接口草案：沿用 Relay v1，扩展表示层

以下全部是**合成数据和拟定契约**，不是现有接口返回，也不含真实路径、命令输出或凭据。

```json
{"version":1,"type":"request","requestId":"demo-list","payload":{"method":"session.list","params":{"viewVersion":2,"scope":"live"}}}
{"capabilities":{"timelineV2":true,"ompArchiveRead":true,"historyPagination":true,"toolDetails":true},"sessions":[]}
{"version":1,"type":"request","requestId":"demo-history","payload":{"method":"session.list","params":{"viewVersion":2,"includeArchived":true,"limit":30,"cursor":null}}}
{"sessions":[{"sessionId":"history:opaque-demo","source":"terminal","runtime":"omp","availability":"archived","state":"unknown","activity":"unknown","lastOutcome":"complete","canControl":false,"title":"合成演示","project":"demo"}],"nextCursor":null,"indexState":"ready"}
{"version":1,"type":"request","requestId":"demo-page","sessionId":"history:opaque-demo","payload":{"method":"session.get","params":{"viewVersion":2,"view":"timeline","limit":50,"before":null}}}
```

`session.get` 的 `response.payload.data` 示例；items 按原始 entry/block 顺序，不按工具完成时间重排：

```json
{
  "sessionId":"history:opaque-demo","viewVersion":2,"revision":"rev-demo-1",
  "branchId":"branch-demo","availability":"archived","canControl":false,
  "messages":[{"role":"assistant","text":"**示例**：查看合成内容。"}],
  "items":[
    {"id":"entry-a:block-0","kind":"message","role":"assistant","text":"**示例**：查看合成内容。"},
    {"id":"entry-a:block-1","kind":"toolCall","toolCallId":"call-demo","name":"read","status":"succeeded","argumentsPreview":{"path":"fixture.txt"},"detailId":"detail-demo"},
    {"id":"entry-b:block-0","kind":"toolResult","toolCallId":"call-demo","isError":false,"preview":"合成内容","detailId":"detail-demo"}
  ],
  "page":{"hasMoreBefore":true,"before":"cursor-opaque-demo"},
  "truncated":false,"warnings":[]
}
```

- 新手机先用既有 session.list 探测 capabilities；确认支持后才请求 includeArchived/viewVersion=2。老 Agent 忽略参数不回能力时，只显示旧快照并明确“历史/详情需升级 Mac”，不显示空历史冒充成功。
- 无 v2 请求时维持原有 role/text 快照和列表，不给旧手机返回 archive 行；新手机优先 items，不同时渲染 messages 导致重复。外层 version 继续为 1，不盲目升级全协议。
- 复用白名单中的 session.get：`view=timeline|branches|tool`；tool 请求携带服务端发的 detailId、revision、cursor，分支请求只接受已授权的不透明 branchId；不新增 history.* 方法绕过 Relay 白名单。
- tool 响应返回 `arguments/result/error` 的安全投影、`totalBytes/returnedBytes/truncated/nextCursor/sourceTruncated`；字段缺失显示未记录，不补造原值。参数和结果分开分页，预览不自动下载全部结果。
- 所有 ID/cursor 由 Mac 生成并绑定工作区、会话、分支、revision、表示版本与有效期；不是客户端文件路径。无效/过期响应使用现有 error code（如 invalid_frame）加可选 details.reason，旧端仍可显示 message。
- 双重边界：legacy 继续既有限制；v2 每页默认 ≤50 timeline items、≤256 KiB **序列化 UTF-8**，列表 ≤30、详情块 ≤64 KiB；总包含 messages 兼容投影也必须计费。
- 超大单条返回稳定 ID、截断标记和详情引用，不丢整条；byte 切片不截断 UTF-8 字符。预算低于 4 MiB Relay 限制，慢索引不占满 30 s 请求超时。

## 6. 历史索引、分页与安全默认

1. 输入只取 Mac `config.piWorkspaceRoot` 和本机显式允许的 OMP 历史根；默认根按已核对规则解析。自定义 profile/XDG/session-dir 必须是本机配置，不接受手机提供绝对路径、glob 或根目录。
2. 根不存在返回“尚无可读取历史”，不创建 OMP 目录。只枚举 bucket 直属 JSONL；兼容旧 bucket 名时仍按 header 授权，目录名既不是 workspace 证据也不是 session ID。
3. 先有限读取 title slot/header（建议 64 KiB 预算，不足则报告 header 过大），验证 v3、id、cwd，再读取正文；cwd realpath 必须位于授权 workspace，additionalDirectories 任一越界则本期排除该会话。
4. 项目已删除、无法 realpath、权限/TCC 拒绝时 fail closed；不要拿 lexical prefix 或父目录猜授权，更不自动“迁移旧项目”。前缀相似目录必须通过 path.relative 判别。
5. 对历史根、bucket、文件逐级 lstat，拒绝符号链接和特殊文件，校验当前 UID、非他人可写；最终以 O_RDONLY/O_NOFOLLOW 打开，并 fstat 核对设备号/inode/大小/类型。
6. 读取前后复核目录链、文件身份与授权；文件替换、目录置换、同大小改写都使该次页失效，重试一次后返回 changed/retry。不能把“先 realpath 再 readFile”当作完整竞态防线。
7. Node 缺少通用 openat 目录链接口，实施时需审计 macOS 可用的 fd/目录校验方案并写置换测试；无法证明边界时不读取。此方案不声称能抵御完全控制同一 UID 的恶意本地进程。
8. 只读文件 descriptor 的固定 size 快照，流式分行；不完整尾行暂不参与索引，完整但损坏的行计数告警；缺失 header 拒绝，缺 parent/重复 ID/环导致受影响分支标为损坏，不能跨缺口拼接。
9. 首版默认上限建议：单文件 128 MiB、单记录 8 MiB、200,000 entries、并发读取 2；达到上限显示明确原因，不能伪称完整。数值是初始预算，需以合成大历史测量后调整。
10. metadata 索引存标题、project、时间、身份、版本、读取状态、byte offsets 与 parent 索引，不存全文/参数/结果；LRU 限制内存，扫描分批让出事件循环，取消过期任务。
11. 独立索引缓存可写在 Agent 私有目录（0700/0600），不是 OMP 会话目录；损坏可丢弃重建。稳定随机 history alias 随索引保留，不向 iOS 暴露 JSONL 绝对路径或原始磁盘身份。
12. 无全文扫描的列表按 `(modifiedAt, opaqueId)` 排序并使用 keyset cursor；标题默认采用安全处理后的 title slot/header，缺失时用日期，不默认上传首条 prompt 作为标题。
13. 时间线先建该文件树的 offset 索引，选定 branch 后按序定位 entry，最后投影分页；首屏取最新页，“加载更早”沿稳定边界走。分页边界拆开的 call/result 通过 toolCallId/detailId 关联。
14. revision 绑定文件 stat 身份、内容校验信息与 branch；mtime/size 之外还检测 title slot 同长改写、rename/原子替换。缓存命中仍重做权限检查；fs.watch 只作失效提示，周期重扫兜底。
15. 索引未完成返回 indexState=building 与已有结果，UI 可重试；不每 2 秒重扫全部磁盘。文件删除清除 alias，重连/工作区切换清空已失效页，cursor 过期保留当前视口并提示刷新。
16. 不自动恢复 `.bak`、迁移 JSONL、写 title/breadcrumb、打开 OMP owner lock 或读取 auth/models/history 数据库；不运行工具、shell、模型，不为恢复详情重新执行原命令。
17. 输出白名单排除 thinking、签名、providerPayload、credential_pin、system prompt、session_init 与原始 custom/details；未知结构只输出类型/“暂不支持”，不 stringify 后传手机。
18. 参数/结果默认折叠且按需授权返回，清理 ANSI/control characters，遮蔽已知敏感 key、URL token 和常见凭据样式；不为脱敏去读取本机真实凭据。脱敏**不能保证消除任意正文中的秘密**。
19. 安全默认不批量导出原始 JSONL/日志、不自动复制/分享详情、不把正文写诊断日志或索引；复制仅针对用户明确选中的已显示安全内容。若无法可靠投影，返回“内容已隐藏”，不降级为 raw。
20. Relay 能看到转发正文，不提供端到端加密承诺；仅沿用已配对认证/WSS，用户应知历史和工具输出可能含代码/敏感文本。手机历史正文先只存内存，切换设备/断连按策略清理，不新增无保护磁盘缓存。

## 7. 结构化工具时间线与实时一致性

- 持久化工具调用来自 assistant.content 的 `toolCall{id,name,arguments}`，结果来自 `role=toolResult` 的 `toolCallId/toolName/content/isError`；以会话+分支+调用 ID 关联，不按工具名或数组下标匹配。
- 相同工具并行、结果乱序时，卡片锚在原调用 block；结果到达原时间线位置保留结果行/链接，展开内容更新调用卡片而不移动后续文字，不能把所有工具统一挪到回复底部。
- 卡片默认“工具名 · 状态 · 简短目标”；展开呈现安全参数、结果、错误、截断原因及加载更多。复用 stepsCard 的原生颜色/间距和图标，不照搬仅有两个 Bool 的 ExecutionStep 语义。
- 状态至少区分 requested/running/succeeded/failed/cancelled/unknown；收到真实执行开始事件才标 running，有匹配结果才标成功/失败；abort 请求被接受不等于所有工具已 cancelled。
- archive 无结果的调用标“未记录结果/可能中断”，不转圈、不伪造失败；只有结果却无调用时显示“未配对结果”，不误接另一分支。重复 ID 或冲突结果必须告警，不悄悄覆盖。
- 扩展补足可用的 tool_execution_start/update/end 事件以及 message_start/update/end 的结构化缓冲；Pi/OMP 事件结构先用各自合成适配测试，无法取到的进度显示 unknown，不承诺所有工具都有百分比。
- 流式 assistant 使用本地稳定 provisional ID，落盘时用已关联 entry ID 替换；`message_end` 与 getBranch 可见之间保留 staged-final，确认落盘后移除，不能靠文本相等消重不同消息。
- v2 返回 stream generation/revision 和 provisional→persisted 对应关系；同一页重复轮询只 upsert 内容变化的 ID，分支变化返回 reset 指示，不把整页反复 append。
- 已完成 entry ID + block ordinal 是稳定视图 ID；页间重叠、回调乱序、重连、切会话和工具详情响应均需 session/branch/generation guard，复用现有 terminalGeneration 思路。
- 结果只取 JSONL 中可用安全文字；识别 persistence 截断为 sourceTruncated，不把“加载更多”指向不存在内容。artifact://、文件路径、blob 引用本期只给未载入说明，不盲目跟随。

## 8. Markdown 方案选择与滚动策略

| 方案 | 原生/依赖与维护成本 | 预估工作量及结论 |
| --- | --- | --- |
| 保留自写 block parser + AttributedString，逐项修补 | 无新依赖；需自行维护围栏配对、缩进树、续行、起始序号和 GFM table 转义，流式状态还会放大边界组合。 | 约 2–4 人日修补已知语法，后续 CommonMark 覆盖持续扩张；适合临时止血，不作为长期主线。 |
| Swift Markdown AST + 现有 SwiftUI 渲染 | 首选 `swiftlang/swift-markdown` 的 Markdown AST，接受 SwiftPM/cmark 系依赖、包体和编译开销；不引入 WebView。保留 codeView/tableView 外观并改为 AST 驱动。 | 约 4–7 人日含适配/语法样例/真机性能；成本较高，但解决嵌套与边界根因，推荐。 |

- **选择第二项**：成熟 AST 解析 block/inline，转换成自己的安全轻量 render model；不让第三方视图库重定整套会话 UI。MarkdownUI 等整包主题库非本期首选，避免额外图片加载/主题迁移工作。
- 当前 Xcode 工程未声明 SwiftPM 包，iOS deployment target=26.0、Swift language version=5.0；阶段 0 核对选定包 tag 的工具链、许可、传递依赖并固定版本。这里没有进行联网依赖解析或编译，不预报其已兼容。
- 若固定版本无法集成，先解决兼容/版本选择；不得静默退回仅渲染纯文本作为“满足要求”。保留旧 renderer 作受控故障降级，不把两套解析器长期并行维护。
- 渲染契约覆盖粗体/斜体/行内代码、标题/引用、嵌套有无序列表、任意有序起始值、列表续行、围栏语言/长度/符号、转义管道表格；现有已正确的粗体和列表必须不回退。
- 链接只允许 http/https，点击由系统确认/打开；禁止 file/javascript/custom scheme 执行，HTML 作为安全文本/不支持块，远程图片不自动请求。代码块为等宽可选择文本，长行横向滚动。
- 表格依容器宽度与列内容给受限列宽，宽表独立横向滚动，不把整页撑宽；中文、emoji、长 URL、Dynamic Type、VoiceOver 和触控目标沿用 iOS 规范，不借机重做配色。
- 以 message ID + content revision 缓存 AST/render model，后台解析并在主线程提交最新结果；流式仅重解析变化消息、适度合并刷新，未闭合尾块允许暂态显示，结束后再做最终解析。
- 使用 LazyVStack 与稳定行 ID，避免 offset 身份漂移；工具展开状态、文本选择与已完成消息的缓存不能因每两秒快照重建丢失。
- 只有首次打开最新 live 页、用户发送消息或用户原本靠近底部（建议阈值 80 pt）才跟随；浏览旧消息时新增内容显示“有新消息/回到底部”，审批变化也不强制抢滚动。
- 加载更早前记录首个可见 ID+像素偏移，插入后恢复锚点；工具展开、键盘进出、字体变化也保留阅读位置。历史打开默认最新页，但之后不轮询滚底；分支切换按独立阅读位置恢复。
- 待复现截图时记录原始 Markdown、设备尺寸、字体设置、输入框/键盘状态和前后滚动录像；safeAreaInset 等调整仅在确定遮挡来源后局部实施。

## 9. 预计文件改动清单（本次均不修改）

| 文件/目录 | 后续实施职责 |
| --- | --- |
| `src/terminal/extension.ts` | 纯统一投影、稳定 IDs、工具/partial 事件缓冲、v2 能力、byte 预算；维持自包含。 |
| `src/terminal/bridge-client.ts` | v2 请求/解析/类型、runtime/身份、tool 详情、能力缺失降级与严格 byte 上限。 |
| 新 `src/history/{omp-reader,history-index}.ts` | 版本限定只读 reader、路径授权、树/offset 索引、alias/revision/cursor；不启动运行时。 |
| `src/agent/{pi-agent-handler,run}.ts`、`src/config.ts` | 注入历史服务与本机根配置、合并分页、控制拒绝、生命周期取消/缓存清理。 |
| `src/protocol/relay-types.ts` | 给既有方法约定 v2 可选类型/能力与错误 details；外层 version 和方法白名单保持。 |
| `ios/PiRemote/Models/Models.swift`、`Services/RelayClient.swift` | 生命周期/权限与 timeline 模型、分页 store、详情缓存、代次校验、兼容旧响应。 |
| `ios/PiRemote/Views/{SessionsView,ConversationView,MarkdownMessageView}.swift` | 历史入口/只读状态、工具行、AST 渲染与阅读锚点；必要时抽小型 ToolCallView/TimelineStore。 |
| `ios/PiRemote.xcodeproj/project.pbxproj` 与其 SwiftPM resolved 文件 | 只加入锁定 Markdown 解析依赖；不降低/抬高系统下限，不重做工程。 |
| `tests/terminal-{extension,bridge,session-routing}.test.ts` 与新 history 测试 | 扩充双协议/工具/历史安全回归；旧 text-only 测试保留为 legacy 契约。 |
| `ios/Tests/{SessionParsingTests,SessionCreationTests,TerminalCallbackGuardTests}.swift` 与新渲染/滚动测试 | 延续独立 @main 测试组织，新增需要真实 SwiftUI 的 UI harness/真机用例，不能用模型测试代替滚动测试。 |

Relay 服务端预计无需新增路由；先补透传/限制回归，发现必须改校验才做最小改动。macOS 配置界面、Claude backend、部署与无关业务不在改动列表。

## 10. 分阶段实施、测试与退出条件

| 阶段 | 实施与退出条件 |
| --- | --- |
| 0 · 契约/复现（约 1 人日） | 用合成 fixture 固定 v3/title slot/树/工具 schema，获得截图的可复现输入；完成 AST 依赖可编译性与许可证评估，仍不接触真实历史。 |
| 1 · 历史只读（约 3–5 人日） | reader/索引/分页/权限 → 新手机历史列表与正文；关闭的独立测试会话可浏览，旧手机不见 archive，所有历史控制请求服务端拒绝。 |
| 2 · 工具全链（约 2–4 人日） | live/archive 统一投影、结构化事件与卡片、按需详情；成功/失败/中断/未知可区分，流式落盘无闪失或重复。 |
| 3 · Markdown/阅读（约 4–7 人日） | 接入 AST 与缓存、稳定 ID、条件跟随/锚点恢复；语法样例和长历史 UI 验收，截图问题有独立结论。 |
| 4 · 联调/真机（约 1–2 人日） | 完成版本组合、断连/超时/损坏/大文件测试；记录实测数据与残余限制，用户确认后再发布。 |
| 后续单独阶段 · 恢复控制 | 不计入本期估算；评估官方恢复 API/CLI、owner lock、工作区/模型恢复、单写者交接、确认与回滚后另提方案。 |

- Node 回归：执行项目 `typecheck`/`test`（实施者或主会话负责）；测试目录使用临时 HOME/工作区与独立 fixture，禁止 PI_LIVE_RPC=1 连接真实用户运行时。
- reader 用例：可选 title slot、未知版本、两个兄弟分支、branch_summary、reset_boundary、compaction 前后正文；断 parent/重复 ID/环必须被检测，不能把物理 JSONL 顺序当对话。
- 安全用例：cwd/附加工作区越界、相似前缀、symlink 根/中间目录/文件、目录竞态置换、非法 owner、特殊文件、过期 alias/cursor、损坏头、中段坏行和 UTF-8 不完整尾行。
- 索引用例：大于 100 条和 256 KiB 的历史多页加载、单行/单文件上限、同长标题改写、原子替换/删除、索引损坏与重启失效；并发扫描不能饿死 live prompt/abort。
- 工具用例：相同名称并行、结果乱序、同 ID 冲突、跨分支结果、未配对/缺失结果、工具 error、partial→persisted 窗口、重复轮询与分页重叠；任何场景不得错配或重跑工具。
- 权限用例：历史按钮不可用且手写 prompt/abort/ui.response/session.start 请求也被拒；active/offline/archive 切换不得误判成功/运行中，live/archive 去重不改变实际控制目标。
- Markdown golden 用例：嵌套列表/续行/从 7 开始的列表、不同围栏符号与长度、未闭合代码、`a\|b` 表格、行内代码/中文/长 URL；覆盖当前粗体、列表正常场景不回退。
- 滚动 UI 用例：在旧消息处持续到达新输出不能跳底；顶部分页锚点像素偏移可量测；展开工具/键盘/字体变化不丢位置，点击“回到底部”才恢复跟随。
- 兼容矩阵：新/旧 iOS × 新/旧 Agent/扩展 × Pi/OMP；新表示可经现有 Relay 转发，缺能力只降级展示，绝不对旧 server 连续重试新行为。
- 真机验收仅使用专用临时工作区、合成 JSONL 与独立测试会话；如需真实执行工具，另开获授权的测试终端，不 reload/abort/关闭用户正在运行的 OMP。
- 真机步骤：活跃读流 → 工具完成 → 关闭测试终端 → 历史仍可读 → 分页/切分支/详情 → 网络中断与重连；同时验证输入/停止不可用与 Mac 未产生第二个 writer。
- 记录指标：历史列表/首屏/详情时延、分页最大内存、滚动掉帧与包大小；暖缓存首屏建议目标 ≤1 s、单页 ≤256 KiB，大文件冷索引必须显示进度而非卡死，目标以实际设备测量确认。

## 11. 未决项、明确不做与验证边界

- 待用户定位：截图究竟是语法错误、截断、视口位置还是布局遮挡；未拿到复现输入前，只承诺修复独立确认的解析/滚动缺陷，不宣称截图问题已解决。
- 待实施验证：Swift Markdown 固定 tag/工具链/包体、Pi/OMP 实际工具事件字段、fd 竞态防护可行性、profile/XDG 配置注入和历史预算；均不得写成“检查已通过”。
- 首期只支持允许工作区中的 OMP v3 主会话；Pi 保留现有 live 兼容，Pi archive、旧格式迁移、managed 历史与外部数据库存储各自后续适配，不共享未经验证的格式假设。
- 不做：历史恢复执行、自动修复/迁移原会话、全盘历史扫描、全文搜索/批量导出、子 agent 完整工具树、thinking/原始 provider 信息、图片/附件/blob/artifact 浏览、HTML/WebView 重写及无关 UI 翻新。
- 官方“可恢复”不等于可安全并发控制：即使文件暂无活跃 socket，也可能被另一终端持有；后续接管必须通过官方所有权机制及实时重检，不能只看 PID/socket 存在性。
- 本次核对限仓库源码/测试/设计文档、安装二进制内嵌公开资源，以及主会话额外授权的固定 commit 静态会话源码；未读取真实用户 session JSONL、凭据或数据库内容。
- 本次仅写本文件，未运行模型、构建/测试、部署或真实服务联调；上述测试、预算和阶段退出条件均为后续执行要求，不是已完成结果。
