import Foundation

/// 明文传输（ws:// / http://）只允许本机、局域网和 Tailscale 地址；公网地址必须走 wss:// / https://，
/// 否则 Token 与会话内容会以明文经过公网。Relay 与 Claude 后端共用这条规则。
public enum TransportSecurity {
    public static func allows(scheme: String, host: String) -> Bool {
        switch scheme.lowercased() {
        case "wss", "https": return true
        case "ws", "http": return isPrivateHost(host)
        default: return false
        }
    }

    public static func isPrivateHost(_ rawHost: String) -> Bool {
        let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host.hasSuffix(".local") || host.hasSuffix(".ts.net") { return true }
        if host.contains(":") {
            // IPv6：回环、链路本地 fe80::/10、唯一本地 fc00::/7
            return host == "::1" || host.hasPrefix("fe8") || host.hasPrefix("fe9") || host.hasPrefix("fea") ||
                host.hasPrefix("feb") || host.hasPrefix("fc") || host.hasPrefix("fd")
        }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false).compactMap { UInt8($0) }
        guard parts.count == 4 else { return false }
        switch (parts[0], parts[1]) {
        case (127, _), (10, _), (192, 168), (169, 254): return true
        case (172, 16...31): return true
        case (100, 64...127): return true // CGNAT / Tailscale
        default: return false
        }
    }
}
