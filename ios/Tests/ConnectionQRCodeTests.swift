import Foundation

@main
struct ConnectionQRCodeTests {
    struct Failure: Error {
        let message: String
    }

    static func main() throws {
        let token = String(repeating: "a", count: 32)
        func payload(url: String = "wss://relay.example.com/ws/ios", token: String = token, version: Int = 1) throws -> String {
            let data = try JSONSerialization.data(withJSONObject: [
                "version": version,
                "serverUrl": url,
                "token": token,
                "deviceName": "must-not-replace-local-name",
            ])
            return String(decoding: data, as: UTF8.self)
        }

        for url in ["wss://relay.example.com/ws/ios", "ws://192.168.1.10:8789/ws/ios", "ws://[::1]:8789/ws/ios"] {
            let config = try ConnectionQRCode.parse(payload(url: url), deviceName: "我的 iPhone")
            try expect(config.serverUrl == url, "Preserves the server address")
            try expect(config.token == token, "Preserves the token")
            try expect(config.deviceName == "我的 iPhone", "Keeps the local device name")
        }
        print("PASS: valid TLS, LAN and IPv6 connection codes preserve credentials and local device name")

        for invalid in ["", "https://example.com", "{}", "{", "[]", "{\"version\":1,\"serverUrl\":42,\"token\":\"x\"}", String(repeating: "x", count: 4097)] {
            try expectError(invalid, .invalidCode)
        }
        try expectError(payload(version: 2), .unsupportedVersion)
        print("PASS: unrelated, malformed, oversized and unsupported QR codes are rejected")

        for url in [
            "https://relay.example.com/ws/ios", "file:///ws/ios", "ws:///ws/ios",
            "wss://relay.example.com/ws/agent", "wss://relay.example.com",
            "wss://relay.example.com/ws/%69os", "wss://bad%20host/ws/ios",
            "wss://user:password@relay.example.com/ws/ios",
            "wss://relay.example.com/ws/ios?token=secret", "wss://relay.example.com/ws/ios#fragment",
            "wss://relay.example.com:0/ws/ios", "wss://relay.example.com:65536/ws/ios",
            "wss://bad host/ws/ios", "wss://relay.example.com/\nws/ios",
        ] {
            try expectError(payload(url: url), .invalidServer)
        }
        print("PASS: invalid schemes, hosts, ports, endpoints and embedded credentials are rejected")

        for invalidToken in ["", String(token.dropLast()), token + "\r\nInjected: header", token + " ", token + "\u{0000}"] {
            try expectError(payload(token: invalidToken), .invalidToken)
        }
        print("PASS: missing, short and unsafe tokens are rejected")
    }

    private static func expect(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(message: message) }
    }

    private static func expectError(_ payload: String, _ expected: ConnectionQRCode.ParseError) throws {
        do {
            _ = try ConnectionQRCode.parse(payload, deviceName: "iPhone")
        } catch let error as ConnectionQRCode.ParseError {
            try expect(error == expected, "Expected \(expected), received \(error)")
            return
        }
        throw Failure(message: "Invalid code was accepted; expected \(expected)")
    }
}
