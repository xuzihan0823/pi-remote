import Foundation

public enum ConnectionMode: String, Codable, CaseIterable, Identifiable {
    case server
    case cloudflare

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .server: return "服务器模式"
        case .cloudflare: return "Cloudflare 模式"
        }
    }
}

public enum AgentRuntime: String, Codable, CaseIterable, Identifiable {
    case pi
    case omp

    public var id: String { rawValue }

    public var defaultBinaryPath: String {
        switch self {
        case .pi: return "/usr/local/bin/pi"
        case .omp: return (NSHomeDirectory() as NSString).appendingPathComponent(".local/bin/omp")
        }
    }

    /// When switching runtimes, a path that is still the other runtime's default follows the switch;
    /// a user-chosen path is kept.
    public static func binaryPath(afterSwitchingTo runtime: AgentRuntime, current: String) -> String {
        let trimmed = current.trimmingCharacters(in: .whitespacesAndNewlines)
        let defaults = Set(allCases.map(\.defaultBinaryPath) + allCases.map(\.rawValue))
        return trimmed.isEmpty || defaults.contains(trimmed) ? runtime.defaultBinaryPath : current
    }
}

public enum ServerSource: String, Codable, CaseIterable, Identifiable {
    case existing
    case deploy

    public var id: String { rawValue }
}

/// Non-secret application configuration persisted in Application Support.
public struct AppConfig: Codable, Equatable {
    public var mode: ConnectionMode
    public var serverURL: String
    public var workspacePath: String
    public var piBinPath: String
    public var deviceId: String
    public var runtime: AgentRuntime
    public var serverSource: ServerSource
    public var deployTarget: RemoteDeployTarget

    public static let defaultServerURL = "wss://pi.anyyu.cyou/ws/agent"
    public static let defaultPiBin = AgentRuntime.pi.defaultBinaryPath
    public static let defaultRelayPort = 8789

    public init(
        mode: ConnectionMode,
        serverURL: String,
        workspacePath: String,
        piBinPath: String,
        deviceId: String,
        runtime: AgentRuntime = .pi,
        serverSource: ServerSource = .existing,
        deployTarget: RemoteDeployTarget = RemoteDeployTarget()
    ) {
        self.mode = mode
        self.serverURL = serverURL
        self.workspacePath = workspacePath
        self.piBinPath = piBinPath
        self.deviceId = deviceId
        self.runtime = runtime
        self.serverSource = serverSource
        self.deployTarget = deployTarget
    }

    private enum CodingKeys: String, CodingKey {
        case mode, serverURL, workspacePath, piBinPath, deviceId, runtime, serverSource, deployTarget
    }

    /// Fields added after the first release decode with defaults so older config.json files keep loading.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        mode = try container.decode(ConnectionMode.self, forKey: .mode)
        serverURL = try container.decode(String.self, forKey: .serverURL)
        workspacePath = try container.decode(String.self, forKey: .workspacePath)
        piBinPath = try container.decode(String.self, forKey: .piBinPath)
        deviceId = try container.decode(String.self, forKey: .deviceId)
        runtime = try container.decodeIfPresent(AgentRuntime.self, forKey: .runtime) ?? .pi
        serverSource = try container.decodeIfPresent(ServerSource.self, forKey: .serverSource) ?? .existing
        deployTarget = try container.decodeIfPresent(RemoteDeployTarget.self, forKey: .deployTarget) ?? RemoteDeployTarget()
    }

    public static func makeDefault(deviceId: String) -> AppConfig {
        AppConfig(
            mode: .server,
            serverURL: defaultServerURL,
            workspacePath: NSHomeDirectory(),
            piBinPath: defaultPiBin,
            deviceId: deviceId
        )
    }

    public func validated() throws -> AppConfig {
        var copy = self
        if mode == .server {
            copy.serverURL = try EndpointValidator.validateWebSocket(serverURL, expectedPath: .agent).absoluteString
        }
        let workspace = (workspacePath as NSString).expandingTildeInPath
        guard workspace.hasPrefix("/") else { throw ValidationError("工作区必须是绝对路径") }
        guard workspace != "/" else { throw ValidationError("工作区不能是文件系统根目录") }
        copy.workspacePath = (workspace as NSString).standardizingPath
        let piBin = piBinPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !piBin.isEmpty else { throw ValidationError("PI_BIN 不能为空") }
        copy.piBinPath = piBin
        guard !deviceId.isEmpty else { throw ValidationError("设备标识不能为空") }
        return copy
    }
}

/// Stable per-install device id announced as AGENT_DEVICE_ID, matching the relay's id pattern.
public enum DeviceIdentity {
    public static func makeDeviceId() -> String {
        var bytes = [UInt8](repeating: 0, count: 4)
        for index in bytes.indices {
            bytes[index] = UInt8.random(in: UInt8.min...UInt8.max)
        }
        let suffix = bytes.map { String(format: "%02x", $0) }.joined()
        return "pi-mac-\(suffix)"
    }

    public static func isValid(_ value: String) -> Bool {
        guard let first = value.first, first.isLetter || first.isNumber else { return false }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-")
        return value.count <= 128 && value.unicodeScalars.allSatisfy { allowed.contains($0) }
    }
}
