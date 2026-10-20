import Foundation

@main
struct DesktopControlsClientTests {
    struct Failure: Error { let message: String }

    @MainActor
    final class Fixture {
        var frames: [[String: Any]] = []
        lazy var client = RelayClient(testFrameSink: { [weak self] in self?.frames.append($0) })

        func connect(_ capabilities: [String: Any]? = nil, agentConnected: Bool = true) throws {
            let selected = capabilities ?? Fixture.capabilities
            try client.receiveTestFrame(["type": "hello_ack", "payload": ["agentConnected": agentConnected]])
            try respond(try request("session.list"), data: ["capabilities": selected, "sessions": []])
        }

        func requests(_ method: String, view: String? = nil, sessionId: String? = nil) -> [[String: Any]] {
            frames.filter { frame in
                guard let payload = frame["payload"] as? [String: Any],
                      payload["method"] as? String == method else { return false }
                if let sessionId, frame["sessionId"] as? String != sessionId { return false }
                if let view,
                   (payload["params"] as? [String: Any])?["view"] as? String != view { return false }
                return true
            }
        }

        func request(_ method: String) throws -> [String: Any] {
            guard let frame = requests(method).last else { throw Failure(message: "缺少请求：\(method)") }
            return frame
        }

        func respond(_ frame: [String: Any], data: [String: Any] = [:], error: [String: Any]? = nil) throws {
            let payload: [String: Any] = error.map { ["ok": false, "error": $0] } ?? ["ok": true, "data": data]
            try client.receiveTestFrame(["type": "response", "requestId": frame["requestId"]!, "payload": payload])
        }

        func nextControls(after count: Int = 0, sessionId: String? = nil) async throws -> [String: Any] {
            for _ in 0..<300 {
                let controls = requests("session.get", view: "controls", sessionId: sessionId)
                if controls.count > count { return controls[count] }
                try await Task.sleep(for: .milliseconds(10))
            }
            throw Failure(message: "未收到 controls 轮询")
        }

        func nextTimeline(after count: Int = 0) async throws -> [String: Any] {
            for _ in 0..<300 {
                let timeline = requests("session.get", view: "timeline")
                if timeline.count > count { return timeline[count] }
                try await Task.sleep(for: .milliseconds(10))
            }
            throw Failure(message: "未收到 timeline 轮询")
        }

        func nextSessionList(after count: Int = 0) async throws -> [String: Any] {
            for _ in 0..<300 {
                let lists = requests("session.list")
                if lists.count > count { return lists[count] }
                try await Task.sleep(for: .milliseconds(10))
            }
            throw Failure(message: "未收到 session.list")
        }

        static let capabilities: [String: Any] = [
            "sessionScope": "pi-desktop", "desktopSessions": true, "sessionCreation": true,
            "timelineV2": true, "timelineAnchors": false,
            "modelCatalog": true, "modelSelection": false, "modelSelectionOnCreate": false,
            "sessionControls": true, "remoteApprovals": true,
            "projectDirectoryBrowsing": false,
        ]
    }

    static let idA = "managed:desktop:controls-a"
    static let idB = "managed:desktop:controls-b"

    @MainActor
    static func main() async throws {
        try await controlsAndTimelineFailuresAreIndependent()
        try await interactionIdentityAndStaleSessionCallbacksAreScoped()
        try await disconnectMakesPendingInteractionsUnusable()
        try await responseFailureKeepsPendingAndDoesNotRetry()
        try await submissionTimeoutInvalidatesConfirmationWithoutRetry()
        try await acknowledgementDoesNotResurrectOldSnapshotOrSubmitTwice()
        try await multiplePendingInteractionsUseExactPayloads()
        try await promptGateUsesControlsOnlyForSupportedDesktop()
        try await controlsPollingDoesNotOverlapAndStopsWithPage()
        try await controlsModelReadsRespectModelSwitches()
        try await controlsPendingUpdatesSessionListConservatively()
        print("PASS: Desktop controls 轮询、身份隔离、提交确认、发送门禁与生命周期全部通过")
    }

    @MainActor
    static func controlsAndTimelineFailuresAreIndependent() async throws {
        let failingControls = Fixture()
        defer { failingControls.client.disconnect() }
        try failingControls.connect()
        failingControls.client.openSession(id: idA)
        let controls = try await failingControls.nextControls()
        let timeline = try await failingControls.nextTimeline()
        try failingControls.respond(controls, error: ["code": "internal_error", "message": "controls down"])
        try failingControls.respond(timeline, data: ["activity": "busy", "canControl": true, "messages": []])
        for _ in 0..<100 where failingControls.client.desktopControlsError == nil || !failingControls.client.terminal.loaded {
            await Task.yield()
        }
        try expect(failingControls.client.desktopControlsError?.contains("controls down") == true,
                   "controls 失败必须单独暴露")
        try expect(!failingControls.client.desktopControlsConfirmed, "controls 失败视为未确认")
        try expect(failingControls.client.terminal.error == nil && failingControls.client.terminal.activity == .busy,
                   "controls 失败不能污染正文或时间线")
        try expect(failingControls.client.canAbortSession, "controls 失败不能阻塞停止")
        try expect(!failingControls.client.canSendPrompt, "controls 未确认时 Desktop 不能发送")

        let failingTimeline = Fixture()
        defer { failingTimeline.client.disconnect() }
        try failingTimeline.connect()
        failingTimeline.client.openSession(id: idB)
        let controls2 = try await failingTimeline.nextControls()
        let timeline2 = try await failingTimeline.nextTimeline()
        try failingTimeline.respond(timeline2, error: ["code": "unknown_session", "message": "body failed"])
        try failingTimeline.respond(controls2, data: snapshot(idB, pending: []))
        for _ in 0..<100 where failingTimeline.client.desktopControlsError != nil || !failingTimeline.client.terminal.loaded {
            await Task.yield()
        }
        try expect(failingTimeline.client.terminal.error != nil, "正文失败保留正文错误")
        try expect(failingTimeline.client.desktopControlsError == nil && failingTimeline.client.desktopControlsConfirmed,
                   "正文失败不能连锁清空 controls")
    }

    @MainActor
    static func interactionIdentityAndStaleSessionCallbacksAreScoped() async throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try f.connect()
        f.client.openSession(id: idA)
        let first = try await f.nextControls(sessionId: idA)
        try f.respond(first, data: snapshot(idA, pending: [permission(idA, requestId: "same")]))
        try await waitUntil("A controls confirmed") { f.client.desktopControlsConfirmed }
        let oldInteraction = try require(f.client.pendingDesktopInteractions.first)
        try expect(oldInteraction.sessionId == idA, "A 的请求属于 A")

        f.client.refreshDesktopControls()
        let staleA = try await f.nextControls(after: 1, sessionId: idA)
        f.client.openSession(id: idB)
        let controlsB = try await f.nextControls(sessionId: idB)
        try f.respond(staleA, data: snapshot(idA, pending: [permission(idA, requestId: "same")]))
        try f.respond(controlsB, data: snapshot(idB, pending: [permission(idB, requestId: "same")]))
        try await waitUntil("B controls confirmed") {
            f.client.desktopControlsConfirmed && f.client.desktopControls?.sessionId == idB
        }
        let newInteraction = try require(f.client.pendingDesktopInteractions.first)
        try expect(newInteraction.sessionId == idB && newInteraction.requestId == "same", "B 的同 requestId 仍属于 B")
        try expect(newInteraction.id != oldInteraction.id, "相同 requestId 跨会话必须区分身份")

        let responseCount = f.requests("ui.response").count
        f.client.respondToDesktopPermission(oldInteraction, allow: true)
        try expect(f.requests("ui.response").count == responseCount, "旧会话请求不能回应到新会话")
    }

    @MainActor
    static func disconnectMakesPendingInteractionsUnusable() async throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try f.connect()
        f.client.openSession(id: idA)
        let controls = try await f.nextControls()
        try f.respond(controls, data: snapshot(idA, pending: [permission(idA, requestId: "pending")]))
        try await waitUntil("pending confirmed") { f.client.canRespondDesktopInteraction }
        let interaction = try require(f.client.pendingDesktopInteractions.first)

        f.client.disconnect()
        try expect(!f.client.desktopControlsConfirmed, "断线必须清除 controls 确认")
        try expect(!f.client.canRespondDesktopInteraction, "断线后 pending 不可点")
        let responseCount = f.requests("ui.response").count
        f.client.respondToDesktopPermission(interaction, allow: true)
        try expect(f.requests("ui.response").count == responseCount, "断线后不能发出回应")
    }

    @MainActor
    static func responseFailureKeepsPendingAndDoesNotRetry() async throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try f.connect()
        f.client.openSession(id: idA)
        let controls = try await f.nextControls()
        try f.respond(controls, data: snapshot(idA, pending: [permission(idA, requestId: "deny-me")]))
        try await waitUntil("pending confirmed") { f.client.canRespondDesktopInteraction }
        let interaction = try require(f.client.pendingDesktopInteractions.first)

        f.client.respondToDesktopPermission(interaction, allow: false)
        let response = try f.request("ui.response")
        let params = (response["payload"] as? [String: Any])?["params"] as? [String: Any]
        try expect(params?["requestId"] as? String == "deny-me", "回应绑定 requestId")
        let body = params?["response"] as? [String: Any]
        try expect(body?["kind"] as? String == "permission" && body?["decision"] as? String == "deny",
                   "permission 回应使用 allow-once/deny")
        try expect(f.client.isSubmittingDesktopInteraction && !f.client.canRespondDesktopInteraction,
                   "提交中禁止重复点击")

        try f.respond(response, error: ["code": "internal_error", "message": "明确失败"])
        try await waitUntil("submission failure handled") { !f.client.isSubmittingDesktopInteraction }
        try expect(f.client.pendingDesktopInteractions.contains(interaction), "失败必须保留 pending 与答案")
        try expect(f.client.desktopInteractionError?.contains("明确失败") == true, "非传输失败保留服务端原因")
        try expect(!f.client.desktopControlsConfirmed && !f.client.canRespondDesktopInteraction,
                   "失败后必须等新的 controls 回执才能再次回应")
        try expect(f.requests("ui.response").count == 1, "失败不自动重发")

        f.client.respondToDesktopPermission(interaction, allow: true)
        try expect(f.requests("ui.response").count == 1, "新快照确认前再次点击不能发出回应")

        for frame in f.requests("session.get", view: "controls").dropFirst() {
            try f.respond(frame, data: snapshot(idA, pending: [permission(idA, requestId: "deny-me")]))
        }
        try await waitUntil("fresh controls confirmed") {
            f.client.desktopControlsConfirmed && f.client.canRespondDesktopInteraction
        }
        try expect(f.client.pendingDesktopInteractions.contains(interaction),
                   "新快照仍含 pending 时保留请求")
        f.client.respondToDesktopPermission(interaction, allow: true)
        try expect(f.requests("ui.response").count == 2, "新快照确认 pending 后允许手动再次提交")
    }

    @MainActor
    static func submissionTimeoutInvalidatesConfirmationWithoutRetry() async throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try f.connect()
        f.client.openSession(id: idA)
        let controls = try await f.nextControls()
        try f.respond(controls, data: snapshot(idA, pending: [permission(idA, requestId: "timeout")]))
        try await waitUntil("pending confirmed") { f.client.canRespondDesktopInteraction }
        let interaction = try require(f.client.pendingDesktopInteractions.first)

        f.client.respondToDesktopPermission(interaction, allow: true)
        let response = try f.request("ui.response")
        f.client.expireRequestForTesting(response["requestId"] as! String)
        try await waitUntil("timeout handled") { !f.client.isSubmittingDesktopInteraction }
        try expect(!f.client.desktopControlsConfirmed, "超时后必须使 controls 确认失效")
        try expect(f.client.pendingDesktopInteractions.contains(interaction), "超时保留 pending 由 UI 重试")
        try expect(f.client.desktopInteractionError?.contains("无法确认处理结果") == true,
                   "超时显示结果未知，需刷新核对")
        try expect(f.client.desktopInteractionError?.contains("未送达") != true,
                   "超时不能声称请求未送达")
        try expect(f.requests("ui.response").count == 1, "超时不能自动重发")
    }

    @MainActor
    static func acknowledgementDoesNotResurrectOldSnapshotOrSubmitTwice() async throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try f.connect()
        f.client.openSession(id: idA)
        let controls = try await f.nextControls()
        let pending = [permission(idA, requestId: "ack-once")]
        try f.respond(controls, data: snapshot(idA, pending: pending))
        try await waitUntil("pending confirmed") { f.client.canRespondDesktopInteraction }
        let interaction = try require(f.client.pendingDesktopInteractions.first)

        f.client.refreshDesktopControls()
        let staleSnapshot = try await f.nextControls(after: 1)

        f.client.respondToDesktopPermission(interaction, allow: true)
        f.client.respondToDesktopPermission(interaction, allow: false)
        try expect(f.requests("ui.response").count == 1, "同一 interaction 不能重复提交")
        let acknowledgement = try f.request("ui.response")
        try f.respond(acknowledgement, data: ["acknowledged": true])
        try await waitUntil("ack removes pending") { !f.client.isSubmittingDesktopInteraction }
        try expect(f.client.pendingDesktopInteractions.isEmpty, "ACK 成功后移除对应 pending")

        try f.respond(staleSnapshot, data: snapshot(idA, pending: pending))
        for _ in 0..<50 { await Task.yield() }
        try expect(f.client.pendingDesktopInteractions.isEmpty, "成功前发出的旧快照不能复活 pending")
    }

    @MainActor
    static func multiplePendingInteractionsUseExactPayloads() async throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try f.connect()
        f.client.openSession(id: idA)
        let controls = try await f.nextControls()
        let questionInteraction = questionData(
            idA,
            requestId: "question-1",
            questions: [
                ["question": "选一个", "multiSelect": false, "options": [["label": "A"], ["label": "B"]]],
                ["question": "直接输入", "multiSelect": false, "options": []],
            ]
        )
        try f.respond(controls, data: snapshot(idA, pending: [
            permission(idA, requestId: "permission-1"),
            questionInteraction,
        ]))
        try await waitUntil("two pending") { f.client.pendingDesktopInteractions.count == 2 }
        try expect(f.client.canRespondDesktopInteraction, "多个 pending 时可逐项回应")
        let question = try require(f.client.pendingDesktopInteractions.first { $0.question != nil })
        let permission = try require(f.client.pendingDesktopInteractions.first { $0.permission != nil })

        f.client.respondToDesktopQuestion(question, answers: [["A"]])
        try expect(f.requests("ui.response").isEmpty && f.client.desktopInteractionError != nil,
                   "回答数量不符时不能发送")

        f.client.respondToDesktopQuestion(question, answers: [["A"], nil])
        let questionResponse = try f.request("ui.response")
        let questionParams = (questionResponse["payload"] as? [String: Any])?["params"] as? [String: Any]
        let questionBody = questionParams?["response"] as? [String: Any]
        let answers = questionBody?["answers"] as? [Any]
        try expect(questionParams?["requestId"] as? String == "question-1", "问题回应绑定 requestId")
        try expect(questionBody?["kind"] as? String == "question", "问题回应 kind 正确")
        try expect(answers?.count == 2, "回答数量与题目一致")
        try expect((answers?[0] as? [String]) == ["A"], "选项回答保留真实 label")
        try expect(answers?[1] is NSNull, "纯文本/未回答位置编码为 null")
        try f.respond(questionResponse, data: ["acknowledged": true])
        try await waitUntil("question removed") { !f.client.isSubmittingDesktopInteraction }
        try expect(!f.client.pendingDesktopInteractions.contains(question), "问题处理后移除对应项")
        try expect(f.client.pendingDesktopInteractions.contains(permission), "其他 pending 保留")

        f.client.respondToDesktopPermission(permission, allow: true)
        let permissionResponse = try f.request("ui.response")
        let permissionParams = (permissionResponse["payload"] as? [String: Any])?["params"] as? [String: Any]
        try expect((permissionParams?["response"] as? [String: Any])?["decision"] as? String == "allow-once",
                   "允许一次使用 allow-once")
    }

    @MainActor
    static func promptGateUsesControlsOnlyForSupportedDesktop() async throws {
        let supported = Fixture()
        defer { supported.client.disconnect() }
        try supported.connect()
        supported.client.openSession(id: idA)
        let controls = try await supported.nextControls()
        try supported.respond(controls, data: snapshot(idA, pending: [permission(idA, requestId: "gate")]))
        try await waitUntil("controls confirmed") { supported.client.desktopControlsConfirmed }
        try expect(supported.client.canRespondDesktopInteraction,
                   "回应能力不依赖正文 loaded/idle")
        try expect(!supported.client.canSendPrompt, "controls 未就绪或存在 pending 时不能发送")
        try supported.respond(try await supported.nextTimeline(), data: ["activity": "idle", "canControl": true, "messages": []])
        for _ in 0..<50 { await Task.yield() }
        try expect(!supported.client.canSendPrompt, "有 pending 时即使正文 idle 也不能发送")

        let interaction = try require(supported.client.pendingDesktopInteractions.first)
        supported.client.respondToDesktopPermission(interaction, allow: true)
        try supported.respond(try supported.request("ui.response"), data: ["acknowledged": true])
        try await waitUntil("pending cleared") { supported.client.pendingDesktopInteractions.isEmpty }
        try expect(supported.client.canSendPrompt, "pending 清空且 controls 已确认后恢复发送")

        let legacy = Fixture()
        defer { legacy.client.disconnect() }
        var oldCapabilities = Fixture.capabilities
        oldCapabilities["sessionControls"] = false
        try legacy.connect(oldCapabilities)
        legacy.client.openSession(id: idB)
        try legacy.respond(try await legacy.nextTimeline(), data: ["activity": "idle", "canControl": true, "messages": []])
        for _ in 0..<50 { await Task.yield() }
        try expect(legacy.requests("session.get", view: "controls").isEmpty, "旧服务不启动 controls 轮询")
        try expect(legacy.client.canSendPrompt, "旧服务 supportsSessionControls=false 保留原发送行为")
    }

    @MainActor
    static func controlsPollingDoesNotOverlapAndStopsWithPage() async throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try f.connect()
        f.client.openSession(id: idA)
        let first = try await f.nextControls()
        f.client.refreshDesktopControls()
        try await Task.sleep(for: .milliseconds(80))
        try expect(f.requests("session.get", view: "controls").count == 1, "请求未完成时不能重叠轮询")

        try await Task.sleep(for: .milliseconds(1200))
        try expect(f.requests("session.get", view: "controls").count == 1, "无响应时仍保持单请求在途")
        try f.respond(first, data: snapshot(idA, pending: []))
        try await waitUntil("controls response applied") { f.client.desktopControlsConfirmed }

        try await Task.sleep(for: .milliseconds(1200))
        let count = f.requests("session.get", view: "controls").count
        try expect(count >= 2, "每秒继续轮询")
        f.client.stopTerminalPolling()
        try expect(!f.client.desktopControlsConfirmed, "停轮询即失效确认")
        try await Task.sleep(for: .milliseconds(1200))
        try expect(f.requests("session.get", view: "controls").count == count, "页面停止后不再轮询 controls")
    }

    @MainActor
    static func controlsModelReadsRespectModelSwitches() async throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        var capabilities = Fixture.capabilities
        capabilities["modelSelection"] = true
        capabilities["modelCatalog"] = true
        try f.connect(capabilities)
        f.client.openSession(id: idA)
        let controls = try await f.nextControls()

        try f.respond(controls, data: snapshot(idA, pending: [], model: modelA.selection))
        try await waitUntil("controls model applied") { f.client.activeModel?.id == modelA.id }

        f.client.setActiveModel(modelB)
        try expect(f.client.isSwitchingModel, "模型切换进行中")
        f.client.refreshDesktopControls()
        let duringSwitch = try await f.nextControls(after: 1)

        try f.respond(try f.request("session.set_model"), data: ["model": modelB.selection])
        try await waitUntil("switch confirmed") { f.client.activeModel?.id == modelB.id }
        try f.respond(duringSwitch, data: snapshot(idA, pending: [], model: modelA.selection))
        for _ in 0..<50 { await Task.yield() }
        try expect(f.client.activeModel?.id == modelB.id, "切换后的旧 controls 读取不能覆盖已确认模型")
    }

    @MainActor
    static func controlsPendingUpdatesSessionListConservatively() async throws {
        let f = Fixture()
        defer { f.client.disconnect() }
        try f.connect()

        func entry(pending: Bool?, known: Bool?) -> [String: Any] {
            var row: [String: Any] = [
                "sessionId": idA, "source": "managed", "runtime": "pi-desktop",
                "activity": "idle", "canControl": true, "title": "Controls A",
            ]
            if let pending { row["hasPendingApproval"] = pending }
            if let known { row["pendingStateKnown"] = known }
            return row
        }

        var listCount = f.requests("session.list").count
        f.client.refreshSessions()
        try f.respond(try await f.nextSessionList(after: listCount), data: [
            "capabilities": Fixture.capabilities, "sessions": [entry(pending: false, known: false)],
        ])
        try await waitUntil("session list loaded") { f.client.sessions.contains { $0.id == idA } }

        f.client.openSession(id: idA)
        let controls = try await f.nextControls()
        try f.respond(controls, data: snapshot(idA, pending: [permission(idA, requestId: "list-pending")]))
        try await waitUntil("controls pending applied to list") {
            f.client.sessions.first { $0.id == idA }?.hasPendingApproval == true
        }

        listCount = f.requests("session.list").count
        f.client.refreshSessions()
        try f.respond(try await f.nextSessionList(after: listCount), data: [
            "capabilities": Fixture.capabilities,
            "sessions": [entry(pending: false, known: false)],
        ])
        for _ in 0..<100 where f.client.sessions.first(where: { $0.id == idA })?.hasPendingApproval != true {
            await Task.yield()
        }
        try expect(f.client.sessions.first { $0.id == idA }?.hasPendingApproval == true,
                   "pendingStateKnown=false 不能清除已知待回应状态")

        listCount = f.requests("session.list").count
        f.client.refreshSessions()
        try f.respond(try await f.nextSessionList(after: listCount), data: [
            "capabilities": Fixture.capabilities,
            "sessions": [entry(pending: nil, known: nil)],
        ])
        for _ in 0..<100 where f.client.sessions.first(where: { $0.id == idA })?.hasPendingApproval != true {
            await Task.yield()
        }
        try expect(f.client.sessions.first { $0.id == idA }?.hasPendingApproval == true,
                   "连接模式未提供 pending 信息时保守保留旧状态")

        let controlsCount = f.requests("session.get", view: "controls").count
        f.client.refreshDesktopControls()
        let next = try await f.nextControls(after: controlsCount)
        try f.respond(next, data: snapshot(idA, pending: []))
        try await waitUntil("empty controls clears list pending") {
            f.client.sessions.first { $0.id == idA }?.hasPendingApproval == false
        }

        listCount = f.requests("session.list").count
        f.client.refreshSessions()
        try f.respond(try await f.nextSessionList(after: listCount), data: [
            "capabilities": Fixture.capabilities,
            "sessions": [entry(pending: true, known: true)],
        ])
        for _ in 0..<100 where f.client.sessions.first(where: { $0.id == idA })?.hasPendingApproval != true {
            await Task.yield()
        }
        try expect(f.client.sessions.first { $0.id == idA }?.hasPendingApproval == true,
                   "已知远端 pending 仍可建立待回应状态")

        listCount = f.requests("session.list").count
        f.client.refreshSessions()
        try f.respond(try await f.nextSessionList(after: listCount), data: [
            "capabilities": Fixture.capabilities,
            "sessions": [entry(pending: false, known: true)],
        ])
        for _ in 0..<100 where f.client.sessions.first(where: { $0.id == idA })?.hasPendingApproval != false {
            await Task.yield()
        }
        try expect(f.client.sessions.first { $0.id == idA }?.hasPendingApproval == false,
                   "明确已知的 false 可以清除旧待回应状态")
    }

    static func snapshot(
        _ sessionId: String,
        pending: [[String: Any]],
        model: [String: Any]? = nil,
        interactionsSupported: Bool = true,
        canControl: Bool = true,
        activity: String = "idle"
    ) -> [String: Any] {
        [
            "sessionId": sessionId,
            "permission": ["mode": "ask", "effectiveMode": "ask"],
            "model": model ?? NSNull(),
            "pendingInteractions": pending,
            "interactionsSupported": interactionsSupported,
            "canControl": canControl,
            "activity": activity,
        ]
    }

    static func permission(_ sessionId: String, requestId: String) -> [String: Any] {
        [
            "kind": "permission",
            "requestId": requestId,
            "sessionId": sessionId,
            "toolName": "shell",
            "reason": "需要执行命令",
            "argsPreview": "git status",
        ]
    }

    static func questionData(_ sessionId: String, requestId: String, questions: [[String: Any]]) -> [String: Any] {
        [
            "kind": "question",
            "requestId": requestId,
            "sessionId": sessionId,
            "questions": questions,
        ]
    }

    private static let modelA = RemoteModel(provider: "test", modelId: "A", name: "模型 A")
    private static let modelB = RemoteModel(provider: "test", modelId: "B", name: "模型 B")

    private static func waitUntil(_ message: String, _ condition: () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw Failure(message: message)
    }

    private static func require<T>(_ value: T?) throws -> T {
        guard let value else { throw Failure(message: "Expected a value, got nil") }
        return value
    }

    private static func expect(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(message: message) }
    }
}
