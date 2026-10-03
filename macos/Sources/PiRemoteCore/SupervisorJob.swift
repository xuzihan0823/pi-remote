import Foundation

/// Job handed to runtime-supervisor.mjs on its stdin. The supervisor spawns the command in its
/// own process group and guarantees the whole tree is terminated when it is asked to stop or
/// when its parent (the app) disappears.
public struct SupervisorJob: Codable, Equatable {
    public var command: String
    public var args: [String]
    public var cwd: String
    public var env: [String: String]
    public var killGraceMs: Int
    public var tag: String

    public init(
        command: String,
        args: [String],
        cwd: String,
        env: [String: String],
        killGraceMs: Int,
        tag: String
    ) {
        self.command = command
        self.args = args
        self.cwd = cwd
        self.env = env
        self.killGraceMs = killGraceMs
        self.tag = tag
    }

    public func encodedLine() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(self)
        data.append(0x0A)
        return data
    }
}

public enum RuntimeEnvironment {
    /// Bundled node directory first, then the standard tool locations, then the user's PATH.
    public static func path(bundledNodeDirectory: String, original: String?) -> String {
        var parts = [bundledNodeDirectory, "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"]
        if let original {
            for component in original.split(separator: ":") where !component.isEmpty {
                let value = String(component)
                if !parts.contains(value) { parts.append(value) }
            }
        }
        return parts.joined(separator: ":")
    }
}

public enum JobBuilder {
    public static let agentGraceMs = 5_000
    public static let relayGraceMs = 5_000
    public static let tunnelGraceMs = 5_000

    public static func agentJob(
        nodePath: String,
        runtimeDirectory: String,
        agentURL: String,
        token: String,
        deviceId: String,
        workspacePath: String,
        piBinPath: String,
        runtime: AgentRuntime = .pi,
        baseEnvironment: [String: String]
    ) -> SupervisorJob {
        var env = baseEnvironment
        env["PI_RUNTIME"] = runtime.rawValue
        env["RELAY_URL"] = agentURL
        env["RELAY_TOKEN"] = token
        env["AGENT_TOKEN"] = token
        env["AGENT_DEVICE_ID"] = deviceId
        env["PI_WORKSPACE_ROOT"] = workspacePath
        env["PI_BIN"] = piBinPath
        return SupervisorJob(
            command: nodePath,
            args: ["src/agent/run.ts"],
            cwd: runtimeDirectory,
            env: env,
            killGraceMs: agentGraceMs,
            tag: "agent"
        )
    }

    public static func relayJob(
        nodePath: String,
        runtimeDirectory: String,
        port: Int,
        token: String,
        workspacePath: String,
        piBinPath: String,
        runtime: AgentRuntime = .pi,
        baseEnvironment: [String: String]
    ) -> SupervisorJob {
        var env = baseEnvironment
        env["PI_RUNTIME"] = runtime.rawValue
        env["RELAY_HOST"] = "127.0.0.1"
        env["RELAY_PORT"] = String(port)
        env["RELAY_TOKEN"] = token
        env["PI_WORKSPACE_ROOT"] = workspacePath
        env["PI_BIN"] = piBinPath
        return SupervisorJob(
            command: nodePath,
            args: ["src/index.ts"],
            cwd: runtimeDirectory,
            env: env,
            killGraceMs: relayGraceMs,
            tag: "relay"
        )
    }

    public static func tunnelJob(
        cloudflaredPath: String,
        runtimeDirectory: String,
        port: Int,
        emptyConfigPath: String,
        baseEnvironment: [String: String]
    ) -> SupervisorJob {
        SupervisorJob(
            command: cloudflaredPath,
            args: [
                "--no-autoupdate",
                "tunnel",
                "--config", emptyConfigPath,
                "--url", "http://127.0.0.1:\(port)",
            ],
            cwd: runtimeDirectory,
            env: baseEnvironment,
            killGraceMs: tunnelGraceMs,
            tag: "tunnel"
        )
    }
}

/// Reads the quick-tunnel hostname from cloudflared output.
public enum TunnelLogParser {
    public static func publicURL(in line: String) -> URL? {
        guard let range = line.range(of: "https://[A-Za-z0-9.-]+\\.trycloudflare\\.com", options: .regularExpression) else {
            return nil
        }
        return URL(string: String(line[range]))
    }

    public static func agentURL(fromPublicURL publicURL: URL) -> URL? {
        guard var components = URLComponents(url: publicURL, resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = "wss"
        components.path = EndpointPath.agent.rawValue
        return components.url
    }
}
