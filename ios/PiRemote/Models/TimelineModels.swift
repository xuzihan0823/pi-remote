import Foundation

public struct TimelineItem: Identifiable, Equatable {
    public let id: String
    public let kind: String
    public let role: String?
    public let text: String?
    public let name: String?
    public let toolCallId: String?
    public let status: String?
    public let preview: String?
    public let detailId: String?
    public let truncated: Bool
    public let sourceTruncated: Bool

    public init?(remote: [String: Any]) {
        guard let id = remote["id"] as? String, let kind = remote["kind"] as? String else { return nil }
        self.id = id
        self.kind = kind
        role = remote["role"] as? String
        text = remote["text"] as? String
        name = remote["name"] as? String
        toolCallId = remote["toolCallId"] as? String
        status = remote["status"] as? String
        preview = remote["preview"] as? String
        detailId = remote["detailId"] as? String
        truncated = remote["truncated"] as? Bool ?? false
        sourceTruncated = remote["sourceTruncated"] as? Bool ?? false
    }

    public var statusLabel: String {
        switch status {
        case "requested": return "已请求"
        case "running": return "执行中"
        case "succeeded": return "成功"
        case "failed": return "失败"
        case "cancelled": return "已取消"
        default: return kind == "toolResult" ? "未配对结果" : "未记录结果／可能中断"
        }
    }
}

public struct TimelineBranch: Identifiable, Equatable {
    public let id: String
    public let title: String
    public let damaged: Bool
    public init?(remote: [String: Any]) {
        guard let id = remote["id"] as? String, let title = remote["title"] as? String else { return nil }
        self.id = id; self.title = title
        damaged = remote["damaged"] as? Bool ?? false
    }
}

public struct ToolDetailPage: Equatable {
    public var text: String
    public var recorded: Bool
    public var nextCursor: String?
    public var sourceTruncated: Bool
    public var error: String?

    public init(remote: [String: Any]) {
        text = remote["text"] as? String ?? ""
        recorded = remote["recorded"] as? Bool ?? false
        nextCursor = remote["nextCursor"] as? String
        sourceTruncated = remote["sourceTruncated"] as? Bool ?? false
    }
}
