# Pi Desktop 专属会话管理

当前生产 Agent 仅连接 Pi Desktop 的本机 MCP 控制接口。OMP、Pi CLI、Desktop 导入的 `pi-native` 会话及其他远端 Host 会话均不在范围内。此前未提交的多运行时开发内容已保存在 `archive/multi-runtime-20261018`（`3e4a79c`），没有删除用户的真实会话文件。

手机可管理列表、阅读、新建、发送和停止，也可以在受控范围内读取模型目录、在新建或空闲时选择模型，并回应普通的工具权限与 AskTool 问题。模型执行、会话存储和权限裁决仍由 Pi Desktop 掌握；手机不直接读写数据库，也不接管 CLI。

## 使用方式

先保存正在执行的工作并正常退出 Pi Desktop，再在终端启动：

```bash
PI_DESKTOP_MCP_CONTROL=1 /Applications/PI-Desktop.app/Contents/MacOS/PI-Desktop
```

这不是第二份桌面实例：Pi Desktop 的单实例机制要求先退出原实例，开关才能生效。不应为了联调强制终止正在运行的任务。控制服务默认绑定 `127.0.0.1:37123/mcp`，可在启动 Desktop 时用 `PI_DESKTOP_MCP_PORT` 指定其他空闲端口，不要对公网开放该端口。

随后正常启动 Pi Remote Mac 助手或 `npm run agent`。Agent 从本机 `mcp-control.json` 发现 URL 和凭据；安装版 0.20.1 使用 `~/.pi-desktop/mcp-control.json`，并兼容 Electron 用户数据目录中的连接信息。连接文件须属于当前用户且仅当前用户可读写。无需将 Desktop token 填入 `.env`，更不能发送给 Relay 或手机。Desktop 未运行、未启用控制、连接信息失效或权限异常会明确报错，不会静默退回 CLI 或伪装为空会话列表。

## 支持范围

- 列表只包含本机 Desktop 拥有的会话，按更新时间排序；历史和当前会话使用同一个引用。
- 阅读用户和助手正文、分页历史以及工具的文字详情；隐藏思考、系统指令和内部元数据，不暴露附件路径或二进制内容。
- 新建 Desktop 会话，可以选择已在 Desktop 中打开的项目；未选择项目时使用 Pi Desktop 为该会话管理的临时目录，手机端显示为“临时目录”。不启动 Terminal、Pi CLI 或 OMP。
- 读取 Desktop 的模型目录，并在新建会话时选择模型；已有会话在空闲时可切换模型。选择只用 `provider` + `modelId` 标识，Desktop 端只修改这两个持久化字段，模式、思考级别、权限模式和标题保持不变。任务运行中或存在待审批计划时拒绝切换，不会先改模型再尝试回滚。
- 读取控制视图中的当前模型、会话权限模式与生效模式、运行状态和待处理请求。权限模式是只读的；手机不能修改它，也不能用模型切换操作顺带修改其他设置。
- 对待处理的工具权限选择“允许这一次”或“不允许”；对 AskTool 问题提交纯文本答案，或显式跳过某题（提交 `null`）。不提供 `allow-session`，不修改权限模式，也不处理 Plan/Goal 审批与扩展 UI 对话框。
- 向原 Desktop 会话继续发送文字；由 Desktop 处理上下文与持久化。发送确认只表示已接收，不表示任务完成。
- 停止映射为 Desktop 的 `agent/abort`；之后读取真实运行状态，不把控制请求成功当作已停止。
- 通过已有会话详情轮询更新输出；本机 MCP 不提供 SSE 事件流，不能宣称为逐 token 推送。控制视图与正文时间线分开读取：手机约每秒读取一次状态和待处理请求，正文仍按时间线节奏读取，两者互不携带对方内容。

模型目录、在新建时选择模型、已有会话模型切换、控制视图和远程审批分别由 `modelCatalog`、`modelSelectionOnCreate`、`modelSelection`、`sessionControls`、`remoteApprovals` 能力位表示。它们不是同一个开关：旧 Desktop 即使能列出模型，也不代表能安全切换已有会话或回应权限请求。

思考级别、权限模式、标题、附件及其他 Desktop 设置仍只能在 Desktop 中修改。手机不会调用任意 MCP 工具或通用 IPC。此处的完整管理范围指列表、阅读、新建、发送、停止，以及上述受限的模型与交互能力，不包含全部 Desktop 功能。

## 旧版 Desktop 与源码补丁

安装版 Pi Desktop 0.20.1 可以作为列表、阅读、新建、发送和停止的连接目标，但其本机 MCP 目录没有暴露待处理交互读取，也没有只改模型的会话操作，因此手机不能在这类实例上回应权限/问题，也不能安全切换已有会话的模型。模型目录与新建时选择模型同样按实际 MCP 操作目录探测；未暴露 `providers/list`、`providers/listModels` 或 `sessionCreate` 时，手机不显示对应入口，也不会假设其可用。不能用通用的 `session/configure` 冒充模型切换：它同时接受模式、思考级别和权限模式，可能连带改变权限策略。

这两项能力需要本次 Desktop 源码补丁。补丁基线是提交 `589e5803a7a9f4ebf7ec1e8849c43e44b4a198f7`（v0.21.0-beta.4）；它是在该基线上新增的候选改动，不表示上游已有发布版本包含这些能力。补丁由主会话导出到：

```text
docs/patches/pi-desktop-mobile-controls.patch
```

在 Desktop 源码根目录应用前，先确认工作区干净并停在基线上。以下命令按顺序单独执行：

```bash
git status --short
```

```bash
git checkout --detach 589e5803a7a9f4ebf7ec1e8849c43e44b4a198f7
```

```bash
git apply --check /path/to/pi-remote/docs/patches/pi-desktop-mobile-controls.patch
```

```bash
git apply /path/to/pi-remote/docs/patches/pi-desktop-mobile-controls.patch
```

上述命令只是文档说明，本轮不会自动执行，也不会切换、构建或安装用户正在运行的 Desktop。补丁包含 12 个已跟踪文件的改动和 3 个新增测试/文档，具体为：MCP 目录新增 `agent/pendingInteractive`（只读）和 `session/setModel`（危险操作），新增对应具名工具；待处理请求在 Electron Main 校验目标必须是本机 Desktop 会话并按会话过滤（原生 Pi 会话走自己的空结果路径，远端或未知引用拒绝），host-core 新增只改 `providerId`/`modelId` 的 `session.setModel`，保留模式、思考级别和权限模式。回退时删除应用补丁后的工作区改动并回到基线即可；不要用补丁覆盖用户未提交的其他改动。

## 数据与失败边界

Desktop 是唯一的执行与存储所有者。Agent 不直接打开或写入 `pi.sqlite`、会话 JSONL，不复制历史，不通过 SDK 恢复同一会话，也不会退出 Desktop。旧 CLI 代码仅为后续恢复开发保留，不在生产入口注册。

只连接经过验证的数字 loopback HTTP 地址，拒绝重定向。调用有超时和响应大小限制。正常关闭及初始化失败后的清理同样重新验证连接文件；连接已停用、消失或替换时不向旧端口发送缓存凭据。提交新建、发送、停止、模型切换或交互回应后的网络错误可能意味着 Desktop 已处理，但回执未到达；Agent 不自动重放这些操作。模型切换通过重新读取会话确认真实绑定；权限/问题回应只有 Desktop 明确返回成功确认后，手机才从待处理列表移除。回执不确定时手机保留请求、提示刷新核对，不承诺跨进程 exactly-once，也不把“请求已发出”显示为“已处理”。

单次读取同样受 Desktop 的响应大小上限约束。正文较多时，Agent 会逐级降低单条正文的读取上限，并在结果中说明当前为精简正文；会话保持在线，完整内容仍可在 Desktop 中查看。全部档位仍无法装下时返回明确的读取错误，手机只提示暂时无法读取并提供重试，不会把会话误判为离线。时间线锚点失效等需要重建的情况会自动改为完整刷新，不会持续重复失败。

## 参考与验证

接口依据：本机 Pi Desktop 0.20.1 安装包，只读参考仓库 `vastsa/PI-Desktop` 的 `f1daa54`，以及补丁候选基线 `589e5803a7a9f4ebf7ec1e8849c43e44b4a198f7`（v0.21.0-beta.4）。参考副本位于忽略的 `.reference/pi-desktop-source` 与 `.reference/pi-desktop-mobile-controls`，不作为本项目运行依赖；本轮只在这些副本中执行了定向测试，未运行完整构建、安装或 Desktop 启动脚本。

- `apps/desktop/electron/main/mcp-control.ts`：认证、初始化、具名工具、风险分级与有界响应；补丁新增 `agent/pendingInteractive`、`session/setModel` 及对应具名工具。
- `apps/desktop/electron/main/ipc/agent-ipc.ts`：待处理交互的来源校验、按会话过滤与解析器。
- `apps/desktop/electron/main/ipc/session-ipc.ts` 与 `crates/host-core/src/rpc/mod.rs`：只改模型的会话绑定、空闲/审批门禁与保留其他配置。
- `docs/adr/0203-local-mcp-control-plane.md`、`docs/adr/0332-mobile-session-controls-over-local-mcp.md`：本机控制面与本次受限扩展的安全边界。
- `docs/spec/03-runtime/01-ipc-protocol.md` §13d：MCP 操作、参数和兼容性契约。

截至 2026-10-19，iOS 最终 `build-for-testing`、五套 Swift 行为回归、Node 接入阶段 38 项及类型检查通过；最后能力故障修复另有 handler 12 项回归通过。Desktop 侧 13 项 MCP、8 项模型 IPC 和 3 项 pending scope 测试通过（子任务报告），Rust 最终 `session_set_model` 五项定向测试重新通过。15 文件源码补丁已导出，在基线临时副本完成应用检查及逐文件比对，并通过反向检查。

UI 最终结果为两项通过、一项失败：模型切换及正文失败仍可授权通过；问答测试在多行输入获得焦点后无法再次定位控件，尚未验证提交，大字体未验收。独立审查因 429 和工具拒绝未完成；完整 Desktop TS build/typecheck/restore 测试缺 i18next 等依赖，未运行。未安装、启动或联调真实 Desktop，未调用真实模型、部署或提交。准确结果和剩余限制见 [验证记录](mobile-controls-verification.md)，不能将隔离验证描述为已安装版本升级完成。
