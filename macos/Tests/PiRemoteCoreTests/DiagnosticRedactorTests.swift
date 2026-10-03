import XCTest
@testable import PiRemoteCore

final class DiagnosticRedactorTests: XCTestCase {
    private let secret = String(repeating: "ab12", count: 16)

    func testRemovesKnownSecretsEverywhere() {
        let text = "agent ready \(secret) and again \(secret)"
        let redacted = DiagnosticRedactor.redact(text, secrets: [secret], homeDirectory: "/Users/tester")
        XCTAssertFalse(redacted.contains(secret))
        XCTAssertEqual(redacted, "agent ready *** and again ***")
    }

    func testRemovesTokenParametersEvenWhenSecretIsUnknown() {
        let text = #"wss://relay.example/ws/agent?token=zzzzzzzzzz&x=1 RELAY_TOKEN=qqqqqqqq {"token":"yyyyyyyyyy"}"#
        let redacted = DiagnosticRedactor.redact(text, secrets: [], homeDirectory: "/Users/tester")
        XCTAssertFalse(redacted.contains("zzzzzzzzzz"))
        XCTAssertFalse(redacted.contains("qqqqqqqq"))
        XCTAssertFalse(redacted.contains("yyyyyyyyyy"))
        XCTAssertTrue(redacted.contains("&x=1"))
    }

    func testReplacesHomeDirectory() {
        let redacted = DiagnosticRedactor.redact("workspace /Users/tester/Desktop/app", secrets: [], homeDirectory: "/Users/tester")
        XCTAssertEqual(redacted, "workspace ~/Desktop/app")
    }

    func testIgnoresShortSecretsToAvoidMangling() {
        XCTAssertEqual(DiagnosticRedactor.redact("pi ready", secrets: ["pi", ""], homeDirectory: "/Users/tester"), "pi ready")
    }
}
