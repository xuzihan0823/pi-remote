import Foundation

// Claude 后端（backend/claude daemon）的纯数据与纯逻辑：配对码、深链、HTTP 响应、WS 帧、
// 流式草稿合并、转录分页与搜索结果映射。只依赖 Foundation，可在 Mac 上用 swiftc 单独编译测试。
// 字段与 backend/claude/src/server.ts、transcript/types.ts、run/approval.ts、run/stream-buffer.ts 对齐。

// MARK: - JSON helpers

enum ClaudeJSON {
    static func object(_ data: Data) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    static func string(_ value: Any?) -> String? { value as? String }

    /// JSONSerialization 把 true/false 也解成 NSNumber，布尔值与数字必须区分开。
    static func isBoolean(_ number: NSNumber) -> Bool {
        #if canImport(Darwin)
        return CFGetTypeID(number) == CFBooleanGetTypeID()
        #else
        return String(cString: number.objCType) == "c"
        #endif
    }

    static func int(_ value: Any?) -> Int? {
        if let number = value as? NSNumber {
            if isBoolean(number) { return nil }
            let double = number.doubleValue
            guard double.isFinite, double.rounded() == double, abs(double) <= 9_007_199_254_740_991 else { return nil }
            return Int(double)
        }
        return nil
    }

    static func double(_ value: Any?) -> Double? {
        if let number = value as? NSNumber, !isBoolean(number) { return number.doubleValue }
        return nil
    }

    static func bool(_ value: Any?) -> Bool? {
        if let number = value as? NSNumber, isBoolean(number) { return number.boolValue }
        return nil
    }

    /// 工具入参之类的任意 JSON 转成便于阅读的文本（键排序，限制长度）。
    static func preview(_ value: Any?, limit: Int = 4000) -> String? {
        guard let value, !(value is NSNull) else { return nil }
        if let text = value as? String { return String(text.prefix(limit)) }
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]) else {
            return nil
        }
        let text = String(decoding: data, as: UTF8.self)
        return text.count > limit ? String(text.prefix(limit)) + "…" : text
    }
}

private func millisDate(_ value: Any?) -> Date? {
    guard let ms = ClaudeJSON.double(value), ms > 0 else { return nil }
    return Date(timeIntervalSince1970: ms / 1000)
}

// MARK: - Sessions

public enum ClaudeSessionStatus: String, Equatable {
    case idle
    case terminalDriving = "terminal-driving"
    case daemonDriving = "daemon-driving"
    case unknown

    init(remote: Any?) {
        self = (remote as? String).flatMap(ClaudeSessionStatus.init(rawValue:)) ?? .unknown
    }

    public var label: String {
        switch self {
        case .idle: return "可接管"
        case .terminalDriving: return "终端驾驶"
        case .daemonDriving: return "运行中"
        case .unknown: return "未知"
        }
    }
}

public struct ClaudeSessionSummary: Identifiable, Equatable {
    public let id: String
    public var cwd: String
    public var projectDirName: String
    public var title: String
    public var lastPreview: String
    public var lastActiveAt: Date?
    public var sizeBytes: Int
    public var status: ClaudeSessionStatus

    public init(id: String, cwd: String = "", projectDirName: String = "", title: String = "", lastPreview: String = "",
                lastActiveAt: Date? = nil, sizeBytes: Int = 0, status: ClaudeSessionStatus = .unknown) {
        self.id = id
        self.cwd = cwd
        self.projectDirName = projectDirName
        self.title = title
        self.lastPreview = lastPreview
        self.lastActiveAt = lastActiveAt
        self.sizeBytes = sizeBytes
        self.status = status
    }

    init?(json: [String: Any]) {
        guard let id = json["sessionId"] as? String, !id.isEmpty else { return nil }
        self.init(
            id: id,
            cwd: json["cwd"] as? String ?? "",
            projectDirName: json["projectDirName"] as? String ?? "",
            title: (json["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "(空会话)",
            lastPreview: json["lastPreview"] as? String ?? "",
            lastActiveAt: millisDate(json["lastActiveAt"]),
            sizeBytes: ClaudeJSON.int(json["sizeBytes"]) ?? 0,
            status: ClaudeSessionStatus(remote: json["status"])
        )
    }

    /// 合并分页：同一会话以后到的为准，顺序保持首次出现的位置。
    public static func merge(_ existing: [ClaudeSessionSummary], _ incoming: [ClaudeSessionSummary]) -> [ClaudeSessionSummary] {
        var result = existing
        var index: [String: Int] = [:]
        for (offset, item) in result.enumerated() { index[item.id] = offset }
        for item in incoming {
            if let at = index[item.id] { result[at] = item } else {
                index[item.id] = result.count
                result.append(item)
            }
        }
        return result
    }
}

public struct ClaudeSessionPage: Equatable {
    public var sessions: [ClaudeSessionSummary]
    public var total: Int

    init(json: [String: Any]) {
        sessions = (json["sessions"] as? [[String: Any]] ?? []).compactMap(ClaudeSessionSummary.init(json:))
        total = ClaudeJSON.int(json["total"]) ?? sessions.count
    }
}

/// 浏览筛选：全部、未归类（cwd 为空）或某个项目。
public enum ClaudeProjectFilter: Hashable {
    case all
    case unclassified
    case project(String)

    var queryValue: String? {
        switch self {
        case .all: return nil
        case .unclassified: return ""
        case .project(let id): return id
        }
    }
}

// MARK: - Messages

public struct ClaudeMessage: Identifiable, Equatable {
    public enum Kind: String, Equatable {
        case text
        case toolUse = "tool_use"
        case toolResult = "tool_result"
        case thinking
        case meta
        case other
    }

    public let seq: Int
    public let blockIndex: Int
    public var uuid: String
    public var role: String
    public var kind: Kind
    public var text: String?
    public var toolName: String?
    public var toolInputPreview: String?
    public var toolUseId: String?
    public var isError: Bool
    public var timestamp: String?
    public var rawType: String?

    /// 与服务端一致的去重/分页键：seq:blockIndex。
    public var id: String { "\(seq):\(blockIndex)" }
    public var isUser: Bool { role == "user" }
    public var isAssistantText: Bool { role == "assistant" && kind == .text }

    public init(seq: Int, blockIndex: Int = 0, uuid: String = "", role: String, kind: Kind, text: String? = nil,
                toolName: String? = nil, toolInputPreview: String? = nil, toolUseId: String? = nil,
                isError: Bool = false, timestamp: String? = nil, rawType: String? = nil) {
        self.seq = seq
        self.blockIndex = blockIndex
        self.uuid = uuid
        self.role = role
        self.kind = kind
        self.text = text
        self.toolName = toolName
        self.toolInputPreview = toolInputPreview
        self.toolUseId = toolUseId
        self.isError = isError
        self.timestamp = timestamp
        self.rawType = rawType
    }

    init?(json: [String: Any]) {
        guard let seq = ClaudeJSON.int(json["seq"]), seq >= 1,
              let role = json["role"] as? String, role == "user" || role == "assistant" else { return nil }
        self.init(
            seq: seq,
            blockIndex: max(0, ClaudeJSON.int(json["blockIndex"]) ?? 0),
            uuid: json["uuid"] as? String ?? "",
            role: role,
            kind: (json["kind"] as? String).flatMap(Kind.init(rawValue:)) ?? .other,
            text: json["text"] as? String,
            toolName: json["toolName"] as? String,
            toolInputPreview: ClaudeJSON.preview(json["toolInput"]),
            toolUseId: json["toolUseId"] as? String,
            isError: ClaudeJSON.bool(json["isError"]) ?? false,
            timestamp: json["timestamp"] as? String,
            rawType: json["rawType"] as? String
        )
    }

    static func ordered(_ a: ClaudeMessage, _ b: ClaudeMessage) -> Bool {
        a.seq != b.seq ? a.seq < b.seq : a.blockIndex < b.blockIndex
    }
}

public struct ClaudeMessagePage: Equatable {
    public var messages: [ClaudeMessage]
    /// 本页窗口首个主链行的 seq；向上翻页时作为下一次的 beforeSeq。
    public var firstSeq: Int?
    public var hasMore: Bool

    public init(messages: [ClaudeMessage], firstSeq: Int?, hasMore: Bool) {
        self.messages = messages
        self.firstSeq = firstSeq
        self.hasMore = hasMore
    }

    init(json: [String: Any]) {
        messages = (json["messages"] as? [[String: Any]] ?? []).compactMap(ClaudeMessage.init(json:))
        firstSeq = ClaudeJSON.int(json["firstSeq"])
        hasMore = ClaudeJSON.bool(json["hasMore"]) ?? false
    }
}

/// 一个会话已加载的转录：按 seq:blockIndex 去重、升序。
public struct ClaudeTranscript: Equatable {
    public private(set) var messages: [ClaudeMessage] = []
    private var keys: Set<String> = []
    public var firstSeq: Int?
    public var hasMore = false

    public init() {}

    public var isEmpty: Bool { messages.isEmpty }

    public func contains(_ message: ClaudeMessage) -> Bool { keys.contains(message.id) }

    /// 追加新消息，返回是否有变化。
    @discardableResult
    public mutating func add(_ incoming: [ClaudeMessage]) -> Bool {
        var fresh: [ClaudeMessage] = []
        for message in incoming where !keys.contains(message.id) {
            keys.insert(message.id)
            fresh.append(message)
        }
        guard !fresh.isEmpty else { return false }
        fresh.sort(by: ClaudeMessage.ordered)
        if let last = messages.last, let first = fresh.first, !ClaudeMessage.ordered(first, last) {
            messages.append(contentsOf: fresh)
        } else {
            messages = (messages + fresh).sorted(by: ClaudeMessage.ordered)
        }
        return true
    }

    /// 首屏/重拉：用尾页覆盖分页游标。
    public mutating func applyTail(_ page: ClaudeMessagePage) {
        add(page.messages)
        firstSeq = page.firstSeq
        hasMore = page.hasMore
    }

    /// 向上翻页。
    public mutating func applyOlder(_ page: ClaudeMessagePage) {
        add(page.messages)
        firstSeq = page.firstSeq
        hasMore = page.hasMore
    }

    /// 重连补缺口：尾页与已有内容是否有重叠（无重叠需要继续向前翻）。
    public func overlaps(_ page: ClaudeMessagePage) -> Bool {
        page.messages.contains { keys.contains($0.id) }
    }

    public mutating func reset() { self = ClaudeTranscript() }

    /// 搜索命中定位：优先同 seq，否则取其后最近的一条（命中行可能是不渲染的 meta 行）。
    public func focusIndex(for seq: Int) -> Int? {
        messages.firstIndex { $0.seq >= seq }
    }

    /// 已加载范围是否覆盖 seq（未覆盖且还有更早的页时需要继续翻页）。
    public func needsOlderPages(toReach seq: Int) -> Bool {
        guard hasMore, let firstSeq else { return false }
        return firstSeq > seq
    }
}

// MARK: - Streaming drafts

public struct ClaudeStreamFrame: Equatable {
    public var sessionId: String
    public var key: String?
    public var offset: Int
    public var text: String?
    public var done: Bool
    public var clear: Bool

    public init(sessionId: String, key: String? = nil, offset: Int = 0, text: String? = nil, done: Bool = false, clear: Bool = false) {
        self.sessionId = sessionId
        self.key = key
        self.offset = offset
        self.text = text
        self.done = done
        self.clear = clear
    }
}

public struct ClaudeDraft: Equatable, Identifiable {
    public var key: String
    public var text: String
    public var done: Bool
    public var id: String { key }
}

/// daemon 推来的 stream 帧 → 末尾「正在输出」的草稿。正文以 JSONL 落盘后经 message 帧来的消息为准，
/// 对上了就删掉对应草稿。与 claude-remote web/core/stream-drafts.js 同语义。
public enum ClaudeStreamDrafts {
    public static func apply(_ drafts: [ClaudeDraft], _ frame: ClaudeStreamFrame) -> [ClaudeDraft] {
        if frame.clear { return [] }
        guard let key = frame.key, let text = frame.text else { return drafts }
        let offset = max(0, frame.offset)
        guard let index = drafts.firstIndex(where: { $0.key == key }) else {
            // 没见过开头：等订阅时的快照（offset 0）
            guard offset == 0 else { return drafts }
            return drafts + [ClaudeDraft(key: key, text: text, done: frame.done)]
        }
        var current = drafts[index]
        let existing = Array(current.text)
        if offset == 0 {
            current.text = text
        } else if offset <= existing.count {
            current.text = String(existing[0..<offset]) + text
        } else {
            return drafts // 有缺口：丢帧，等快照或落盘
        }
        current.done = current.done || frame.done
        var next = drafts
        next[index] = current
        return next
    }

    private static func normalize(_ text: String?) -> String {
        (text ?? "").split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    /// 转录里来了一条消息：assistant 文本对上某份草稿就删掉它。
    public static func reconcile(_ drafts: [ClaudeDraft], with message: ClaudeMessage) -> [ClaudeDraft] {
        guard !drafts.isEmpty, message.isAssistantText else { return drafts }
        let text = normalize(message.text)
        guard !text.isEmpty else { return drafts }
        var index = drafts.firstIndex { normalize($0.text) == text }
        if index == nil {
            index = drafts.firstIndex { draft in
                let draftText = normalize(draft.text)
                return draft.done && (text.hasPrefix(draftText) || draftText.hasPrefix(text))
            }
        }
        guard let index else { return drafts }
        var next = drafts
        next.remove(at: index)
        return next
    }
}

// MARK: - Projects

public struct ClaudeProject: Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public var name: String
    public var cwd: String
    public var cwds: [String]
    public var sessionCount: Int
    public var lastActiveAt: Date?
}

public struct ClaudeProjectCatalog: Equatable, Sendable {
    public var projects: [ClaudeProject]
    public var totalSessions: Int
    public var unclassifiedCount: Int
    public var homeCwd: String

    public static let empty = ClaudeProjectCatalog(projects: [], totalSessions: 0, unclassifiedCount: 0, homeCwd: "")

    public init(projects: [ClaudeProject], totalSessions: Int, unclassifiedCount: Int, homeCwd: String) {
        self.projects = projects
        self.totalSessions = totalSessions
        self.unclassifiedCount = unclassifiedCount
        self.homeCwd = homeCwd
    }

    init(json: [String: Any]) {
        let rows = json["projects"] as? [[String: Any]] ?? []
        projects = rows.compactMap { row in
            guard let id = row["id"] as? String, !id.isEmpty else { return nil }
            let cwds = (row["cwds"] as? [Any] ?? []).compactMap { $0 as? String }.filter { !$0.isEmpty }
            let cwd = (row["cwd"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? cwds.first ?? ""
            let name = (row["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? ClaudeProjectCatalog.pathTail(id, segments: 1)
            return ClaudeProject(
                id: id,
                name: name,
                cwd: cwd,
                cwds: !cwd.isEmpty && !cwds.contains(cwd) ? [cwd] + cwds : cwds,
                sessionCount: ClaudeJSON.int(row["sessionCount"]) ?? 0,
                lastActiveAt: millisDate(row["lastActiveAt"])
            )
        }
        totalSessions = ClaudeJSON.int(json["totalSessions"]) ?? 0
        unclassifiedCount = ClaudeJSON.int(json["unclassifiedCount"]) ?? 0
        homeCwd = json["homeCwd"] as? String ?? ""
    }

    public static func pathTail(_ path: String, segments: Int = 2) -> String {
        path.split(separator: "/").suffix(segments).joined(separator: "/")
    }

    /// 把 /Users/<name> 前缀缩成 ~，方便在手机上看。
    public static func shortPath(_ path: String) -> String {
        guard path.hasPrefix("/Users/") else { return path }
        let rest = path.dropFirst("/Users/".count)
        guard let slash = rest.firstIndex(of: "/") else { return "~" }
        return "~" + rest[slash...]
    }

    public func project(forCwd cwd: String) -> ClaudeProject? {
        guard !cwd.isEmpty else { return nil }
        return projects.first { $0.cwds.contains(cwd) }
    }

    /// 同名项目追加父目录区分。
    public func title(for project: ClaudeProject) -> String {
        let sameName = projects.filter { $0.name == project.name }.count
        guard sameName > 1 else { return project.name }
        let parent = ClaudeProjectCatalog.pathTail(project.id.split(separator: "/").dropLast().joined(separator: "/"), segments: 1)
        return parent.isEmpty ? project.name : "\(project.name) · \(parent)"
    }

    /// 新建会话可选的工作目录：各项目 cwd（含子目录）与 home，去重保序。daemon 只接受这些已知目录。
    public var selectableCwds: [String] {
        var seen = Set<String>()
        var result: [String] = []
        for cwd in projects.flatMap({ $0.cwds }) + [homeCwd] where !cwd.isEmpty && !seen.contains(cwd) {
            seen.insert(cwd)
            result.append(cwd)
        }
        return result
    }
}

// MARK: - Interactions (approvals / questions)

public struct ClaudeQuestionOption: Equatable, Hashable {
    public var label: String
    public var description: String
}

public struct ClaudeQuestion: Equatable, Hashable {
    public var question: String
    public var header: String
    public var options: [ClaudeQuestionOption]
    public var multiSelect: Bool
}

public struct ClaudeInteraction: Identifiable, Equatable {
    public enum Kind: String, Equatable { case approval, question }

    public let id: String
    public var sessionId: String
    public var kind: Kind
    public var toolName: String
    public var prompt: String
    public var inputPreview: String?
    public var expiresAt: Date
    public var questions: [ClaudeQuestion]

    init?(json: [String: Any]) {
        guard let id = json["interactionId"] as? String, !id.isEmpty,
              let sessionId = json["sessionId"] as? String,
              let kind = (json["kind"] as? String).flatMap(Kind.init(rawValue:)) else { return nil }
        self.id = id
        self.sessionId = sessionId
        self.kind = kind
        toolName = json["toolName"] as? String ?? ""
        prompt = json["prompt"] as? String ?? ""
        inputPreview = ClaudeJSON.preview(json["input"])
        expiresAt = millisDate(json["expiresAt"]) ?? Date.distantFuture
        questions = (json["questions"] as? [[String: Any]] ?? []).compactMap { row in
            guard let question = row["question"] as? String, !question.isEmpty else { return nil }
            let options = (row["options"] as? [[String: Any]] ?? []).compactMap { option -> ClaudeQuestionOption? in
                guard let label = option["label"] as? String, !label.isEmpty else { return nil }
                return ClaudeQuestionOption(label: label, description: option["description"] as? String ?? "")
            }
            return ClaudeQuestion(question: question, header: row["header"] as? String ?? "",
                                  options: options, multiSelect: ClaudeJSON.bool(row["multiSelect"]) ?? false)
        }
    }

    /// 待审批补拉结果：按到期先后排序。
    static func pendingList(json: [String: Any]) -> [ClaudeInteraction] {
        (json["interactions"] as? [[String: Any]] ?? [])
            .compactMap(ClaudeInteraction.init(json:))
            .sorted { $0.expiresAt < $1.expiresAt }
    }
}

public enum ClaudeDecision: Equatable {
    case allowOnce
    case deny(message: String?)
    /// 按题目原文作 key（daemon 以 question 文本匹配答案）。
    case answer([String: String])

    public var jsonObject: [String: Any] {
        switch self {
        case .allowOnce: return ["type": "allow_once"]
        case .deny(let message):
            var body: [String: Any] = ["type": "deny"]
            if let message, !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { body["message"] = message }
            return body
        case .answer(let answers): return ["type": "answer", "answers": answers]
        }
    }

    /// 本地乐观标记用的终态。
    public var optimisticStatus: String {
        switch self {
        case .allowOnce: return "allowed"
        case .deny: return "denied"
        case .answer: return "answered"
        }
    }

    /// 由每题的选项与自由输入拼出答案；有未答的题返回 nil。多选用「, 」连接，自由输入优先。
    public static func answers(for questions: [ClaudeQuestion], selections: [String: [String]], freeText: [String: String]) -> [String: String]? {
        var result: [String: String] = [:]
        for question in questions {
            let free = (freeText[question.question] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let picked = (selections[question.question] ?? []).filter { !$0.isEmpty }
            if !free.isEmpty {
                result[question.question] = free
            } else if !picked.isEmpty {
                result[question.question] = picked.joined(separator: ", ")
            } else {
                return nil
            }
        }
        return result
    }
}

// MARK: - Runs / abort

public struct ClaudeRunEvent: Equatable {
    public enum State: String, Equatable { case started, done, error }

    public var runId: String
    public var state: State
    public var error: String?
    public var permissionMode: String?
}

public enum ClaudeAbortStatus: String, Equatable {
    /// 停掉了 daemon 自己的 run。
    case aborted
    /// daemon 没有 run，但会话被判为终端驾驶：已解除占用。
    case released
    /// 本来就空闲，什么也没做。
    case idle

    init(json: [String: Any]) {
        self = (json["status"] as? String).flatMap(ClaudeAbortStatus.init(rawValue:)) ?? .idle
    }

    public var message: String {
        switch self {
        case .aborted: return "已停止当前运行"
        case .released: return "已解除终端占用"
        case .idle: return "会话本来就空闲"
        }
    }
}

// MARK: - WebSocket frames

public enum ClaudeFrame: Equatable {
    case message(sessionId: String, ClaudeMessage)
    case stream(ClaudeStreamFrame)
    case status(sessionId: String, ClaudeSessionStatus)
    case run(sessionId: String, ClaudeRunEvent)
    case resync(sessionId: String)
    case approval(ClaudeInteraction)
    case approvalResolved(interactionId: String, status: String)

    /// 未知或不完整的帧返回 nil（向前兼容：新 daemon 加帧不影响旧 App）。
    public static func decode(_ text: String) -> ClaudeFrame? {
        guard text.utf8.count <= 8 * 1024 * 1024, let json = ClaudeJSON.object(Data(text.utf8)) else { return nil }
        return decode(json)
    }

    static func decode(_ json: [String: Any]) -> ClaudeFrame? {
        guard let type = json["type"] as? String else { return nil }
        let sessionId = json["sessionId"] as? String
        switch type {
        case "message":
            guard let sessionId, let raw = json["message"] as? [String: Any], let message = ClaudeMessage(json: raw) else { return nil }
            return .message(sessionId: sessionId, message)
        case "stream":
            guard let sessionId else { return nil }
            if ClaudeJSON.bool(json["clear"]) == true { return .stream(ClaudeStreamFrame(sessionId: sessionId, clear: true)) }
            guard let key = json["key"] as? String, let text = json["text"] as? String else { return nil }
            return .stream(ClaudeStreamFrame(sessionId: sessionId, key: key, offset: ClaudeJSON.int(json["offset"]) ?? 0,
                                             text: text, done: ClaudeJSON.bool(json["done"]) ?? false))
        case "status":
            guard let sessionId else { return nil }
            return .status(sessionId: sessionId, ClaudeSessionStatus(remote: json["status"]))
        case "run":
            guard let sessionId, let state = (json["state"] as? String).flatMap(ClaudeRunEvent.State.init(rawValue:)) else { return nil }
            return .run(sessionId: sessionId, ClaudeRunEvent(runId: json["runId"] as? String ?? "", state: state,
                                                             error: json["error"] as? String,
                                                             permissionMode: json["permissionMode"] as? String))
        case "resync":
            guard let sessionId else { return nil }
            return .resync(sessionId: sessionId)
        case "approval":
            guard let raw = json["interaction"] as? [String: Any], let interaction = ClaudeInteraction(json: raw) else { return nil }
            return .approval(interaction)
        case "approval.resolved":
            guard let id = json["interactionId"] as? String else { return nil }
            return .approvalResolved(interactionId: id, status: json["status"] as? String ?? "")
        default:
            return nil
        }
    }

    static func subscribe(_ sessionId: String) -> String { control("subscribe", sessionId) }
    static func unsubscribe(_ sessionId: String) -> String { control("unsubscribe", sessionId) }

    private static func control(_ type: String, _ sessionId: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: ["type": type, "sessionId": sessionId])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }
}

// MARK: - Search

public enum ClaudeSearchField: String, Equatable {
    case title, cwd, preview, content

    public var label: String {
        switch self {
        case .title: return "标题"
        case .cwd: return "路径"
        case .preview: return "最近消息"
        case .content: return "正文"
        }
    }
}

public struct ClaudeSearchResult: Identifiable, Equatable {
    public var session: ClaudeSessionSummary
    public var field: ClaudeSearchField
    public var snippet: String
    /// field=content 时为命中消息所在行号，可直接用于在会话里定位。
    public var seq: Int?
    public var id: String { session.id }

    init?(json: [String: Any]) {
        guard let session = ClaudeSessionSummary(json: json) else { return nil }
        let match = json["match"] as? [String: Any] ?? [:]
        self.session = session
        field = (match["field"] as? String).flatMap(ClaudeSearchField.init(rawValue:)) ?? .title
        snippet = match["snippet"] as? String ?? session.title
        seq = ClaudeJSON.int(match["seq"]).flatMap { $0 >= 1 ? $0 : nil }
    }

    /// 点击搜索结果要打开的位置：会话 + 可选的命中行。
    public var target: ClaudeSessionTarget { ClaudeSessionTarget(sessionId: session.id, focusSeq: field == .content ? seq : nil) }
}

public struct ClaudeSessionTarget: Equatable, Hashable {
    public var sessionId: String
    public var focusSeq: Int?
}

public struct ClaudeSearchResponse: Equatable {
    public var results: [ClaudeSearchResult]
    public var truncated: Bool

    init(json: [String: Any]) {
        results = (json["results"] as? [[String: Any]] ?? []).compactMap(ClaudeSearchResult.init(json:))
        truncated = ClaudeJSON.bool(json["truncated"]) ?? false
    }

    /// 合并 meta（标题/路径/预览）与 full（正文）结果：同一会话只保留第一次（meta 优先）。
    public static func merge(_ first: [ClaudeSearchResult], _ second: [ClaudeSearchResult]) -> [ClaudeSearchResult] {
        var seen = Set(first.map(\.id))
        var result = first
        for item in second where !seen.contains(item.id) {
            seen.insert(item.id)
            result.append(item)
        }
        return result
    }
}

// MARK: - Errors

public enum ClaudeAPIError: Error, Equatable, LocalizedError {
    case http(status: Int, code: String)
    case unauthorized
    case network
    case timeout
    case invalidResponse
    case connectionChanged
    case insecureTransport

    public var code: String {
        switch self {
        case .http(_, let code): return code
        case .unauthorized: return "unauthorized"
        case .network: return "network_error"
        case .timeout: return "network_timeout"
        case .invalidResponse: return "invalid_response"
        case .connectionChanged: return "connection_changed"
        case .insecureTransport: return "insecure_transport"
        }
    }

    public var errorDescription: String? {
        switch self {
        case .unauthorized: return "Token 不正确，请重新配对"
        case .network: return "无法连接 Claude 后端（地址或网络错误）"
        case .timeout: return "连接超时：检查 Mac 上的 Claude 后端是否在运行、Tailscale 是否开启"
        case .invalidResponse: return "Claude 后端返回了无法识别的数据"
        case .connectionChanged: return "连接已切换"
        case .insecureTransport: return "公网地址必须使用 https://，明文 http:// 仅限本机、局域网或 Tailscale"
        case .http(let status, let code):
            switch code {
            case "session_not_found": return "会话不存在"
            case "not_idle": return "会话正在运行，请稍后再发"
            case "unknown_cwd": return "Mac 上没有这个工作目录的会话记录，请从项目列表中选择"
            case "already_resolved": return "该审批已在别处处理"
            case "not_found": return "内容已不存在"
            default: return "请求失败（\(status) \(code)）"
            }
        }
    }

    static func from(status: Int, body: [String: Any]?) -> ClaudeAPIError {
        if status == 401 { return .unauthorized }
        return .http(status: status, code: body?["error"] as? String ?? "http_\(status)")
    }
}

// MARK: - Pairing & deep links

public struct ClaudePairingCode: Equatable {
    public var token: String
    /// 候选地址（Tailscale、局域网、.local），按优先级排列。
    public var bases: [URL]
}

public enum ClaudePairing {
    public enum ParseError: LocalizedError, Equatable {
        case invalidCode
        case unsupportedVersion
        case invalidServer
        case insecureServer
        case invalidToken

        public var errorDescription: String? {
            switch self {
            case .invalidCode: return "这不是 Claude 后端的配对码（应以 claude-remote://setup 开头）。"
            case .unsupportedVersion: return "此配对码需要更新版本的 Pi Remote。"
            case .invalidServer: return "配对码中没有可用的服务器地址，请在 Mac 上重新生成。"
            case .insecureServer: return "配对码中的地址是公网明文 http://，为保护 Token 已拒绝；请使用 Tailscale / 局域网地址或 https://。"
            case .invalidToken: return "配对码中的连接凭据无效，请在 Mac 上重新生成。"
            }
        }
    }

    static let maxLength = 4096
    static let maxBases = 8

    /// 解析 `claude-remote://setup?v=1&token=…&bases=<enc>,<enc>`（见 backend/claude/src/pair.ts）。
    public static func parse(_ raw: String) throws -> ClaudePairingCode {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.utf8.count <= maxLength, value.lowercased().hasPrefix("claude-remote:"),
              let components = URLComponents(string: value),
              components.scheme?.lowercased() == "claude-remote" else {
            throw ParseError.invalidCode
        }
        let location = ((components.host ?? "") + components.percentEncodedPath)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard location == "setup" else { throw ParseError.invalidCode }

        let params = rawQuery(components.percentEncodedQuery)
        if let version = params["v"], version != "1" { throw ParseError.unsupportedVersion }

        guard let encodedToken = params["token"], let token = encodedToken.removingPercentEncoding,
              isValidToken(token) else {
            throw ParseError.invalidToken
        }

        let candidates = (params["bases"] ?? "").split(separator: ",").prefix(maxBases)
            .compactMap { String($0).removingPercentEncoding }
        var bases: [URL] = []
        var sawInsecure = false
        for candidate in candidates {
            switch normalizeBase(candidate) {
            case .success(let url): if !bases.contains(url) { bases.append(url) }
            case .failure(let error): if error == .insecureServer { sawInsecure = true }
            }
        }
        guard !bases.isEmpty else { throw sawInsecure ? ParseError.insecureServer : ParseError.invalidServer }
        return ClaudePairingCode(token: token, bases: bases)
    }

    static func isValidToken(_ token: String) -> Bool {
        let forbidden = CharacterSet.whitespacesAndNewlines.union(.controlCharacters)
        return token.utf16.count >= 32 && token.utf16.count <= 512 && token.rangeOfCharacter(from: forbidden) == nil
    }

    /// 规范化服务器地址：缺省补 http://，去掉末尾斜杠；只接受 http/https、无凭据/查询/片段，
    /// 明文 http 仅限本机、局域网和 Tailscale。
    public static func normalizeBase(_ raw: String) -> Result<URL, ParseError> {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let forbidden = CharacterSet.whitespacesAndNewlines.union(.controlCharacters)
        guard !text.isEmpty, text.rangeOfCharacter(from: forbidden) == nil else { return .failure(.invalidServer) }
        if !text.lowercased().hasPrefix("http://") && !text.lowercased().hasPrefix("https://") {
            guard !text.contains("://") else { return .failure(.invalidServer) }
            text = "http://" + text
        }
        while text.hasSuffix("/") { text.removeLast() }
        guard let components = URLComponents(string: text),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty, host.rangeOfCharacter(from: forbidden) == nil,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.port.map({ (1...65535).contains($0) }) ?? true,
              let url = URL(string: text) else {
            return .failure(.invalidServer)
        }
        guard TransportSecurity.allows(scheme: scheme, host: host) else { return .failure(.insecureServer) }
        return .success(url)
    }

    /// 与 JS 版一致：按 & 切原始查询串，值保持百分号编码（bases 内部再按逗号切后各自解码）。
    static func rawQuery(_ query: String?) -> [String: String] {
        var result: [String: String] = [:]
        for pair in (query ?? "").split(separator: "&") {
            guard let equals = pair.firstIndex(of: "="), equals != pair.startIndex else { continue }
            let key = String(pair[..<equals])
            if result[key] == nil { result[key] = String(pair[pair.index(after: equals)...]) }
        }
        return result
    }
}

public enum ClaudeDeepLink: Equatable {
    case setup(ClaudePairingCode)
    case approval(interactionId: String, sessionId: String?)
    case session(sessionId: String)

    /// claude-remote://setup?…、claude-remote://approval/<id>?session=<sid>、claude-remote://session/<sid>
    public static func parse(_ url: URL) -> ClaudeDeepLink? {
        parse(url.absoluteString)
    }

    public static func parse(_ raw: String) -> ClaudeDeepLink? {
        guard raw.utf8.count <= ClaudePairing.maxLength, let components = URLComponents(string: raw),
              components.scheme?.lowercased() == "claude-remote" else { return nil }
        let path = ((components.host ?? "") + components.percentEncodedPath)
        let segments = path.split(separator: "/").map { $0.removingPercentEncoding ?? String($0) }
        guard let head = segments.first else { return nil }
        switch head {
        case "setup":
            return (try? ClaudePairing.parse(raw)).map { .setup($0) }
        case "approval":
            guard segments.count >= 2, isSafeIdentifier(segments[1]) else { return nil }
            let session = ClaudePairing.rawQuery(components.percentEncodedQuery)["session"]?.removingPercentEncoding
            return .approval(interactionId: segments[1], sessionId: session.flatMap { isSessionId($0) ? $0 : nil })
        case "session":
            guard segments.count >= 2, isSessionId(segments[1]) else { return nil }
            return .session(sessionId: segments[1])
        default:
            return nil
        }
    }

    static func isSafeIdentifier(_ value: String) -> Bool {
        guard (1...128).contains(value.utf8.count) else { return false }
        return value.utf8.allSatisfy { byte in
            (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte) || byte == 45 || byte == 95 || byte == 46
        }
    }

    /// Claude 会话 id 是 JSONL 文件名（UUID）。
    public static func isSessionId(_ value: String) -> Bool {
        let parts = value.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.map(\.count) == [8, 4, 4, 4, 12] else { return false }
        return value.utf8.allSatisfy { byte in
            (48...57).contains(byte) || (65...70).contains(byte) || (97...102).contains(byte) || byte == 45
        }
    }
}

// MARK: - Endpoints

public enum ClaudeEndpoints {
    public static func url(_ base: URL, _ path: String, query: [(String, String)] = []) -> URL? {
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        let prefix = components.percentEncodedPath.hasSuffix("/") ? String(components.percentEncodedPath.dropLast()) : components.percentEncodedPath
        components.percentEncodedPath = prefix + path
        components.queryItems = query.isEmpty ? nil : query.map { URLQueryItem(name: $0.0, value: $0.1) }
        // URLQueryItem 不会编码 +，daemon 用 URLSearchParams 解析会把 + 当空格
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.url
    }

    /// 路径段编码（会话 id、交互 id）。
    public static func segment(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    public static func sessions(_ base: URL, limit: Int, offset: Int, filter: ClaudeProjectFilter) -> URL? {
        var query = [("limit", String(limit)), ("offset", String(offset))]
        if let projectId = filter.queryValue { query.append(("projectId", projectId)) }
        return url(base, "/api/sessions", query: query)
    }

    public static func messages(_ base: URL, sessionId: String, limit: Int = 100, beforeSeq: Int? = nil) -> URL? {
        var query = [("limit", String(limit))]
        if let beforeSeq { query.append(("beforeSeq", String(beforeSeq))) }
        return url(base, "/api/sessions/\(segment(sessionId))/messages", query: query)
    }

    public static func search(_ base: URL, query text: String, full: Bool, limit: Int = 30) -> URL? {
        var query = [("q", text), ("limit", String(limit))]
        if full { query.append(("full", "1")) }
        return url(base, "/api/sessions/search", query: query)
    }

    public static func abort(_ base: URL, sessionId: String) -> URL? {
        url(base, "/api/sessions/\(segment(sessionId))/abort")
    }

    public static func decision(_ base: URL, interactionId: String) -> URL? {
        url(base, "/api/interactions/\(segment(interactionId))/decision")
    }

    /// WS 端点：daemon 只认查询串里的 token（浏览器 WebSocket 不能带头）。明文 ws 仅在 base 已通过传输规则时使用。
    public static func websocket(_ base: URL, token: String) -> URL? {
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              TransportSecurity.allows(scheme: scheme, host: components.host ?? "") else { return nil }
        components.scheme = scheme == "https" ? "wss" : "ws"
        let prefix = components.percentEncodedPath.hasSuffix("/") ? String(components.percentEncodedPath.dropLast()) : components.percentEncodedPath
        components.percentEncodedPath = prefix + "/ws"
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.url
    }
}
