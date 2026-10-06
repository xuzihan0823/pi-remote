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
            .components(separatedBy: "private func suggestionCard").first else {
            throw Failure(message: "未找到新建页提交入口")
        }
        try expect(!send.contains("promptText ="), "提交请求或失败回调不能清空输入草稿")
        try expect(view.contains(".onDisappear { client.cancelSessionCreation() }"), "页面离开必须使创建回调失效")
        guard let backAction = view.components(separatedBy: "Button {").dropFirst().first?
            .components(separatedBy: "} label:").first,
              let cancel = backAction.range(of: "client.cancelSessionCreation()"),
              let navigate = backAction.range(of: "onBackTapped()") else {
            throw Failure(message: "返回按钮必须先取消创建回调，再导航")
        }
        try expect(cancel.lowerBound < navigate.lowerBound, "返回列表必须在页面退出动画前作废回调")
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

    private static func expect(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(message: message) }
    }
}
