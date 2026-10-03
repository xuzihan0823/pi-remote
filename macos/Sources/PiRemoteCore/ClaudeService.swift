import Foundation

public struct ClaudeServiceConfiguration: Codable, Equatable {
    public var port: Int
    public var executablePath: String
    public var projectsDirectory: String
    public var dataDirectory: String

    public init(
        port: Int = 8788,
        executablePath: String = "/usr/local/bin/claude",
        projectsDirectory: String = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/projects").path,
        dataDirectory: String = ClaudeServiceConfiguration.defaultDataDirectory.path
    ) {
        self.port = port
        self.executablePath = executablePath
        self.projectsDirectory = projectsDirectory
        self.dataDirectory = dataDirectory
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
