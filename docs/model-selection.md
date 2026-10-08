# 模型选择后端接口

这些接口服务于新建、续接和运行中会话的模型选择。本次只实现后端；iOS 尚未调用这些接口。
模型选择作用于当前会话，通过运行时 API 记录，不修改 Mac 的全局默认模型，不发送提示词。
已在隔离配置下验证 OMP 18.6.3、Pi 0.86.1 的扩展和 RPC 切换，以及默认配置保持不变。

## 能力发现

`session.list` 返回的 `capabilities` 新增：

- `modelSelection: true`：Mac 助手认识模型查询、切换和带模型的新建请求。
- `modelCatalog: true`：支持尚未启动会话时查询模型目录。

单个终端会话另有 `capabilities.modelSelection`，只有运行时提供模型查询、切换 API 时才为 `true`。
旧桥接返回 `not_implemented`，需更新扩展并在终端空闲时执行 `/reload`。
中继和 Mac 助手均需更新；协议版本仍为 1，旧请求保持原行为。

## 数据结构

选择模型统一使用精确标识，不传任意 CLI 参数或模糊别名：

```json
{ "provider": "my-provider", "modelId": "my-model" }
```

返回的模型包含 `provider`、`modelId`、`name`，可选 `reasoning`、`contextWindow`。
完整运行时对象不会发送到手机，API key、headers 和 baseUrl 不在返回字段中。
不要仅以 `modelId` 区分模型，相同模型可以属于不同供应商。

## 查询模型列表：`model.list`

新建前不传 `sessionId`，可传以下 `params`：

```json
{ "mode": "terminal", "cwd": "project" }
```

`mode` 默认 `terminal`，也支持 `rpc`；`cwd` 可省略，使用默认工作区。
目录必须真实存在且位于工作区内。终端模式复用启动终端的环境白名单，后台模式使用 Mac agent 的环境。
OMP 调用 `models --json`，Pi 调用 `--list-models`，不创建对话进程。

续接前使用历史别名，读取该历史所属项目的模型目录：

```json
{ "historySessionId": "history:..." }
```

此时不能传 `cwd` 或后台模式。查询仅校验并读取历史，不恢复会话。

上述两种查询返回 `{ "models": [...] }`，不把某个模型猜测为实际会话模型。
项目扩展及运行时配置可能改变可用模型，最终切换仍在目标会话内校验。

已有会话传帧级 `sessionId`，不要同时传新建参数：

```json
{
  "version": 1, "type": "request", "requestId": "models-1",
  "sessionId": "terminal:...",
  "payload": { "method": "model.list" }
}
```

返回 `{ "sessionId": "...", "models": [...], "model": {...} }`；无当前模型时 `model` 为 `null`。
列表来自该会话的运行时，包含已配置凭据的可用模型，不代表外部 API 当前一定可连接。

## 查询当前模型：`session.get_model`

必须传实时会话的 `sessionId`，不需要 `params`。
返回 `{ "sessionId": "...", "model": {...} }`，没有模型时为 `null`。
此接口读取实时状态，因此可同步用户在 Mac 上做出的模型切换。
历史别名不接受此接口；先恢复为实时会话再查询。

## 切换模型：`session.set_model`

```json
{
  "version": 1, "type": "request", "requestId": "model-2",
  "sessionId": "terminal:...",
  "payload": {
    "method": "session.set_model",
    "params": { "model": { "provider": "my-provider", "modelId": "my-model" } }
  }
}
```

成功返回 `{ "sessionId": "...", "model": {...} }`，确认读取到所选模型后才报告成功。
同一会话切换期间，第二次切换和手机发送提示词返回 `session_busy`。
任务执行、压缩或待处理消息期间不能切换；终端以运行时的空闲状态为准。
无效模型返回 `invalid_frame`；历史别名、冲突副本不能被用来控制会话。

## 新建和续接：`session.start` 的可选 `model`

新建：

```json
{ "mode": "terminal", "cwd": "project", "model": { "provider": "my-provider", "modelId": "my-model" } }
```

续接：

```json
{ "mode": "terminal", "historySessionId": "history:...", "model": { "provider": "my-provider", "modelId": "my-model" } }
```

后台新建同样支持 `model`。不传 `model` 时完全沿用原来的默认或恢复行为，响应也不增加 `modelSelection`。
传入模型时，后端先取得真实会话，再切换模型，`data` 额外返回：

```json
{ "modelSelection": { "applied": true, "model": { "provider": "my-provider", "modelId": "my-model", "name": "My Model" } } }
```

如果会话已创建或已恢复，但模型切换失败，仍返回 `ok: true` 和真实 `sessionId`，同时返回：

```json
{ "modelSelection": { "applied": false, "model": null, "error": { "code": "invalid_frame", "message": "所选模型不可用，请刷新模型列表" } } }
```

**前端必须检查 `modelSelection.applied` 后再发送第一条消息。** 失败时保留草稿和返回的会话 ID，
查询当前状态或对该 ID 重试 `session.set_model`，不要再次调用 `session.start`。
格式错误在创建前就拒绝；合法标识是否可用，由实际会话校验。

超时或切换后的校验失败不代表运行时一定未执行切换。应先查询当前模型再重试。
创建请求本身超时沿用既有行为：先刷新会话列表确认结果，再决定是否重新创建。
