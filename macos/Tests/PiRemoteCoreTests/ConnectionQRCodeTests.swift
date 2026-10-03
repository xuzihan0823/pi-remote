import XCTest
@testable import PiRemoteCore

final class ConnectionQRCodeTests: XCTestCase {
    private let agentURL = URL(string: "wss://pi.anyyu.cyou/ws/agent")!
    private let token = String(repeating: "k", count: 32)

    func testPayloadMatchesIOSContract() throws {
        let text = try ConnectionQRCode.text(agentURL: agentURL, token: token)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(object["version"] as? Int, 1)
        XCTAssertEqual(object["serverUrl"] as? String, "wss://pi.anyyu.cyou/ws/ios")
        XCTAssertEqual(object["token"] as? String, token)
        XCTAssertEqual(object.count, 3)
        XCTAssertLessThanOrEqual(text.utf8.count, 4096)
    }

    func testPayloadUsesSameTokenAsAgent() throws {
        let other = String(repeating: "9", count: 40)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(try ConnectionQRCode.text(agentURL: agentURL, token: other).utf8)) as? [String: Any]
        )
        XCTAssertEqual(object["token"] as? String, other)
    }

    func testRejectsShortToken() {
        XCTAssertThrowsError(try ConnectionQRCode.text(agentURL: agentURL, token: "short"))
    }

    func testRejectsAgentURLThatIsNotAnAgentEndpoint() {
        XCTAssertThrowsError(try ConnectionQRCode.text(agentURL: URL(string: "wss://pi.anyyu.cyou/ws/ios")!, token: token))
        XCTAssertThrowsError(try ConnectionQRCode.text(agentURL: URL(string: "https://pi.anyyu.cyou/ws/agent")!, token: token))
    }

    func testGeneratesScannableImage() throws {
        let text = try ConnectionQRCode.text(agentURL: agentURL, token: token)
        let image = try XCTUnwrap(ConnectionQRCode.image(from: text, scale: 6))
        XCTAssertGreaterThan(image.width, 100)
        XCTAssertEqual(image.width, image.height)
    }
}
