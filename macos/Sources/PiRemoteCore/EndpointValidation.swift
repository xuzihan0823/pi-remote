import Foundation

public enum EndpointPath: String {
    case agent = "/ws/agent"
    case ios = "/ws/ios"
}

public struct ValidationError: Error, LocalizedError, Equatable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? { message }
}

public enum EndpointValidator {
    private static let forbiddenCharacters = CharacterSet.whitespacesAndNewlines.union(.controlCharacters)

    /// Accepts only ws:// or wss:// URLs with a host, no userinfo/query/fragment and exactly the
    /// expected path. The same contract the iOS client and the relay use.
    public static func validateWebSocket(_ raw: String, expectedPath: EndpointPath) throws -> URL {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw ValidationError("地址不能为空") }
        guard text.rangeOfCharacter(from: forbiddenCharacters) == nil else {
            throw ValidationError("地址不能包含空格或控制字符")
        }
        guard let components = URLComponents(string: text) else {
            throw ValidationError("地址格式无效")
        }
        guard let scheme = components.scheme?.lowercased(), scheme == "ws" || scheme == "wss" else {
            throw ValidationError("地址必须以 ws:// 或 wss:// 开头")
        }
        guard let host = components.host, !host.isEmpty else {
            throw ValidationError("地址缺少主机名")
        }
        guard components.user == nil, components.password == nil else {
            throw ValidationError("地址不能包含用户名或密码")
        }
        guard components.port.map({ (1...65535).contains($0) }) ?? true else {
            throw ValidationError("端口必须在 1–65535 之间")
        }
        guard components.query == nil else {
            throw ValidationError("地址不能包含查询参数")
        }
        guard components.fragment == nil else {
            throw ValidationError("地址不能包含片段")
        }
        guard components.percentEncodedPath == expectedPath.rawValue else {
            throw ValidationError("地址路径必须是 \(expectedPath.rawValue)")
        }
        guard let url = URL(string: text) else {
            throw ValidationError("地址格式无效")
        }
        return url
    }

    /// At least 32 UTF-16 units and no whitespace or control characters.
    public static func validateToken(_ raw: String) throws -> String {
        let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard token.utf16.count >= 32 else { throw ValidationError("Token 至少需要 32 个字符") }
        guard token.rangeOfCharacter(from: forbiddenCharacters) == nil else {
            throw ValidationError("Token 不能包含空白或控制字符")
        }
        return token
    }

    /// Public TLS health endpoint derived from the agent WebSocket URL (wss -> https).
    public static func healthURL(forAgentURL agentURL: URL) throws -> URL {
        guard var components = URLComponents(url: agentURL, resolvingAgainstBaseURL: false) else {
            throw ValidationError("地址格式无效")
        }
        switch components.scheme?.lowercased() {
        case "wss": components.scheme = "https"
        case "ws": components.scheme = "http"
        default: throw ValidationError("地址必须以 ws:// 或 wss:// 开头")
        }
        components.path = "/api/health"
        guard let url = components.url else { throw ValidationError("无法构造健康检查地址") }
        return url
    }

    /// iOS WebSocket endpoint on the same host as the agent endpoint.
    public static func iosURL(forAgentURL agentURL: URL) throws -> URL {
        guard var components = URLComponents(url: agentURL, resolvingAgainstBaseURL: false) else {
            throw ValidationError("地址格式无效")
        }
        components.path = EndpointPath.ios.rawValue
        guard let url = components.url else { throw ValidationError("无法构造二维码地址") }
        return url
    }
}
