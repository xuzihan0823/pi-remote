import Foundation

@main
struct SessionParsingTests {
    struct Failure: Error {
        let message: String
    }

    static func main() throws {
        try parsesManagedAndTerminalFields()
        try legacySessionsDefaultToManagedUnknown()
        try onlyBusyOrPendingCountAsRunning()
        try terminalSnapshotReplacesInsteadOfAppending()
        try resetIsolatesSwitchedSessions()
        try failedTerminalSnapshotIsOffline()
        print("PASS: session.list 字段解析、运行判定与终端快照行为全部通过")
    }

    static func parsesManagedAndTerminalFields() throws {
        let managed = try require(SessionItem(remote: [
            "sessionId": "sess-1",
            "state": "running",
            "source": "managed",
            "title": "修复登录跳转",
            "cwd": "/Users/mac/projects/app",
            "activity": "busy",
        ]))
        try expect(managed.source == .managed, "source=managed")
        try expect(managed.activity == .busy, "activity=busy")
        try expect(managed.title == "修复登录跳转", "title 来自 server")
        try expect(managed.cwd == "/Users/mac/projects/app", "cwd 保留")
        try expect(managed.isTerminal == false, "managed 不是 terminal")

        let terminal = try require(SessionItem(remote: [
            "sessionId": "terminal:9f0c1d2e-3456-4abc-8def-0123456789ab",
            "state": "running",
            "source": "terminal",
            "title": "pi · pi-remote",
            "cwd": "/Users/mac/Desktop/pi-remote",
            "activity": "idle",
        ]))
        try expect(terminal.isTerminal, "terminal 会话被识别")
        try expect(terminal.subtitle == "空闲", "idle 终端显示空闲")
        try expect(SessionItem(remote: ["sessionId": "t", "source": "terminal", "activity": "busy"])?.subtitle == "正在运行", "busy 终端显示正在运行")
        try expect(SessionItem(remote: ["sessionId": "t", "source": "terminal", "activity": "unknown"])?.subtitle == "离线", "unknown 终端显示离线")

        let localTitle = SessionItem(remote: ["sessionId": "sess-2", "title": "server 标题"], localTitle: "本地标题")
        try expect(localTitle?.title == "本地标题", "本地标题优先于 server 标题")
    }

    static func legacySessionsDefaultToManagedUnknown() throws {
        let legacy = try require(SessionItem(remote: ["sessionId": "sess-3", "state": "running"]))
        try expect(legacy.source == .managed, "缺失 source 时按 managed")
        try expect(legacy.activity == .unknown, "缺失 activity 时为 unknown，不伪造 busy")
        try expect(legacy.isActive == false, "旧 server 的 running 进程不等于进行中")
        try expect(SessionFilter.running.matches(legacy) == false, "旧 server 会话不进入进行中筛选")
        try expect(SessionItem(remote: ["sessionId": "x", "activity": "something-new"])?.activity == .unknown, "未知 activity 归为 unknown")
    }

    static func onlyBusyOrPendingCountAsRunning() throws {
        let idle = try require(SessionItem(remote: ["sessionId": "a", "state": "running", "activity": "idle"]))
        let busy = try require(SessionItem(remote: ["sessionId": "b", "state": "running", "activity": "busy"]))
        let pending = try require(SessionItem(remote: ["sessionId": "c", "state": "running", "activity": "idle"], hasPendingApproval: true))

        try expect(idle.isActive == false && idle.status != .running, "idle 不算运行")
        try expect(busy.isActive && busy.status == .running, "busy 算运行")
        try expect(pending.isActive && pending.status == .approval, "等待回应算进行中")

        try expect(SessionFilter.running.matches(idle) == false, "进行中筛选排除 idle")
        try expect(SessionFilter.running.matches(busy), "进行中筛选包含 busy")
        try expect(SessionFilter.waiting.matches(pending), "待回应筛选包含等待确认")
    }

    static func terminalSnapshotReplacesInsteadOfAppending() throws {
        var state = TerminalSessionState()
        state.apply([
            "sessionId": "terminal:x",
            "activity": "idle",
            "truncated": false,
            "messages": [
                ["role": "user", "text": "帮我看下构建"],
                ["role": "assistant", "text": "好的，正在检查。"],
            ],
        ])
        try expect(state.messages.count == 2, "首帧解析两条消息")
        try expect(state.messages.first?.role == "user", "首条是 user")
        try expect(state.messages.last?.text == "好的，正在检查。", "assistant 文本保留")

        state.apply([
            "sessionId": "terminal:x",
            "activity": "busy",
            "truncated": true,
            "messages": [
                ["role": "user", "text": "帮我看下构建"],
                ["role": "assistant", "text": "好的，正在检查。"],
                ["role": "assistant", "text": "构建失败，正在定位。"],
            ],
        ])
        try expect(state.messages.count == 3, "第二次快照原子替换为 3 条，而不是追加成 5 条")
        try expect(state.messages.last?.text == "构建失败，正在定位。", "末尾流式 partial 更新")
        try expect(state.activity == .busy && state.isBusy, "activity 更新为 busy")
        try expect(state.truncated, "truncated 标记保留")

        state.apply([
            "sessionId": "terminal:x",
            "activity": "idle",
            "truncated": false,
            "messages": "not-an-array",
        ])
        try expect(state.messages.isEmpty, "异常 messages 字段被安全忽略")
        try expect(state.loaded, "已完成一次读取")

        state.apply(["activity": "idle", "messages": [["role": "user", "text": "x"], ["text": "缺少 role"]]])
        try expect(state.messages.count == 1, "缺少 role 的消息被跳过")
    }

    static func resetIsolatesSwitchedSessions() throws {
        var state = TerminalSessionState()
        state.apply(["activity": "busy", "messages": [["role": "assistant", "text": "会话 A 的内容"]]])

        state.reset()
        try expect(state.messages.isEmpty && state.activity == .unknown && !state.loaded, "切换会话后清空旧快照")

        state.apply(["activity": "idle", "messages": [["role": "user", "text": "会话 B"]]])
        try expect(state.messages.count == 1 && state.messages[0].text == "会话 B", "新会话不会混入旧会话消息")
        try expect(state.isOffline == false, "已加载且 activity=idle 不是离线")
    }

    static func failedTerminalSnapshotIsOffline() throws {
        var state = TerminalSessionState()
        state.apply(["activity": "busy", "truncated": true, "messages": [["role": "user", "text": "保留历史"]]])
        state.fail("此会话已关闭或已在 Mac 上切换，请返回会话列表选择新的会话。")
        try expect(state.isOffline, "读取失败视为离线")
        try expect(state.error?.contains("已关闭") == true, "错误信息清晰保留")
        try expect(state.messages.first?.text == "保留历史" && state.truncated, "失败保留历史和裁剪标记")
        try expect(state.isBusy == false, "失败不伪造 busy")

        state.apply(["activity": "idle", "messages": []])
        try expect(state.error == nil && !state.isOffline, "重连恢复后自动清除离线状态")
    }

    private static func require<T>(_ value: T?) throws -> T {
        guard let value else { throw Failure(message: "Expected a value, got nil") }
        return value
    }

    private static func expect(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(message: message) }
    }
}
