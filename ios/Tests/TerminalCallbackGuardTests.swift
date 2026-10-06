import Foundation

@main
struct TerminalCallbackGuardTests {
    struct Failure: Error {
        let message: String
    }

    static func main() throws {
        try sameSessionSameGenerationIsCurrent()
        try switchedSessionIsStale()
        try regeneratedPollingIsStale()
        try disconnectedOrReconnectedIsStale()
        print("PASS: 终端 sendPrompt/abort 过期回调判定（会话切换与代次递增）全部通过")
    }

    /// 同一会话、轮询代次未变：回调有效。
    static func sameSessionSameGenerationIsCurrent() throws {
        try expect(
            RelayClient.isStaleTerminalCompletion(
                requestSessionId: "terminal:A",
                requestGeneration: 3,
                currentSessionId: "terminal:A",
                currentGeneration: 3
            ) == false,
            "同会话同代次的回调不应被判为过期"
        )
    }

    /// 会话 A 的指令延迟失败时已切到会话 B：必须判为过期，否则会污染 B 的终端状态。
    static func switchedSessionIsStale() throws {
        try expect(
            RelayClient.isStaleTerminalCompletion(
                requestSessionId: "terminal:A",
                requestGeneration: 3,
                currentSessionId: "terminal:B",
                currentGeneration: 4
            ),
            "切换到其他会话后，A 的失败回调应被丢弃"
        )
        try expect(
            RelayClient.isStaleTerminalCompletion(
                requestSessionId: "terminal:A",
                requestGeneration: 3,
                currentSessionId: "sess-managed",
                currentGeneration: 5
            ),
            "切到受管会话后，终端的失败回调应被丢弃"
        )
    }

    /// 同一会话但轮询已重启（离开会话页再进入 / 重连）：旧代次回调仍应丢弃。
    static func regeneratedPollingIsStale() throws {
        try expect(
            RelayClient.isStaleTerminalCompletion(
                requestSessionId: "terminal:A",
                requestGeneration: 3,
                currentSessionId: "terminal:A",
                currentGeneration: 6
            ),
            "同一会话但代次已递增（轮询重启）时旧回调应被丢弃"
        )
    }

    static func disconnectedOrReconnectedIsStale() throws {
        try expect(
            RelayClient.isStaleTerminalCompletion(
                requestSessionId: "terminal:A",
                requestGeneration: 4,
                currentSessionId: nil,
                currentGeneration: 5
            ),
            "断开连接后没有当前会话，旧回调应被丢弃"
        )
    }

    private static func expect(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(message: message) }
    }
}
