import Foundation

public enum DesktopPermissionMode: String, Equatable {
    case inherit
    case ask
    case acceptEdits = "accept-edits"
    case auto

    public var title: String {
        switch self {
        case .inherit: return "跟随全局"
        case .ask: return "逐次询问"
        case .acceptEdits: return "自动接受编辑"
        case .auto: return "自动审批"
        }
    }
}

public struct DesktopPermissionState: Equatable {
    public let mode: DesktopPermissionMode?
    public let effectiveMode: DesktopPermissionMode?

    public init(mode: DesktopPermissionMode?, effectiveMode: DesktopPermissionMode?) {
        self.mode = mode
        self.effectiveMode = effectiveMode
    }

    public init(remote: [String: Any]) {
        mode = Self.decodeMode(remote["mode"])
        effectiveMode = Self.decodeMode(remote["effectiveMode"])
    }

    public var displayText: String {
        guard let mode else { return "未知" }
        switch mode {
        case .inherit:
            return "跟随全局·\(effectiveMode?.title ?? "未知")"
        case .ask, .acceptEdits, .auto:
            return mode.title
        }
    }

    private static func decodeMode(_ value: Any?) -> DesktopPermissionMode? {
        guard let raw = value as? String else { return nil }
        return DesktopPermissionMode(rawValue: raw)
    }
}

public struct DesktopQuestionOption: Equatable {
    public let label: String
    public let description: String?

    public init(label: String, description: String? = nil) {
        self.label = label
        self.description = description
    }

    public init?(remote: [String: Any]) {
        guard let label = DesktopDecoding.nonEmptyString(remote["label"]) else { return nil }
        if let raw = remote["description"], !(raw is NSNull) {
            guard let description = raw as? String else { return nil }
            self.description = description
        } else {
            description = nil
        }
        self.label = label
    }
}

public struct DesktopQuestion: Equatable {
    public let question: String
    public let options: [DesktopQuestionOption]
    public let multiSelect: Bool

    public init(question: String, options: [DesktopQuestionOption], multiSelect: Bool) {
        self.question = question
        self.options = options
        self.multiSelect = multiSelect
    }

    public init?(remote: [String: Any]) {
        guard let question = DesktopDecoding.nonEmptyString(remote["question"]),
              let multiSelect = remote["multiSelect"] as? Bool,
              let rows = remote["options"] as? [Any] else { return nil }
        var options: [DesktopQuestionOption] = []
        options.reserveCapacity(rows.count)
        for row in rows {
            guard let record = row as? [String: Any],
                  let option = DesktopQuestionOption(remote: record) else { return nil }
            options.append(option)
        }
        self.init(question: question, options: options, multiSelect: multiSelect)
    }
}

public struct DesktopQuestionRequest: Equatable {
    public let questions: [DesktopQuestion]

    public init(questions: [DesktopQuestion]) {
        self.questions = questions
    }

    public init?(remote: [String: Any]) {
        guard let rows = remote["questions"] as? [Any], !rows.isEmpty else { return nil }
        var questions: [DesktopQuestion] = []
        questions.reserveCapacity(rows.count)
        for row in rows {
            guard let record = row as? [String: Any],
                  let question = DesktopQuestion(remote: record) else { return nil }
            questions.append(question)
        }
        self.init(questions: questions)
    }
}

public struct DesktopPermissionRequest: Equatable {
    public let toolName: String
    public let reason: String
    public let argsPreview: String?
    public let agentName: String?

    public init(toolName: String, reason: String, argsPreview: String? = nil, agentName: String? = nil) {
        self.toolName = toolName
        self.reason = reason
        self.argsPreview = argsPreview
        self.agentName = agentName
    }

    public init?(remote: [String: Any]) {
        guard let toolName = DesktopDecoding.nonEmptyString(remote["toolName"]),
              let reason = remote["reason"] as? String else { return nil }
        self.init(
            toolName: toolName,
            reason: reason,
            argsPreview: DesktopDecoding.optionalString(remote["argsPreview"]),
            agentName: DesktopDecoding.optionalString(remote["agentName"])
        )
    }
}

public struct DesktopInteraction: Identifiable, Equatable {
    public enum Kind: Equatable {
        case permission(DesktopPermissionRequest)
        case question(DesktopQuestionRequest)
    }

    public let requestId: String
    public let sessionId: String
    public let kind: Kind

    public var id: String { "\(sessionId):\(requestId)" }

    public var permission: DesktopPermissionRequest? {
        guard case .permission(let request) = kind else { return nil }
        return request
    }

    public var question: DesktopQuestionRequest? {
        guard case .question(let request) = kind else { return nil }
        return request
    }

    public init(requestId: String, sessionId: String, kind: Kind) {
        self.requestId = requestId
        self.sessionId = sessionId
        self.kind = kind
    }

    public init?(remote: [String: Any]) {
        guard let kindName = DesktopDecoding.nonEmptyString(remote["kind"]),
              let requestId = DesktopDecoding.nonEmptyString(remote["requestId"]),
              let sessionId = DesktopDecoding.nonEmptyString(remote["sessionId"]),
              SessionItem.isDesktopSessionId(sessionId) else { return nil }
        let kind: Kind
        switch kindName {
        case "permission":
            guard let request = DesktopPermissionRequest(remote: remote) else { return nil }
            kind = .permission(request)
        case "question":
            guard let request = DesktopQuestionRequest(remote: remote) else { return nil }
            kind = .question(request)
        default:
            return nil
        }
        self.init(requestId: requestId, sessionId: sessionId, kind: kind)
    }

    /// 任一成员失败时返回 nil，避免把损坏的 pending 列表伪装成空状态。
    public static func list(_ remote: Any?) -> [DesktopInteraction]? {
        guard let rows = remote as? [Any] else { return nil }
        var interactions: [DesktopInteraction] = []
        interactions.reserveCapacity(rows.count)
        for row in rows {
            guard let record = row as? [String: Any],
                  let interaction = DesktopInteraction(remote: record) else { return nil }
            interactions.append(interaction)
        }
        return interactions
    }
}

public struct DesktopControlsSnapshot: Identifiable, Equatable {
    public let sessionId: String
    public let permission: DesktopPermissionState
    public let model: RemoteModel?
    public let pendingInteractions: [DesktopInteraction]
    public let interactionsSupported: Bool
    public let canControl: Bool
    public let activity: SessionActivity

    public var id: String { sessionId }

    public init?(
        sessionId: String,
        permission: DesktopPermissionState,
        model: RemoteModel?,
        pendingInteractions: [DesktopInteraction],
        interactionsSupported: Bool,
        canControl: Bool,
        activity: SessionActivity
    ) {
        guard SessionItem.isDesktopSessionId(sessionId),
              pendingInteractions.allSatisfy({ $0.sessionId == sessionId }),
              Set(pendingInteractions.map(\.requestId)).count == pendingInteractions.count else { return nil }
        self.sessionId = sessionId
        self.permission = permission
        self.model = model
        self.pendingInteractions = pendingInteractions
        self.interactionsSupported = interactionsSupported
        self.canControl = canControl
        self.activity = activity
    }

    public init?(remote: [String: Any]) {
        guard let sessionId = DesktopDecoding.nonEmptyString(remote["sessionId"]),
              SessionItem.isDesktopSessionId(sessionId),
              let permission = remote["permission"] as? [String: Any],
              let interactionsSupported = remote["interactionsSupported"] as? Bool,
              let canControl = remote["canControl"] as? Bool,
              let pendingInteractions = DesktopInteraction.list(remote["pendingInteractions"]) else {
            return nil
        }
        let model: RemoteModel?
        if let raw = remote["model"], !(raw is NSNull) {
            guard let decoded = RemoteModel(remote: raw) else { return nil }
            model = decoded
        } else {
            model = nil
        }
        self.init(
            sessionId: sessionId,
            permission: DesktopPermissionState(remote: permission),
            model: model,
            pendingInteractions: pendingInteractions,
            interactionsSupported: interactionsSupported,
            canControl: canControl,
            activity: SessionActivity(remoteValue: remote["activity"] as? String)
        )
    }
}

private enum DesktopDecoding {
    static func nonEmptyString(_ value: Any?) -> String? {
        guard let string = value as? String,
              !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return string
    }

    static func optionalString(_ value: Any?) -> String? {
        guard let value, !(value is NSNull) else { return nil }
        return value as? String
    }
}
