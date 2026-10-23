import Foundation
import Security

/// App 当前使用的后端：Pi Relay（pi/OMP Agent）或直连 Mac 上的 Claude 后端。
public enum BackendKind: String, CaseIterable, Identifiable {
    case relay
    case claude

    public static let storageKey = "piRemote.backendKind"
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .relay: return "Pi Relay"
        case .claude: return "Claude"
        }
    }
}

/// 已配对的 Claude 后端：候选地址存 UserDefaults，Token 存 Keychain（仅本机、解锁后可读、不随备份迁移）。
public struct ClaudeConnection: Equatable {
    /// 上次连通的地址。
    public var baseURL: URL
    /// 配对码里的全部候选地址（Tailscale / 局域网 / .local），断线重连时依次探测。
    public var candidates: [URL]
    public var token: String

    public init(baseURL: URL, candidates: [URL], token: String) {
        self.baseURL = baseURL
        self.candidates = candidates
        self.token = token
    }

    public var probeOrder: [URL] {
        [baseURL] + candidates.filter { $0 != baseURL }
    }
}

public enum ClaudeConnectionStore {
    private static let baseKey = "piRemote.claude.baseURL"
    private static let candidatesKey = "piRemote.claude.candidates"
    private static let keychainService = "com.piremote.app.claude-token"
    private static let keychainAccount = "claude-daemon"

    public static func load() -> ClaudeConnection? {
        guard let raw = UserDefaults.standard.string(forKey: baseKey),
              case .success(let base) = ClaudePairing.normalizeBase(raw),
              let token = readToken(), !token.isEmpty else { return nil }
        let candidates = (UserDefaults.standard.stringArray(forKey: candidatesKey) ?? []).compactMap { raw -> URL? in
            if case .success(let url) = ClaudePairing.normalizeBase(raw) { return url }
            return nil
        }
        return ClaudeConnection(baseURL: base, candidates: candidates, token: token)
    }

    public static func save(_ connection: ClaudeConnection) {
        UserDefaults.standard.set(connection.baseURL.absoluteString, forKey: baseKey)
        UserDefaults.standard.set(connection.candidates.map(\.absoluteString), forKey: candidatesKey)
        writeToken(connection.token)
    }

    public static func clear() {
        UserDefaults.standard.removeObject(forKey: baseKey)
        UserDefaults.standard.removeObject(forKey: candidatesKey)
        deleteToken()
    }

    private static func readToken() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else { return nil }
        return value
    }

    private static func writeToken(_ token: String) {
        deleteToken()
        guard !token.isEmpty else { return }
        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        SecItemAdd(attributes as CFDictionary, nil)
    }

    private static func deleteToken() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
