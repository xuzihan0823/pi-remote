import Foundation

@main
struct HistoryTimelineTests {
    struct Failure: Error { let message: String }
    static func expect(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(message: message) }
    }
    static func page(_ ids: [String], branch: String = "branch", revision: String = "rev", before: String? = nil) -> [String: Any] {
        ["viewVersion": 2, "branchId": branch, "revision": revision, "availability": "archived", "canControl": false,
         "items": ids.map { ["id": $0, "kind": "message", "role": "assistant", "text": $0] },
         "page": ["hasMoreBefore": before != nil, "before": before as Any]]
    }

    @MainActor static func main() async throws {
        var state = TerminalSessionState()
        state.apply(page(["b", "c"], before: "earlier"))
        try expect(state.items.map(\.id) == ["b", "c"] && state.messages.isEmpty, "v2 优先 items，不重复渲染 messages")
        state.apply(page(["a", "b"], before: nil), prepend: true)
        try expect(state.items.map(\.id) == ["a", "b", "c"], "跨页重叠只能按稳定 ID 合并一次")
        state.apply(page(["b", "c"]))
        try expect(state.items.map(\.id) == ["a", "b", "c"], "重复轮询不得丢掉已加载的较早页")
        state.apply(page(["wrong"], revision: "changed"), prepend: true)
        try expect(!state.items.contains { $0.id == "wrong" } && state.error != nil, "过期分页不得混入当前阅读内容")
        state.apply(page(["sibling"], branch: "other"))
        try expect(state.items.map(\.id) == ["sibling"], "切换分支必须清除旧分支")
        try expect(!state.canControl && !state.isOffline, "历史未知运行状态不能被误判成在线或可控制")
        state.reset()
        var live = page(["persisted", "stream:1:1:block-0"])
        live["availability"] = "live"; live["canControl"] = true; live["activity"] = "busy"
        state.apply(live)
        var final = page(["persisted", "finished"])
        final["availability"] = "live"; final["canControl"] = true; final["activity"] = "idle"
        state.apply(final)
        try expect(state.items.map(\.id) == ["persisted", "finished"], "流式落盘后不得留下 provisional 重复消息")
        state.reset()
        var latest = page(["c", "d"], before: "latest-boundary")
        latest["availability"] = "live"
        state.apply(latest)
        var earlier = page(["a", "b", "c"], before: "earliest-boundary")
        earlier["availability"] = "live"
        state.apply(earlier, prepend: true)
        state.apply(latest)
        try expect(state.before == "earliest-boundary", "实时轮询不得把更早页游标退回最新页边界")
        earlier["page"] = ["hasMoreBefore": false]
        state.apply(earlier, prepend: true)
        state.apply(latest)
        try expect(state.before == nil && !state.hasMoreBefore, "已读到开头后不能因轮询重新显示重复分页")

        var frames: [[String: Any]] = []
        let client = RelayClient(testFrameSink: { frames.append($0) })
        defer { client.disconnect() }
        try client.receiveTestFrame(["type": "hello_ack", "payload": ["agentConnected": true]])
        let list = frames.first { (($0["payload"] as? [String: Any])?["method"] as? String) == "session.list" }!
        let payload = list["payload"] as! [String: Any]
        try expect((payload["params"] as? [String: Any])?.isEmpty == true, "新手机必须先以旧方法探测能力")
        try client.receiveTestFrame(["type": "response", "requestId": list["requestId"]!, "payload": ["ok": true, "data": [
            "sessions": [], "capabilities": ["timelineV2": true, "ompArchiveRead": true]]]])
        try expect(client.supportsArchive && client.supportsTimeline, "能力协商须启用历史和时间线")
        let negotiated = frames.last { (($0["payload"] as? [String: Any])?["method"] as? String) == "session.list" }!
        let negotiatedParams = (negotiated["payload"] as! [String: Any])["params"] as! [String: Any]
        try expect(negotiatedParams["includeArchived"] as? Bool == true && negotiatedParams["viewVersion"] as? Int == 2, "确认能力后才请求历史")
        let archive = SessionItem(remote: ["sessionId": "history:fixture", "source": "terminal", "availability": "archived", "activity": "busy", "canControl": false])!
        try expect(archive.isArchived && !archive.isActive && SessionFilter.history.matches(archive), "历史不能归入正在运行")
        client.openSession(archive)
        await Task.yield()
        try expect(!client.canSendPrompt && !client.canAbortSession, "历史不得获得控制权")
        let initialCount = frames.count
        client.sendPrompt("must not send")
        client.abortActiveSession()
        client.respondToUiRequest(ApprovalRequest(id: "fake", method: "confirm", title: "test", message: "test"), approved: true)
        try expect(frames.count == initialCount, "历史 prompt/abort/ui.response 不得发出控制帧")
        let snapshotsBefore = frames.filter { (($0["payload"] as? [String: Any])?["method"] as? String) == "session.get" }.count
        client.startTerminalPolling()
        await Task.yield()
        let snapshotsAfter = frames.filter { (($0["payload"] as? [String: Any])?["method"] as? String) == "session.get" }.count
        try expect(snapshotsBefore == snapshotsAfter, "历史不能启动每两秒终端轮询")
        print("PASS: Swift 时间线稳定 ID／重叠分页／分支重置／流式消重／能力协商／历史只读")
    }
}
