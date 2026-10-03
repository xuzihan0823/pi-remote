import XCTest
@testable import PiRemoteCore

final class DotEnvImportTests: XCTestCase {
    func testExtractsOnlyKnownKeys() {
        let text = """
        # comment
        export RELAY_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        AGENT_TOKEN="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        RELAY_URL=wss://pi.anyyu.cyou/ws/agent
        PI_BIN=/usr/local/bin/pi
        PI_WORKSPACE_ROOT=/Users/tester/Desktop
        SECRET_EXTRA=should-be-ignored
        RELAY_PORT=8789
        MAX_SESSIONS=8
        """
        let values = DotEnv.extract(text)
        XCTAssertEqual(values.relayToken, String(repeating: "a", count: 32))
        XCTAssertEqual(values.agentToken, String(repeating: "b", count: 32))
        XCTAssertEqual(values.relayURL, "wss://pi.anyyu.cyou/ws/agent")
        XCTAssertEqual(values.piBin, "/usr/local/bin/pi")
        XCTAssertEqual(values.workspaceRoot, "/Users/tester/Desktop")
        XCTAssertEqual(values.effectiveToken, String(repeating: "b", count: 32))
    }

    func testIgnoresShellSyntaxInsteadOfExecutingIt() {
        let text = """
        RELAY_TOKEN=$(cat /etc/passwd)
        PI_BIN=`whoami`
        """
        let values = DotEnv.extract(text)
        XCTAssertEqual(values.relayToken, "$(cat /etc/passwd)")
        XCTAssertEqual(values.piBin, "`whoami`")
    }

    func testHandlesQuotesCommentsAndBlankLines() {
        let text = """
        AGENT_TOKEN='single-quoted-token-value-1234567890'

        RELAY_URL="wss://example.com/ws/agent"  # trailing comment
        PI_BIN=/usr/local/bin/pi # inline comment
        """
        let values = DotEnv.extract(text)
        XCTAssertEqual(values.agentToken, "single-quoted-token-value-1234567890")
        XCTAssertEqual(values.relayURL, "wss://example.com/ws/agent")
        XCTAssertEqual(values.piBin, "/usr/local/bin/pi")
    }

    func testEffectiveTokenFallsBackToRelayToken() {
        XCTAssertEqual(
            DotEnvValues(relayToken: "relay-token-value").effectiveToken,
            "relay-token-value"
        )
        XCTAssertNil(DotEnvValues().effectiveToken)
    }
}
