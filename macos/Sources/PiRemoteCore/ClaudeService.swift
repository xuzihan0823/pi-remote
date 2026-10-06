import Foundation

/// How the Claude daemon is exposed to the iOS client. `.local` keeps the loopback-only
/// behavior; `.cloudflare` additionally raises an independent Quick Tunnel.
public enum ClaudeServiceMode: String, Codable, Equatable, CaseIterable {
    case local
    case cloudflare
}

public struct ClaudeServiceConfiguration: Codable, Equatable {
    public var port: Int
    public var executablePath: String
    public var projectsDirectory: String
    public var dataDirectory: String
    public var mode: ClaudeServiceMode

    public init(
        port: Int = 8788,
        executablePath: String = "/usr/local/bin/claude",
        projectsDirectory: String = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/projects").path,
        dataDirectory: String = ClaudeServiceConfiguration.defaultDataDirectory.path,
        mode: ClaudeServiceMode = .local
    ) {
        self.port = port
        self.executablePath = executablePath
        self.projectsDirectory = projectsDirectory
        self.dataDirectory = dataDirectory
        self.mode = mode
    }

    private enum CodingKeys: String, CodingKey {
        case port, executablePath, projectsDirectory, dataDirectory, mode
    }

    /// Backward compatible: `claude-config.json` written before `mode` existed still decodes,
    /// keeping the stored port/paths and defaulting to `.local`. Never persists public URLs or tokens.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let fallback = ClaudeServiceConfiguration()
        port = try container.decodeIfPresent(Int.self, forKey: .port) ?? fallback.port
        executablePath = try container.decodeIfPresent(String.self, forKey: .executablePath) ?? fallback.executablePath
        projectsDirectory = try container.decodeIfPresent(String.self, forKey: .projectsDirectory) ?? fallback.projectsDirectory
        dataDirectory = try container.decodeIfPresent(String.self, forKey: .dataDirectory) ?? fallback.dataDirectory
        let rawMode = (try? container.decodeIfPresent(String.self, forKey: .mode)) ?? nil
        mode = rawMode.flatMap(ClaudeServiceMode.init(rawValue:)) ?? .local
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(port, forKey: .port)
        try container.encode(executablePath, forKey: .executablePath)
        try container.encode(projectsDirectory, forKey: .projectsDirectory)
        try container.encode(dataDirectory, forKey: .dataDirectory)
        try container.encode(mode, forKey: .mode)
    }

    public static var defaultDataDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Pi Remote/Claude", isDirectory: true)
    }

    public var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    public func validated() throws -> Self {
        guard (1...65535).contains(port) else { throw ValidationError("Claude 服务端口必须在 1–65535 之间") }
        for (name, path) in [("Claude 可执行文件", executablePath), ("Claude 会话目录", projectsDirectory), ("Claude 数据目录", dataDirectory)] {
            guard (path as NSString).isAbsolutePath, !path.contains("\0"), !path.contains("\n") else {
                throw ValidationError("\(name)必须是有效的绝对路径")
            }
        }
        return self
    }
}

public struct ClaudeConfigStore {
    public let file: URL

    public init(file: URL = ClaudeServiceConfiguration.defaultDataDirectory.deletingLastPathComponent().appendingPathComponent("claude-config.json")) {
        self.file = file
    }

    public func load() throws -> ClaudeServiceConfiguration {
        guard FileManager.default.fileExists(atPath: file.path) else { return ClaudeServiceConfiguration() }
        return try JSONDecoder().decode(ClaudeServiceConfiguration.self, from: Data(contentsOf: file)).validated()
    }

    public func save(_ configuration: ClaudeServiceConfiguration) throws {
        let validated = try configuration.validated()
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(validated).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}

public struct ClaudeServiceHealth: Decodable, Equatable {
    public let ok: Bool
    public let service: String
    public let instanceId: String

    public func matches(instanceId: String) -> Bool {
        ok && service == "pi-remote-claude" && self.instanceId == instanceId
    }
}

public struct ClaudePairInfo: Decodable, Equatable {
    public let bases: [String]
    public let token: String

    public init(bases: [String], token: String) {
        self.bases = bases
        self.token = token
    }
}

extension ClaudePairInfo {
    /// `claude-remote://setup` link parsed by the Claude Remote app (`parseSetupLink` in
    /// claude-remote/app/src/lib/pairing.js). Each base is percent-encoded on its own; the separating
    /// commas stay literal so the app can split before decoding.
    public var setupLink: String {
        let encode = { (value: String) in value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value }
        return "claude-remote://setup?v=1&token=\(encode(token))&bases=\(bases.map(encode).joined(separator: ","))"
    }
}

/// Strict validation for Cloudflare Quick Tunnel public addresses. A valid address is exactly
/// `https://<label>.<label>…trycloudflare.com` with no userinfo, port, path, query or fragment, so a
/// look-alike host (`trycloudflare.com.evil.example`, `evil-trycloudflare.com`) can never be paired.
public enum ClaudeTunnelURL {
    private static let hostPattern = "^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+trycloudflare\\.com$"

    public static func validated(_ candidate: URL) -> URL? {
        guard candidate.scheme?.lowercased() == "https",
              let components = URLComponents(url: candidate, resolvingAgainstBaseURL: false),
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.port == nil || components.port == 443,
              components.path.isEmpty || components.path == "/",
              let host = components.host, host == host.lowercased(),
              host.range(of: hostPattern, options: .regularExpression) != nil else {
            return nil
        }
        return candidate
    }

    /// Scans a cloudflared log line for the *complete* `https://…` token (bounded by whitespace or
    /// the `|` log frame) and returns a strictly validated origin. Unlike the shared Pi
    /// `TunnelLogParser`, this never truncates a path/query/fragment away, so a line advertising
    /// `https://x.trycloudflare.com/evil` is rejected rather than accepted as the bare origin.
    public static func inLogLine(_ line: String) -> URL? {
        var index = line.startIndex
        while let range = line.range(of: "https://", range: index..<line.endIndex) {
            var end = range.upperBound
            while end < line.endIndex, !line[end].isWhitespace, line[end] != "|" {
                end = line.index(after: end)
            }
            var token = String(line[range.lowerBound..<end])
            while let last = token.last, trailingPunctuation.contains(last) { token.removeLast() }
            if let url = URL(string: token).flatMap(validated) { return url }
            index = end
        }
        return nil
    }

    private static let trailingPunctuation: Set<Character> = [".", ",", ";", ":", "!", "?", ")", "]", "}", "'", "\"", ">", "<"]
}

extension JobBuilder {
    public static func claudeJob(
        nodePath: String,
        runtimeDirectory: String,
        configuration: ClaudeServiceConfiguration,
        token: String,
        instanceId: String,
        baseEnvironment: [String: String]
    ) throws -> SupervisorJob {
        let config = try configuration.validated()
        _ = try EndpointValidator.validateToken(token)
        guard UUID(uuidString: instanceId) != nil else { throw ValidationError("Claude 服务实例标识无效") }
        let excluded = Set(["INTERACTIONS_DB_PATH", "UPLOADS_DIR", "ACTIVITY_COOLDOWN_MS", "PERMISSION_TIMEOUT_MS", "BARK_URL", "NTFY_URL", "NODE_OPTIONS", "NODE_PATH"])
        var env = baseEnvironment.filter { key, _ in
            !excluded.contains(key) && !["PI_", "RELAY_", "AGENT_", "BRIDGE_"].contains(where: key.hasPrefix)
        }
        env["PATH"] = RuntimeEnvironment.path(bundledNodeDirectory: (nodePath as NSString).deletingLastPathComponent, original: env["PATH"])
        env["BRIDGE_HOST"] = "127.0.0.1"
        env["BRIDGE_PORT"] = String(config.port)
        env["BRIDGE_TOKEN"] = token
        env["BRIDGE_INSTANCE_ID"] = instanceId
        env["CLAUDE_BIN"] = config.executablePath
        env["CLAUDE_PROJECTS_DIR"] = config.projectsDirectory
        env["INTERACTIONS_DB_PATH"] = URL(fileURLWithPath: config.dataDirectory).appendingPathComponent("interactions.sqlite").path
        env["UPLOADS_DIR"] = URL(fileURLWithPath: config.dataDirectory).appendingPathComponent("uploads").path
        return SupervisorJob(
            command: nodePath,
            args: [URL(fileURLWithPath: runtimeDirectory).appendingPathComponent("claude/src/index.ts").path],
            cwd: config.dataDirectory,
            env: env,
            killGraceMs: 8_000,
            tag: "claude"
        )
    }
}
