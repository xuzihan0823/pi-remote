import Foundation

@main
struct SessionCreationTests {
    struct Failure: Error { let message: String }

    @MainActor
    final class Fixture {
        var frames: [[String: Any]] = []
        lazy var client = RelayClient(testFrameSink: { [weak self] in self?.frames.append($0) })

        func connect(agentConnected: Bool = true) throws {
            try client.receiveTestFrame(["type": "hello_ack", "payload": ["agentConnected": agentConnected]])
        }

        func requests(_ method: String) -> [[String: Any]] {
            frames.filter { ($0["payload"] as? [String: Any])?["method"] as? String == method }
        }

        func request(_ method: String) throws -> [String: Any] {
            guard let frame = requests(method).last else { throw Failure(message: "缺少请求：\(method)") }
            return frame
        }

        func respond(_ frame: [String: Any], data: [String: Any] = [:], error: [String: Any]? = nil) throws {
            let payload: [String: Any] = error.map { ["ok": false, "error": $0] } ?? ["ok": true, "data": data]
            try client.receiveTestFrame(["type": "response", "requestId": frame["requestId"]!, "payload": payload])
        }

        func nextSnapshot(after count: Int = 0) async throws -> [String: Any] {
            for _ in 0..<200 {
                if requests("session.get").count > count { return try request("session.get") }
                await Task.yield()
            }
            throw Failure(message: "终端未开始 session.get 轮询")
        }
    }

    @MainActor
    static func main() async throws {
        try await createsTerminalOnceAndPolls()
        try preservesRPCCompatibility()
        try acceptsTerminalIDWithoutSource()
        try failedCreationPreservesDraftAndAllowsRetry()
        try rejectsInvalidSource()
        try discardsOldCreationAfterSwitch()
        try leavingPageDoesNotActivateOrKillCreatedTerminal()
        try reconnectInvalidatesCreationWithSameActiveSession()
        try discardsOldCreationAfterDisconnectOrLeaving()
        try sendsOnlyToCreatedIDBeforeNavigation()
        try requiresMacConnection()
        try await terminalCommandsRespectActivityAndKeepHistory()
        try await resumesHistoryWithoutSendingPrompt()
        try historyResumeFailureAndStaleResponses()
        try await pendingRecoveryQueriesSameOperationAndNeverUnlocksEarly()
        try recoveryReconnectAndLateResultNeverLaunchAgainOrStealPage()
        try failedRecoveryRequiresExplicitNewOperation()
        try modelSwitchCallbacksAreSessionAndRequestScoped()
        try modelQueriesCannotOverwriteConfirmedSwitches()
        try modelSwitchTimeoutAndReconnectReconcileActualState()
        try await promptAcknowledgementPreservesDraft()
        try recoveredSessionSurvivesModelFailure()
        print("PASS: 新建模式、失败保留草稿、重复创建、旧回调隔离、首条消息路由与终端操作保护")
    }

    @MainActor
    static func createsTerminalOnceAndPolls() async throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try f.connect()
        var started: [String] = []
        f.client.startNewSession(prompt: "检查构建", cwd: " project ") { started.append($0) }
        f.client.startNewSession(prompt: "重复点击") { started.append($0) }
        try expect(f.client.isCreatingSession && f.requests("session.start").count == 1, "创建期间必须挡住重复点击")
        let start = try f.request("session.start")
        let params = (start["payload"] as? [String: Any])?["params"] as? [String: Any]
        try expect(params?["mode"] as? String == "terminal", "新建默认发送 terminal 模式")
        try expect(params?["cwd"] as? String == "project" && params?.count == 2, "只发模式和目录，不覆盖 Mac 运行时")
        let result: [String: Any] = ["sessionId": "terminal:new", "source": "terminal"]
        try f.respond(start, data: result)
        try f.respond(start, data: result)
        try expect(started == ["terminal:new"] && !f.client.isCreatingSession, "一次成功只导航一次")
        try expect(f.client.activeSessionSource == .terminal && f.client.activeSessionId == "terminal:new", "新建必须按 terminal 打开真实 ID")
        try expect(f.requests("subscribe").isEmpty && f.requests("session.prompt").count == 1, "terminal 不订阅 managed，首条消息只发一次")
        let prompt = try f.request("session.prompt")
        try expect(prompt["sessionId"] as? String == "terminal:new", "首条消息必须指向创建的 ID")
        try expect(!f.client.canSendPrompt, "快照尚未加载时不能继续发消息")
        let snapshot = try await f.nextSnapshot()
        try expect(snapshot["sessionId"] as? String == "terminal:new", "轮询真实终端 ID")
        try f.respond(snapshot, data: ["activity": "idle", "messages": []])
        await Task.yield()
        f.client.startTerminalPolling()
        try f.respond(prompt, error: ["message": "首条发送失败"])
        try expect(f.client.terminal.error == "首条发送失败", "进入会话页不能使首条消息回调失效")
    }

    @MainActor
    static func preservesRPCCompatibility() throws {
        for source in ["managed", nil] as [String?] {
            let f = Fixture()
            defer { f.client.disconnect() }
            try f.connect()
            f.client.startNewSession(prompt: "后台任务", mode: .rpc)
            let start = try f.request("session.start")
            let params = (start["payload"] as? [String: Any])?["params"] as? [String: Any]
            try expect(params?["mode"] as? String == "rpc", "后台会话显式使用 rpc")
            var data: [String: Any] = ["sessionId": "managed-1"]
            data["source"] = source
            try f.respond(start, data: data)
            try expect(f.client.activeSessionSource == .managed, "RPC 保留旧服务缺省 source 兼容")
            try expect(f.requests("subscribe").count == 1 && f.requests("session.prompt").count == 1, "RPC 订阅并发送首条消息")
        }
    }

    @MainActor
    static func acceptsTerminalIDWithoutSource() throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try f.connect()
        var started: String?
        f.client.startNewSession(prompt: "共享任务") { started = $0 }
        try f.respond(try f.request("session.start"), data: ["sessionId": "terminal:existing"])
        try expect(started == "terminal:existing" && f.client.activeSessionSource == .terminal, "无 source 但可信 terminal ID 可作为共享会话")
        try expect(f.requests("subscribe").isEmpty && f.requests("session.prompt").count == 1, "推断的终端仍只轮询，不订阅 managed")
    }

    @MainActor
    static func failedCreationPreservesDraftAndAllowsRetry() throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try f.connect()
        var started = false
        f.client.startNewSession(prompt: "不要丢失这条提示词") { _ in started = true }
        try f.respond(try f.request("session.start"), error: ["message": "无法启动终端"])
        try expect(!started && !f.client.isCreatingSession, "失败不导航，解除创建中状态以允许重试")
        try expect(f.client.lastError == "无法启动终端" && f.requests("session.prompt").isEmpty, "显示创建错误且不误发消息")

        // SwiftUI 草稿保留的静态回归；网络回调行为由上面的真实 RelayClient 检查。
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../PiRemote/Views/NewSessionView.swift")
        let view = try String(contentsOf: file, encoding: .utf8)
        guard let send = view.components(separatedBy: "private func send() {").dropFirst().first?
            .components(separatedBy: "private func chip").first else {
            throw Failure(message: "未找到新建页提交入口")
        }
        try expect(!send.contains("promptText ="), "提交请求或失败回调不能清空输入草稿")
        try expect(view.contains(".onDisappear { client.cancelSessionCreation() }"), "页面离开必须使创建回调失效")
        let root = try String(contentsOf: file.deletingLastPathComponent().appendingPathComponent("RootView.swift"), encoding: .utf8)
        guard let select = root.components(separatedBy: "onSessionSelected: { session in").dropFirst().first,
              let cancel = select.range(of: "relayClient.cancelSessionCreation()"),
              let open = select.range(of: "relayClient.openSession(session)") else {
            throw Failure(message: "侧边栏切换会话必须先取消创建回调")
        }
        try expect(cancel.lowerBound < open.lowerBound, "切换到其他会话前必须作废创建回调")
        f.client.startNewSession(prompt: "不要丢失这条提示词")
        try expect(f.requests("session.start").count == 2, "明确重试可重新创建")
    }

    @MainActor
    static func rejectsInvalidSource() throws {
        let responses: [[String: Any]] = [
            ["sessionId": "managed-1", "source": "managed"],
            ["sessionId": "legacy-managed-without-source"],
            ["sessionId": "managed-1", "source": "terminal"],
            ["sessionId": "terminal:"],
            ["sessionId": "terminal:   "],
            ["sessionId": "terminal:new", "source": "managed"],
        ]
        for data in responses {
            let f = Fixture()
            defer { f.client.disconnect() }
            try f.connect()
            var started = false
            f.client.startNewSession(prompt: "共享任务") { _ in started = true }
            try f.respond(try f.request("session.start"), data: data)
            try expect(f.client.activeSessionId == nil && f.client.lastError != nil, "无效 source/ID 不能被当成新终端")
            try expect(!started && !f.client.isCreatingSession && f.client.lastError?.contains("升级 Mac 助手") == true, "旧助手忽略 mode 必须提示升级，不导航或卡住输入")
            try expect(f.requests("subscribe").isEmpty && f.requests("session.prompt").isEmpty, "类型不匹配不订阅、不发送")
        }
    }

    @MainActor
    static func discardsOldCreationAfterSwitch() throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try f.connect()
        f.client.openSession(id: "A")
        var oldStarted = false
        f.client.startNewSession(prompt: "旧任务") { _ in oldStarted = true }
        let old = try f.request("session.start")
        f.client.openSession(id: "B")
        f.client.openSession(id: "A")
        f.client.startNewSession(prompt: "新任务")
        let current = try f.request("session.start")
        try f.respond(old, data: ["sessionId": "terminal:old", "source": "terminal"])
        try expect(!oldStarted && f.client.activeSessionId == "A" && f.client.isCreatingSession, "切走又切回仍需丢弃旧回调，不能解除新请求状态")
        try expect(f.requests("session.prompt").isEmpty, "过期创建不能发送首条消息")
        try f.respond(current, data: ["sessionId": "terminal:current", "source": "terminal"])
        try expect(f.client.activeSessionId == "terminal:current" && f.requests("session.prompt").count == 1, "只有当前创建可生效")
    }

    @MainActor
    static func leavingPageDoesNotActivateOrKillCreatedTerminal() throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try f.connect()
        f.client.openSession(id: "unchanged")
        var started = false
        f.client.startNewSession(prompt: "返回列表前提交的任务") { _ in started = true }
        let old = try f.request("session.start")
        f.client.cancelSessionCreation()
        let frameCount = f.frames.count
        try f.respond(old, data: ["sessionId": "terminal:created-after-leaving", "source": "terminal"])
        try expect(!started && f.client.activeSessionId == "unchanged", "activeSessionId 未变，页面退出后的成功回调仍不得导航")
        try expect(f.frames.count == frameCount, "过期成功回调不得发送 prompt、终止或删除已创建终端")

        f.client.refreshSessions()
        try f.respond(try f.request("session.list"), data: ["sessions": [[
            "sessionId": "terminal:created-after-leaving", "source": "terminal", "activity": "idle",
        ]]])
        guard let session = f.client.sessions.first else { throw Failure(message: "已创建终端应能从列表发现") }
        f.client.openSession(session)
        try expect(f.client.activeSessionId == "terminal:created-after-leaving" && f.client.isActiveTerminal, "保留的终端可由用户主动打开")
        try expect(f.requests("session.prompt").isEmpty, "主动进入保留终端也不补发旧提示词")
    }

    @MainActor
    static func reconnectInvalidatesCreationWithSameActiveSession() throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try f.connect()
        f.client.openSession(id: "unchanged")
        var started = false
        f.client.startNewSession(prompt: "旧连接的任务") { _ in started = true }
        let old = try f.request("session.start")
        f.client.reconnectForTesting()
        try f.connect()
        f.client.startNewSession(prompt: "新连接的任务")
        try f.respond(old, data: ["sessionId": "terminal:old", "source": "terminal"])
        try expect(!started && f.client.activeSessionId == "unchanged" && f.client.isCreatingSession, "同一活动会话重连后也应丢弃旧成功回调，保留新创建状态")
        try expect(f.requests("session.prompt").isEmpty && f.client.lastError == nil, "旧连接不得自动发送或污染新连接")
    }

    @MainActor
    static func discardsOldCreationAfterDisconnectOrLeaving() throws {
        for disconnect in [true, false] {
            let f = Fixture()
            defer { f.client.disconnect() }
            try f.connect()
            var started = false
            f.client.startNewSession(prompt: "旧任务") { _ in started = true }
            let old = try f.request("session.start")
            if disconnect {
                f.client.disconnect()
                try f.connect()
            } else {
                f.client.cancelSessionCreation()
            }
            f.client.startNewSession(prompt: "当前任务")
            try f.client.receiveTestFrame([
                "type": "error", "requestId": old["requestId"]!,
                "payload": ["error": ["message": "旧连接的失败"]],
            ])
            try expect(!started && f.client.lastError == nil && f.client.isCreatingSession, "重连或退出新建后，旧失败不能污染新请求")
            try expect(f.client.activeSessionId == nil && f.requests("session.prompt").isEmpty, "旧创建不切换会话、不发送")
        }
    }

    @MainActor
    static func sendsOnlyToCreatedIDBeforeNavigation() throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try f.connect()
        f.client.startNewSession(prompt: "仅发给新终端") { _ in f.client.openSession(id: "later-selection") }
        try f.respond(try f.request("session.start"), data: ["sessionId": "terminal:new", "source": "terminal"])
        let prompt = try f.request("session.prompt")
        try expect(prompt["sessionId"] as? String == "terminal:new" && f.requests("session.prompt").count == 1, "导航改变选择也不能误发或重发首条消息")
        try f.respond(prompt, error: ["message": "旧终端的错误"])
        try expect(f.client.activeSessionId == "later-selection" && f.client.terminal.error == nil, "延迟发送失败不污染后来选择的会话")
    }

    @MainActor
    static func requiresMacConnection() throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        f.client.startNewSession(prompt: "离线任务")
        try f.connect(agentConnected: false)
        f.client.startNewSession(prompt: "Mac 未连接")
        try expect(f.requests("session.start").isEmpty && !f.client.isCreatingSession, "Relay 在线但 Mac 离线仍禁止创建")
    }

    @MainActor
    static func terminalCommandsRespectActivityAndKeepHistory() async throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try f.connect()
        f.client.openSession(id: "terminal:existing", source: .terminal)
        f.client.sendPrompt("状态未知不发送")
        try expect(f.requests("session.prompt").isEmpty, "快照加载前不能发送")
        try f.respond(try await f.nextSnapshot(), data: ["activity": "busy", "messages": [["role": "user", "text": "历史消息"]]])
        for _ in 0..<200 where !f.client.terminal.loaded { await Task.yield() }
        try expect(!f.client.canSendPrompt && f.client.canAbortSession, "busy 禁止发送但允许停止")
        f.client.sendPrompt("busy 不自动 steer 或 followUp")
        try expect(f.requests("session.prompt").isEmpty, "busy 发送必须由服务层拦截")
        f.client.abortActiveSession()
        try expect(try f.request("session.abort")["sessionId"] as? String == "terminal:existing", "停止只发给当前终端")
        try f.respond(try f.request("session.abort"), error: ["code": "unknown_session", "message": "Unknown session"])
        try expect(f.client.terminal.error?.contains("已关闭") == true && f.client.terminal.error?.contains("选择新的会话") == true, "关闭/切换错误提供正确恢复指引")
        try expect(f.client.terminal.messages.first?.text == "历史消息", "终端失败保留历史")
        try expect(f.client.activeSessionId == "terminal:existing" && !f.client.canSendPrompt && !f.client.canAbortSession, "关闭终端不自动连接另一个会话")

        let count = f.requests("session.get").count
        f.client.stopTerminalPolling()
        f.client.startTerminalPolling()
        try f.respond(try await f.nextSnapshot(after: count), data: ["activity": "idle", "messages": []])
        for _ in 0..<200 where !f.client.canSendPrompt { await Task.yield() }
        try expect(f.client.canSendPrompt && !f.client.canAbortSession, "idle 恢复发送")
        f.client.sendPrompt("继续当前终端")
        try expect(f.requests("session.prompt").count == 1 && f.requests("subscribe").isEmpty, "终端仅使用 prompt 和 snapshot")
    }

    @MainActor
    static func resumesHistoryWithoutSendingPrompt() async throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try f.connect()
        try f.respond(try f.request("session.list"), data: ["sessions": [], "capabilities": ["historyResume": true]])
        f.client.openSession(id: "history:old", title: "旧对话", source: .terminal)
        let oldSnapshot = try await f.nextSnapshot()
        f.client.resumeActiveHistory()
        f.client.resumeActiveHistory()
        try expect(f.client.isResumingHistory && f.requests("session.start").count == 1, "恢复期间只发送一次请求")
        let start = try f.request("session.start")
        let params = (start["payload"] as? [String: Any])?["params"] as? [String: Any]
        try expect(params?["mode"] as? String == "terminal" && params?["historySessionId"] as? String == "history:old" && params?.count == 2,
                   "恢复仅发送别名与模式，不向手机暴露文件或指定目录")
        try f.respond(start, data: ["sessionId": "terminal:restored", "source": "terminal", "status": [
            "sessionId": "terminal:restored", "source": "terminal", "state": "running", "activity": "idle",
            "availability": "live", "canControl": true, "runtime": "omp",
        ]])
        try expect(f.client.activeSessionId == "terminal:restored" && !f.client.isActiveArchive && !f.client.isResumingHistory,
                   "恢复成功切换至真实终端，并清除只读与加载状态")
        try expect(f.requests("session.prompt").isEmpty && f.requests("session.abort").isEmpty, "恢复操作本身不得发送模型请求或停止任务")
        let snapshot = try await f.nextSnapshot(after: 1)
        try expect(snapshot["sessionId"] as? String == "terminal:restored", "恢复后轮询真实 ID")
        try f.respond(oldSnapshot, data: ["availability": "archived", "canControl": false, "activity": "unknown", "messages": []])
        try f.respond(snapshot, data: ["availability": "live", "canControl": true, "activity": "idle", "messages": []])
        await Task.yield()
        try expect(f.client.canSendPrompt, "收到实时快照后可继续发送，旧历史快照不能锁回只读")
    }

    @MainActor
    static func historyResumeFailureAndStaleResponses() throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try f.connect()
        f.client.openSession(id: "history:old", source: .terminal)
        f.client.resumeActiveHistory()
        try expect(f.requests("session.start").isEmpty, "旧 Mac 未协商能力时不能恢复")
        try f.respond(try f.request("session.list"), data: ["sessions": [], "capabilities": ["historyResume": true]])
        f.client.resumeActiveHistory()
        try f.respond(try f.request("session.start"), error: ["code": "session_busy", "message": "历史已被占用"])
        try expect(f.client.activeSessionId == "history:old" && f.client.lastError == "历史已被占用" && !f.client.isResumingHistory,
                   "恢复失败仍可读历史，展示原因并允许重试")
        f.client.resumeActiveHistory()
        let old = try f.request("session.start")
        f.client.openSession(id: "history:new", source: .terminal)
        try f.respond(old, data: ["sessionId": "terminal:late", "source": "terminal", "status": [
            "sessionId": "terminal:late", "source": "terminal", "availability": "live", "canControl": true,
        ]])
        try expect(f.client.activeSessionId == "history:new" && !f.client.isResumingHistory, "离开历史后迟到的恢复成功不得抢走当前会话")
        f.client.resumeActiveHistory()
        let invalid = try f.request("session.start")
        try f.respond(invalid, data: ["sessionId": "history:readonly", "source": "terminal", "status": [:]])
        try expect(f.client.activeSessionId == "history:new" && f.client.lastError != nil, "不能把只读历史响应误判为已恢复")
    }

    @MainActor
    static func pendingRecoveryQueriesSameOperationAndNeverUnlocksEarly() async throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try f.connect()
        try f.respond(try f.request("session.list"), data: ["sessions": [], "capabilities": ["historyResume": true, "historyRecoveryOperations": true]])
        f.client.openSession(id: "history:pending", source: .terminal)
        f.client.resumeActiveHistory()
        f.client.resumeActiveHistory()
        try expect(f.requests("session.start").count == 1, "重复点击不能重复发起恢复")
        let start = try f.request("session.start")
        let params = (start["payload"] as? [String: Any])?["params"] as? [String: Any] ?? [:]
        guard let operationId = params["operationId"] as? String else { throw Failure(message: "缺少稳定恢复操作 ID") }
        try expect(UUID(uuidString: operationId) != nil && params["recoveryVersion"] as? Int == 1, "新契约必须显式协商与携带有效操作 ID")
        try f.respond(start, data: ["operationId": operationId, "recoveryState": "pending", "phase": "waiting_bridge", "canRetry": false])
        try expect(f.client.isActiveArchive && !f.client.canSendPrompt && !f.client.canAbortSession && f.client.isResumingHistory, "pending 必须保持历史可读与输入锁定")
        try expect(f.client.historyResumeButtonTitle == "正在等待 OMP 桥接…", "按钮必须显示真实阶段")
        try await Task.sleep(for: .milliseconds(1100))
        let query = try f.request("session.start")
        let queryParams = (query["payload"] as? [String: Any])?["params"] as? [String: Any] ?? [:]
        try expect(queryParams["operationId"] as? String == operationId && queryParams["historySessionId"] == nil, "后续轮询只能查询原操作，不能再次启动")
        try f.respond(query, data: ["operationId": operationId, "recoveryState": "ready", "phase": "ready", "sessionId": "terminal:verified", "source": "terminal", "status": [
            "sessionId": "terminal:verified", "source": "terminal", "state": "running", "activity": "idle", "availability": "live", "canControl": true,
        ]])
        try expect(f.client.activeSessionId == "terminal:verified" && !f.client.isResumingHistory, "只有 ready 验证通过后才能进入运行会话")
        try expect(f.requests("session.prompt").isEmpty && f.requests("session.abort").isEmpty && f.requests("ui.response").isEmpty, "恢复不能发送、停止或自动审批")
    }

    @MainActor
    static func recoveryReconnectAndLateResultNeverLaunchAgainOrStealPage() throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        let capabilities: [String: Any] = ["historyResume": true, "historyRecoveryOperations": true]
        try f.connect()
        try f.respond(try f.request("session.list"), data: ["sessions": [], "capabilities": capabilities])
        f.client.openSession(id: "history:reconnect", source: .terminal)
        f.client.resumeActiveHistory()
        let start = try f.request("session.start")
        let operationId = ((start["payload"] as? [String: Any])?["params"] as? [String: Any])?["operationId"] as! String
        f.client.reconnectForTesting()
        try f.connect()
        try f.respond(try f.request("session.list"), data: ["sessions": [], "capabilities": capabilities])
        let query = try f.request("session.start")
        let params = (query["payload"] as? [String: Any])?["params"] as? [String: Any] ?? [:]
        try expect(params["operationId"] as? String == operationId && params["historySessionId"] == nil, "断线重连必须查询同一次操作")
        f.client.cancelSessionCreation()
        let frameCount = f.frames.count
        try f.respond(query, data: ["operationId": operationId, "recoveryState": "ready", "phase": "ready", "sessionId": "terminal:late", "source": "terminal", "status": [
            "sessionId": "terminal:late", "source": "terminal", "availability": "live", "canControl": true,
        ]])
        try expect(f.client.activeSessionId == "history:reconnect" && f.frames.count == frameCount, "离页后的迟到成功不能导航或追加控制请求")
        try expect(f.requests("session.abort").isEmpty && f.requests("session.prompt").isEmpty, "取消等待不能停止恢复进程")
    }

    @MainActor
    static func failedRecoveryRequiresExplicitNewOperation() throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try f.connect()
        try f.respond(try f.request("session.list"), data: ["sessions": [], "capabilities": ["historyResume": true, "historyRecoveryOperations": true]])
        f.client.openSession(id: "history:failure", source: .terminal)
        f.client.resumeActiveHistory()
        let start = try f.request("session.start")
        let original = ((start["payload"] as? [String: Any])?["params"] as? [String: Any])?["operationId"] as! String
        try f.respond(start, data: ["operationId": original, "recoveryState": "failed", "phase": "failed", "canRetry": true, "message": "OMP 提前退出"])
        try expect(!f.client.isResumingHistory && f.client.isActiveArchive && f.client.historyRecoveryMessage == "OMP 提前退出", "失败后仍可读历史并显示真实错误")
        try expect(f.client.historyResumeButtonTitle == "重试恢复", "只能对确认失败的结果提示重试")
        f.client.reconnectForTesting()
        try f.connect()
        try f.respond(try f.request("session.list"), data: ["sessions": [], "capabilities": ["historyResume": true, "historyRecoveryOperations": true]])
        let query = try f.request("session.start")
        let queryParams = (query["payload"] as? [String: Any])?["params"] as? [String: Any] ?? [:]
        try expect(queryParams["operationId"] as? String == original && queryParams["historySessionId"] == nil && queryParams["retry"] == nil, "确认失败后的自动重连只能查询，不能隐式重试")
        try f.respond(query, data: ["operationId": original, "recoveryState": "failed", "phase": "failed", "canRetry": true, "message": "OMP 提前退出"])
        f.client.resumeActiveHistory()
        let retry = (try f.request("session.start")["payload"] as? [String: Any])?["params"] as? [String: Any] ?? [:]
        try expect(retry["operationId"] as? String != original && retry["retry"] as? Bool == true && retry["historySessionId"] as? String == "history:failure", "用户重试必须显式创建新操作并重新授权历史")
    }

    private static let modelA = RemoteModel(provider: "test", modelId: "A", name: "模型 A")
    private static let modelB = RemoteModel(provider: "test", modelId: "B", name: "模型 B")

    @MainActor
    private static func enableModels(_ f: Fixture) throws {
        try f.connect()
        try f.respond(try f.request("session.list"), data: ["capabilities": ["modelSelection": true], "sessions": []])
    }

    private static func modelData(_ model: RemoteModel) -> [String: Any] {
        ["model": ["provider": model.provider, "modelId": model.modelId, "name": model.name],
         "models": [modelA.selection, modelB.selection]]
    }

    @MainActor
    static func modelSwitchCallbacksAreSessionAndRequestScoped() throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try enableModels(f)
        f.client.openSession(id: "A")
        try f.respond(try f.request("model.list"), data: modelData(modelA))
        f.client.setActiveModel(modelB)
        let old = try f.request("session.set_model")
        try expect(f.client.isSwitchingModel && !f.client.canSendPrompt, "切换期间禁止发送")
        f.client.openSession(id: "B")
        try expect(!f.client.isSwitchingModel, "A 的切换不能锁住 B")
        f.client.setActiveModel(modelB)
        let bSwitch = try f.request("session.set_model")
        try f.respond(old, data: modelData(modelB))
        try expect(f.client.isSwitchingModel && f.client.activeModel == nil, "旧 A 回调不能结束 B 的切换")
        f.client.openSession(id: "A")
        f.client.setActiveModel(modelA)
        let latest = try f.request("session.set_model")
        try f.respond(bSwitch, error: ["code": "session_busy", "message": "旧失败"])
        try expect(f.client.isSwitchingModel && f.client.lastError == nil, "A→B→A 旧回调不能解除新操作")
        try f.respond(latest, data: modelData(modelA))
        try expect(!f.client.isSwitchingModel && f.client.activeModel?.id == modelA.id, "新切换可以正常完成")
    }

    @MainActor
    static func modelQueriesCannotOverwriteConfirmedSwitches() throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try enableModels(f)
        f.client.openSession(id: "A")
        let oldList = try f.request("model.list")
        f.client.setActiveModel(modelB)
        try f.respond(try f.request("session.set_model"), data: modelData(modelB))
        try f.respond(oldList, data: modelData(modelA))
        try expect(f.client.activeModel?.id == modelB.id, "旧查询不能覆盖已确认的新模型")
        f.client.setActiveModel(modelA)
        try expect(f.requests("session.set_model").count == 2, "能够切回原模型")
        try f.respond(try f.request("session.set_model"), data: modelData(modelA))
        f.client.refreshActiveModels()
        let first = try f.request("model.list")
        f.client.refreshActiveModels()
        try f.respond(try f.request("model.list"), data: modelData(modelB))
        try f.respond(first, data: modelData(modelA))
        try expect(f.client.activeModel?.id == modelB.id, "只接受最新查询")
    }

    @MainActor
    static func modelSwitchTimeoutAndReconnectReconcileActualState() throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try enableModels(f)
        f.client.openSession(id: "A")
        f.client.setActiveModel(modelB)
        f.client.expireRequestForTesting(try f.request("session.set_model")["requestId"] as! String)
        try expect(!f.client.isSwitchingModel && !f.client.canSendPrompt, "超时解除切换锁，但状态确认前不发送")
        try f.respond(try f.request("model.list"), data: modelData(modelB))
        try expect(f.client.canSendPrompt && f.client.activeModel?.id == modelB.id, "超时后读取实际已生效模型")
        f.client.setActiveModel(modelA)
        let oldSwitch = try f.request("session.set_model")
        f.client.reconnectForTesting()
        try expect(!f.client.isSwitchingModel, "重连复位切换状态")
        try enableModels(f)
        let oldList = try f.request("model.list")
        f.client.setActiveModel(modelB)
        let current = try f.request("session.set_model")
        try f.respond(oldSwitch, data: modelData(modelA))
        try f.respond(oldList, data: modelData(modelA))
        try expect(f.client.isSwitchingModel, "旧连接响应及早期查询不能解除新切换")
        try f.respond(current, data: modelData(modelB))
        f.client.refreshActiveModels()
        let previousDeviceList = try f.request("model.list")
        f.client.disconnect()
        try expect(!f.client.isSwitchingModel, "主动断连复位")
        try enableModels(f)
        f.client.openSession(id: "A")
        try f.respond(try f.request("model.list"), data: modelData(modelB))
        try f.respond(previousDeviceList, data: modelData(modelA))
        try expect(f.client.activeModel?.id == modelB.id, "断连或设备切换不接受旧连接模型")
    }

    @MainActor
    static func promptAcknowledgementPreservesDraft() async throws {
        for source in [SessionSource.managed, .terminal] {
            let f = Fixture()
            defer { f.client.disconnect() }
            try enableModels(f)
            f.client.openSession(id: source == .terminal ? "terminal:A" : "A", source: source)
            try f.respond(try f.request("model.list"), data: modelData(modelA))
            if source == .terminal {
                try f.respond(try await f.nextSnapshot(), data: ["activity": "idle", "messages": []])
                for _ in 0..<200 where !f.client.terminal.loaded { await Task.yield() }
            }
            var draft = "保留原草稿"
            let send: () -> Void = {
                let submitted = draft
                f.client.sendPrompt(submitted) { result in
                    if case .success = result, draft == submitted { draft = "" }
                }
            }
            f.client.setActiveModel(modelB)
            send()
            try expect(f.requests("session.prompt").isEmpty && draft == "保留原草稿", "切模型时不能发送或丢草稿")
            try f.respond(try f.request("session.set_model"), data: modelData(modelB))
            send()
            try expect(draft == "保留原草稿" && !f.client.canSendPrompt, "确认前保留草稿并阻止双击")
            try f.respond(try f.request("session.prompt"), error: ["code": "session_busy", "message": "明确拒绝"])
            try expect(draft == "保留原草稿", "明确拒绝保留原草稿")
            send()
            f.client.expireRequestForTesting(try f.request("session.prompt")["requestId"] as! String)
            try expect(draft == "保留原草稿" && f.requests("session.prompt").count == 2, "未知结果不自动重发")
            try expect(f.client.lastError?.contains("发送结果尚未确认") == true, "未知投递需要明确提示")
            if source == .terminal {
                let count = f.requests("session.get").count
                f.client.stopTerminalPolling()
                f.client.startTerminalPolling()
                try f.respond(try await f.nextSnapshot(after: count), data: ["activity": "idle", "messages": []])
                for _ in 0..<200 where !f.client.canSendPrompt { await Task.yield() }
            }
            send()
            try f.respond(try f.request("session.prompt"), data: ["queued": true])
            try expect(draft.isEmpty, "只有真实成功确认才清空原草稿")
            draft = "已提交的草稿"
            send()
            draft = "发送等待中修改的新草稿"
            try f.respond(try f.request("session.prompt"), data: ["queued": true])
            try expect(draft == "发送等待中修改的新草稿", "晚到成功不得清空后来编辑的草稿")
            send()
            let latePrompt = try f.request("session.prompt")
            if source == .terminal { f.client.stopTerminalPolling() } else { f.client.openSession(id: "B") }
            try expect(!f.client.isSendingPrompt, "退页或换会话解除等待，不停止后端任务")
            try f.respond(latePrompt, data: ["queued": true])
            try expect(draft == "发送等待中修改的新草稿", "离开后的确认不得清空草稿")
        }
        let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../PiRemote/Views/ConversationView.swift")
        let view = try String(contentsOf: path, encoding: .utf8)
        let send = view.components(separatedBy: "private func send() {")[1].components(separatedBy: "private func followOutput")[0]
        try expect(send.contains("if case .success = result, inputText == draft"), "页面必须在确认成功且草稿未编辑时才清空")
    }

    @MainActor
    static func recoveredSessionSurvivesModelFailure() throws {
        for operations in [false, true] {
            let f = Fixture()
            defer { f.client.disconnect() }
            try f.connect()
            try f.respond(try f.request("session.list"), data: ["sessions": [], "capabilities": ["historyResume": true, "historyRecoveryOperations": operations]])
            f.client.openSession(id: "history:model-failure", source: .terminal)
            f.client.pendingDraft = "恢复后要发送的草稿"
            f.client.resumeActiveHistory()
            let start = try f.request("session.start")
            var response: [String: Any] = ["sessionId": "terminal:restored", "source": "terminal", "status": [
                "sessionId": "terminal:restored", "source": "terminal", "availability": "live", "canControl": true,
            ], "modelSelection": ["applied": false, "model": NSNull(), "error": ["code": "session_busy", "message": "模型正在使用中"]]]
            if operations {
                let params = (start["payload"] as? [String: Any])?["params"] as? [String: Any]
                response["operationId"] = params?["operationId"]
                response["recoveryState"] = "ready"
                response["phase"] = "ready"
            }
            try f.respond(start, data: response)
            try expect(f.client.activeSessionId == "terminal:restored", "模型失败不能丢弃真实恢复 ID")
            try expect(f.client.pendingDraft == "恢复后要发送的草稿", "模型失败保留草稿")
            try expect(f.client.lastError?.contains("模型正在使用中") == true, "模型结果与恢复结果分别展示")
            try expect(f.requests("session.start").count == 1 && f.requests("session.prompt").isEmpty, "不得再次恢复或误发第一条消息")
        }
    }

    private static func expect(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(message: message) }
    }
}
