import Foundation

enum ConnectionQRCode {
    enum ParseError: LocalizedError, Equatable {
        case invalidCode
        case unsupportedVersion
        case invalidServer
        case invalidToken

        var errorDescription: String? {
            switch self {
            case .invalidCode:
                return "这不是 Pi Remote 连接二维码，请扫描 Mac 上的连接二维码。"
            case .unsupportedVersion:
                return "此二维码需要更新版本的 Pi Remote。"
            case .invalidServer:
                return "二维码中的服务器地址无效，请重新生成连接二维码。"
            case .invalidToken:
                return "二维码中的连接凭据无效，请重新生成连接二维码。"
            }
        }
    }

    private struct Payload: Decodable {
        let version: Int
        let serverUrl: String
        let token: String
    }

    static func parse(_ value: String, deviceName: String) throws -> ConnectionConfig {
        guard value.utf8.count <= 4096,
              let payload = try? JSONDecoder().decode(Payload.self, from: Data(value.utf8)) else {
            throw ParseError.invalidCode
        }
        guard payload.version == 1 else {
            throw ParseError.unsupportedVersion
        }

        let forbiddenCharacters = CharacterSet.whitespacesAndNewlines.union(.controlCharacters)
        guard payload.serverUrl.rangeOfCharacter(from: forbiddenCharacters) == nil,
              let components = URLComponents(string: payload.serverUrl),
              let scheme = components.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss",
              let host = components.host, !host.isEmpty,
              host.rangeOfCharacter(from: forbiddenCharacters) == nil,
              components.port.map({ (1...65535).contains($0) }) ?? true,
              components.percentEncodedPath == "/ws/ios",
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              let url = URL(string: payload.serverUrl, encodingInvalidCharacters: false) else {
            throw ParseError.invalidServer
        }
        guard payload.token.utf16.count >= 32,
              payload.token.rangeOfCharacter(from: forbiddenCharacters) == nil else {
            throw ParseError.invalidToken
        }

        return ConnectionConfig(
            serverUrl: url.absoluteString,
            token: payload.token,
            deviceName: deviceName
        )
    }
}
