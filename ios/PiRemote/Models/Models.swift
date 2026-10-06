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
        project: String? = nil
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
        if isArchived { return error ?? "历史快照 · 只读 · 运行状态未知" }
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
    case all = "全部"
    case running = "进行中"
    case waiting = "待回应"
    case history = "历史"

    public var id: String { rawValue }

    public func matches(_ session: SessionItem) -> Bool {
        switch self {
        case .all:
            return true
        case .running:
            return session.isActive
        case .waiting:
            return session.hasPendingApproval
        case .history:
            return session.isArchived
        }
    }

    public func label(count: Int) -> String {
        guard self != .all, count > 0 else { return rawValue }
        return "\(rawValue) \(count)"
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
            project: remote["project"] as? String
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

    public mutating func apply(_ data: [String: Any], prepend: Bool = false) {
        let incomingBranch = data["branchId"] as? String
        let incomingRevision = data["revision"] as? String
        let changedBranch = incomingBranch != branchId
        if prepend && (incomingBranch != branchId || incomingRevision != revision) {
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
            if prepend || !loaded || changedBranch || (!hasLoadedEarlier && availability == "live") {
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

    public init(
        id: String,
        method: String,
        title: String,
        message: String,
        command: String? = nil,
        options: [String] = []
    ) {
        self.id = id
        self.method = method
        self.title = title
        self.message = message
        self.command = command
        self.options = options
    }
}
