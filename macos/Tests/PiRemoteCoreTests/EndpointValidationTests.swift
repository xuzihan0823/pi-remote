import XCTest
@testable import PiRemoteCore

final class EndpointValidationTests: XCTestCase {
    func testAcceptsPublicAgentURL() throws {
        let url = try EndpointValidator.validateWebSocket("wss://pi.anyyu.cyou/ws/agent", expectedPath: .agent)
        XCTAssertEqual(url.absoluteString, "wss://pi.anyyu.cyou/ws/agent")
    }

    func testAcceptsLocalAgentURLWithPort() throws {
        let url = try EndpointValidator.validateWebSocket("ws://127.0.0.1:8789/ws/agent", expectedPath: .agent)
        XCTAssertEqual(url.port, 8789)
    }

    func testRejectsNonWebSocketScheme() {
        XCTAssertThrowsError(try EndpointValidator.validateWebSocket("https://pi.anyyu.cyou/ws/agent", expectedPath: .agent))
        XCTAssertThrowsError(try EndpointValidator.validateWebSocket("http://pi.anyyu.cyou/ws/agent", expectedPath: .agent))
    }

    func testRejectsWrongPath() {
        XCTAssertThrowsError(try EndpointValidator.validateWebSocket("wss://pi.anyyu.cyou/ws/ios", expectedPath: .agent))
        XCTAssertThrowsError(try EndpointValidator.validateWebSocket("wss://pi.anyyu.cyou/ws/agent", expectedPath: .ios))
        XCTAssertThrowsError(try EndpointValidator.validateWebSocket("wss://pi.anyyu.cyou/", expectedPath: .agent))
        XCTAssertThrowsError(try EndpointValidator.validateWebSocket("wss://pi.anyyu.cyou/ws/agent/extra", expectedPath: .agent))
    }

    func testRejectsUserinfoQueryAndFragment() {
        XCTAssertThrowsError(try EndpointValidator.validateWebSocket("wss://user:pass@pi.anyyu.cyou/ws/agent", expectedPath: .agent))
        XCTAssertThrowsError(try EndpointValidator.validateWebSocket("wss://pi.anyyu.cyou/ws/agent?token=abcdef", expectedPath: .agent))
        XCTAssertThrowsError(try EndpointValidator.validateWebSocket("wss://pi.anyyu.cyou/ws/agent#frag", expectedPath: .agent))
    }

    func testRejectsWhitespaceAndEmptyHost() {
        XCTAssertThrowsError(try EndpointValidator.validateWebSocket("wss://pi.anyyu.cyou /ws/agent", expectedPath: .agent))
        XCTAssertThrowsError(try EndpointValidator.validateWebSocket("", expectedPath: .agent))
    }

    func testRejectsOutOfRangePort() {
        XCTAssertThrowsError(try EndpointValidator.validateWebSocket("wss://pi.anyyu.cyou:70000/ws/agent", expectedPath: .agent))
    }

    func testTokenRequires32CharactersWithoutWhitespace() throws {
        let valid = String(repeating: "a", count: 32)
        XCTAssertEqual(try EndpointValidator.validateToken(valid), valid)
        XCTAssertThrowsError(try EndpointValidator.validateToken(String(repeating: "a", count: 31)))
        XCTAssertThrowsError(try EndpointValidator.validateToken(String(repeating: "a", count: 31) + " "))
        XCTAssertThrowsError(try EndpointValidator.validateToken("aaaa bbbb cccc dddd eeee ffff gggg hhhh"))
    }

    func testHealthURLMapping() throws {
        let agentURL = try EndpointValidator.validateWebSocket("wss://pi.anyyu.cyou/ws/agent", expectedPath: .agent)
        XCTAssertEqual(try EndpointValidator.healthURL(forAgentURL: agentURL).absoluteString, "https://pi.anyyu.cyou/api/health")

        let localURL = URL(string: "ws://127.0.0.1:8789/ws/agent")!
        XCTAssertEqual(try EndpointValidator.healthURL(forAgentURL: localURL).absoluteString, "http://127.0.0.1:8789/api/health")
    }

    func testIOSURLMappingKeepsHostAndPort() throws {
        let agentURL = URL(string: "wss://random-name.trycloudflare.com/ws/agent")!
        XCTAssertEqual(
            try EndpointValidator.iosURL(forAgentURL: agentURL).absoluteString,
            "wss://random-name.trycloudflare.com/ws/ios"
        )
    }
}
