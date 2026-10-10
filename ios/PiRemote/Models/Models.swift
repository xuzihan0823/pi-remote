import Foundation

public struct ConnectionConfig: Codable, Equatable {
    public var serverUrl: String
    public var token: String
    public var deviceName: String

    private static let storageKey = "piRemote.connectionConfig"

    public static let `default` = ConnectionConfig(
        serverUrl: "wss://relay.example.com/ws/ios",
        token: "",
        deviceName: "iPhone"
    )

    public init(serverUrl: String, token: String, deviceName: String) {
        self.serverUrl = serverUrl
        self.token = token
        self.deviceName = deviceName
    }

    public static func load() -> ConnectionConfig {
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              let config = try? JSONDecoder().decode(ConnectionConfig.self, from: data) else {
            return .default
        }
        return config
    }

    public func save() {
        guard let data = try? JSONEncoder().encode(self) else { return }
        UserDefaults.standard.set(data, forKey: Self.storageKey)
        var devices = Self.savedDevices().filter { $0.serverUrl != serverUrl }
        devices.insert(self, at: 0)
        Self.storeSavedDevices(devices)
    }

    private static let savedDevicesKey = "piRemote.savedDevices"

    /// 连接过的设备，最近使用的在前。旧版本只存了单个配置，首次读取时把它补进来。
    public static func savedDevices() -> [ConnectionConfig] {
        if let data = UserDefaults.standard.data(forKey: savedDevicesKey),
           let devices = try? JSONDecoder().decode([ConnectionConfig].self, from: data) {
            return devices
        }
        let current = load()
        return current == .default ? [] : [current]
    }

    public static func forgetDevice(serverUrl: String) {
        storeSavedDevices(savedDevices().filter { $0.serverUrl != serverUrl })
    }

    private static func storeSavedDevices(_ devices: [ConnectionConfig]) {
        guard let data = try? JSONEncoder().encode(devices) else { return }
        UserDefaults.standard.set(data, forKey: savedDevicesKey)
    }
}

public enum AppAppearance: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    public static let storageKey = "piRemote.appearance"

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .system: return "跟随系统"
        case .light: return "浅色"
        case .dark: return "深色"
        }
    }
}

/// 精确的模型标识：同名 modelId 可能属于不同供应商，所以用 provider + modelId 作为 ID。
public struct RemoteModel: Identifiable, Hashable {
    public let provider: String
    public let modelId: String
    public let name: String

    public var id: String { "\(provider)/\(modelId)" }
    public var selection: [String: Any] { ["provider": provider, "modelId": modelId] }

    public init(provider: String, modelId: String, name: String) {
        self.provider = provider
        self.modelId = modelId
        self.name = name
    }

    public init?(remote: Any?) {
        guard let record = remote as? [String: Any],
              let provider = record["provider"] as? String, !provider.isEmpty,
              let modelId = record["modelId"] as? String, !modelId.isEmpty else { return nil }
        let name = (record["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? modelId
        self.init(provider: provider, modelId: modelId, name: name)
    }

    public static func list(_ remote: Any?) -> [RemoteModel] {
        (remote as? [Any] ?? []).compactMap(RemoteModel.init(remote:))
    }
}

public enum SessionProcessState: String {
    case running
    case exited
    case failed
    case unknown

    public init(remoteValue: String?) {
        self = SessionProcessState(rawValue: remoteValue ?? "") ?? .unknown
    }
}

public enum SessionStatus: String, Codable {
    case running
    case approval
    case done
}

public enum SessionSource: String, Equatable {
    case managed
    case terminal

    public init(remoteValue: String?) {
        self = SessionSource(rawValue: remoteValue ?? "") ?? .managed
    }
}

public enum SessionStartMode: String {
    case terminal
    case rpc
}

public enum SessionActivity: String, Equatable {
    case busy
    case idle
    case unknown

    public init(remoteValue: String?) {
        self = SessionActivity(rawValue: remoteValue ?? "") ?? .unknown
    }
}

public struct SessionItem: Identifiable, Equatable {
    public var id: String
    public var title: String
    public var state: SessionProcessState
    public var startedAt: Date?
    public var hasPendingApproval: Bool
    public var error: String?
    public var source: SessionSource
    public var activity: SessionActivity
    public var cwd: String?
    public var availability: String
    public var canControl: Bool
    public var runtime: String?
    public var project: String?
    public var subagentModelIsolation: Bool

    public init(
        id: String,
        title: String,
        state: SessionProcessState,
        startedAt: Date? = nil,
        hasPendingApproval: Bool = false,
        error: String? = nil,
        source: SessionSource = .managed,
        activity: SessionActivity = .unknown,
        cwd: String? = nil,
        availability: String = "live",
        canControl: Bool = true,
        runtime: String? = nil,
        project: String? = nil,
        subagentModelIsolation: Bool = false
    ) {
        self.id = id
        self.title = title
        self.state = state
        self.startedAt = startedAt
        self.hasPendingApproval = hasPendingApproval
        self.error = error
        self.source = source
        self.activity = activity
        self.cwd = cwd
        self.availability = availability
        self.canControl = canControl && availability == "live"
        self.runtime = runtime
        self.project = project
        self.subagentModelIsolation = subagentModelIsolation
    }

    public var isTerminal: Bool { source == .terminal }
    public var isArchived: Bool { availability == "archived" || id.hasPrefix("history:") }

    /// 进行中只认「activity=busy」或明确等待回应；state=running 仅表示进程存活，idle 不算运行。
    public var isActive: Bool { !isArchived && (activity == .busy || hasPendingApproval) }

    public var status: SessionStatus {
        if hasPendingApproval { return .approval }
        return isActive ? .running : .done
    }

    public var subtitle: String {
        if isArchived { return error ?? "历史会话 · 离线记录" }
        if hasPendingApproval { return "等待你确认" }
        switch activity {
        case .busy:
            return "正在运行"
        case .idle:
            return isTerminal ? "空闲" : "已完成"
        case .unknown:
            if isTerminal { return "离线" }
            return error ?? "状态未知"
        }
    }

    public var timeAgo: String {
        guard let startedAt else { return "" }
        if startedAt > Date().addingTimeInterval(-30) { return "刚刚" }
        return Self.relativeFormatter.localizedString(for: startedAt, relativeTo: Date())
    }

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "zh_Hans_CN")
        formatter.unitsStyle = .short
        return formatter
    }()
}

public enum SessionFilter: String, CaseIterable, Identifiable {
    case history = "会话记录"
    case running = "进行中"
    case waiting = "待回应"

    public var id: String { rawValue }

    public func matches(_ session: SessionItem) -> Bool {
        switch self {
        case .history:
            return true
        case .running:
            return session.isActive
        case .waiting:
            return session.hasPendingApproval
        }
    }

    public func label(count: Int) -> String {
        guard self != .history, count > 0 else { return rawValue }
        return "\(rawValue) \(count)"
    }
}

public struct SessionProjectGroup: Identifiable, Equatable {
    public static let ungroupedName = "未归属项目"
    public static let temporaryProjects: Set<String> = ["tmp", "private", "T"]

    public var name: String
    public var sessions: [SessionItem]

    public var id: String { name }
    public var isUngrouped: Bool { name == Self.ungroupedName }

    /// 按项目分组：项目内按时间倒序，项目按最近会话倒序，/tmp 等临时目录和无项目的会话统一放到最后。
    public static func group(_ sessions: [SessionItem], projectName: (SessionItem) -> String?) -> [SessionProjectGroup] {
        var buckets: [String: [SessionItem]] = [:]
        for session in sessions {
            let raw = projectName(session)?.trimmingCharacters(in: .whitespaces) ?? ""
            let name = raw.isEmpty || temporaryProjects.contains(raw) ? ungroupedName : raw
            buckets[name, default: []].append(session)
        }
        let latest = { (items: [SessionItem]) in items.compactMap(\.startedAt).max() ?? .distantPast }
        return buckets
            .map { SessionProjectGroup(name: $0.key, sessions: $0.value.sorted { ($0.startedAt ?? .distantPast) > ($1.startedAt ?? .distantPast) }) }
            .sorted { lhs, rhs in
                if lhs.isUngrouped != rhs.isUngrouped { return rhs.isUngrouped }
                let (l, r) = (latest(lhs.sessions), latest(rhs.sessions))
                return l != r ? l > r : lhs.name < rhs.name
            }
    }
}

public extension SessionItem {
    /// 解析 relay 返回的单条 sessions 成员；缺失 source/activity 的旧 server 视为 managed/unknown。
    init?(remote: [String: Any], localTitle: String? = nil, hasPendingApproval: Bool = false) {
        guard let id = remote["sessionId"] as? String else { return nil }
        let remoteTitle = (remote["title"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let startedAt = (remote["startedAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) }
        self.init(
            id: id,
            title: localTitle ?? remoteTitle ?? "会话 \(id.prefix(8))",
            state: SessionProcessState(remoteValue: remote["state"] as? String),
            startedAt: startedAt,
            hasPendingApproval: hasPendingApproval,
            error: remote["error"] as? String,
            source: SessionSource(remoteValue: remote["source"] as? String),
            activity: SessionActivity(remoteValue: remote["activity"] as? String),
            cwd: remote["cwd"] as? String,
            availability: remote["availability"] as? String ?? "live",
            canControl: remote["canControl"] as? Bool ?? !(id.hasPrefix("history:")),
            runtime: remote["runtime"] as? String,
            project: remote["project"] as? String,
            subagentModelIsolation: remote["subagentModelIsolation"] as? Bool ?? false
        )
    }
}

public struct TerminalMessage: Identifiable, Equatable {
    public var id: String
    public var role: String
    public var text: String

    public init(role: String, text: String, id: String = UUID().uuidString) {
        self.role = role
        self.text = text
        self.id = id
    }
}

/// Legacy 快照原子替换；v2 按稳定 ID 合并，保留已加载的更早页。
public struct TerminalSessionState: Equatable {
    public private(set) var activity: SessionActivity = .unknown
    public private(set) var messages: [TerminalMessage] = []
    public private(set) var truncated = false
    public private(set) var error: String?
    public private(set) var loaded = false
    public private(set) var items: [TimelineItem] = []
    public private(set) var revision: String?
    public private(set) var branchId: String?
    public private(set) var before: String?
    public private(set) var hasMoreBefore = false
    public private(set) var canControl = true
    public private(set) var availability = "live"
    public private(set) var warnings: [String] = []
    public private(set) var usesTimeline = false
    private var hasLoadedEarlier = false

    public init() {}

    public var isBusy: Bool { activity == .busy }

    /// 离线：读取失败，或已取到快照但 activity 仍为 unknown。
    public var isOffline: Bool { error != nil || (loaded && activity == .unknown && availability != "archived") }

    public mutating func reset() {
        self = TerminalSessionState()
    }

    public mutating func apply(_ data: [String: Any], prepend: Bool = false, allowLiveRevisionChange: Bool = false) {
        let incomingBranch = data["branchId"] as? String
        let incomingRevision = data["revision"] as? String
        let changedBranch = incomingBranch != branchId
        if prepend && (incomingBranch != branchId ||
            (incomingRevision != revision && !(allowLiveRevisionChange && availability == "live" && data["availability"] as? String == "live"))) {
            error = "历史已变化，请刷新后继续阅读"
            return
        }
        activity = SessionActivity(remoteValue: data["activity"] as? String)
        availability = data["availability"] as? String ?? "live"
        canControl = data["canControl"] as? Bool ?? (availability == "live")
        truncated = data["truncated"] as? Bool ?? false
        warnings = data["warnings"] as? [String] ?? []
        usesTimeline = data["viewVersion"] as? Int == 2 && data["items"] is [[String: Any]]
        if usesTimeline {
            let incoming = (data["items"] as? [[String: Any]] ?? []).compactMap(TimelineItem.init(remote:))
            if incomingBranch != branchId {
                items = incoming
                hasLoadedEarlier = false
            } else if prepend {
                let known = Set(items.map(\.id))
                items = incoming.filter { !known.contains($0.id) } + items
                hasLoadedEarlier = true
            } else {
                let incomingIDs = Set(incoming.map(\.id))
                let prefix: [TimelineItem]
                if let first = incoming.first, let overlap = items.firstIndex(where: { $0.id == first.id }) {
                    prefix = Array(items.prefix(overlap))
                } else {
                    prefix = items.filter { !$0.id.hasPrefix("stream:") && !incomingIDs.contains($0.id) }
                }
                let updated = prefix.filter { !$0.id.hasPrefix("stream:") } + incoming
                if items != updated { items = updated }
            }
            branchId = incomingBranch
            revision = incomingRevision
            let page = data["page"] as? [String: Any] ?? [:]
            if prepend || !loaded || changedBranch ||
                (!hasLoadedEarlier && availability == "live" && items.first?.id == incoming.first?.id) {
                before = page["before"] as? String
                hasMoreBefore = page["hasMoreBefore"] as? Bool ?? false
            }
            messages = []
        } else {
            items = []
            messages = (data["messages"] as? [[String: Any]] ?? []).enumerated().compactMap { index, item in
                guard let role = item["role"] as? String, let text = item["text"] as? String else { return nil }
                return TerminalMessage(role: role, text: text, id: "legacy:\(index)")
            }
        }
        error = nil
        loaded = true
    }

    public mutating func fail(_ message: String) {
        activity = .unknown
        error = message
    }
}

public struct ExecutionStep: Identifiable, Equatable {
    public var id: String
    public var title: String
    public var isRunning: Bool
    public var isError: Bool

    public init(id: String = UUID().uuidString, title: String, isRunning: Bool = false, isError: Bool = false) {
        self.id = id
        self.title = title
        self.isRunning = isRunning
        self.isError = isError
    }
}

public struct ApprovalRequest: Identifiable, Equatable {
    public var id: String
    public var method: String
    public var title: String
    public var message: String
    public var command: String?
    public var options: [String]
    public var initialValue: String

    public init(
        id: String,
        method: String,
        title: String,
        message: String,
        command: String? = nil,
        options: [String] = [],
        initialValue: String = ""
    ) {
        self.id = id
        self.method = method
        self.title = title
        self.message = message
        self.command = command
        self.options = options
        self.initialValue = initialValue
    }
}

public struct MacProject: Identifiable, Hashable {
    public var name: String
    public var path: String
    public var id: String { path }

    public init(name: String, path: String) {
        self.name = name
        self.path = path
    }

    public init?(remote: [String: Any]) {
        guard let name = remote["name"] as? String, let path = remote["path"] as? String,
              path.hasPrefix("/"), !path.contains("\0") else { return nil }
        self.init(name: name, path: path)
    }
}

public struct MacProjectList {
    public var projects: [MacProject]
    public var home: String
    public var defaultDirectory: String
}

public struct MacDirectoryPage {
    public var path: String
    public var parent: String?
    public var directories: [MacProject]
    public var nextOffset: Int?
}
