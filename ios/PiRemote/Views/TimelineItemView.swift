import SwiftUI

struct TimelineItemView: View {
    let item: TimelineItem
    @Bindable var client: RelayClient
    @State private var expanded = false

    var body: some View {
        if item.kind == "message" {
            VStack(alignment: item.role == "user" ? .trailing : .leading, spacing: 8) {
                if item.role == "user" {
                    UserMessageBubble(text: item.text ?? "")
                } else {
                    MarkdownMessageView(text: item.text ?? "", messageID: item.id)
                }
                if item.truncated { detailsDisclosure(label: "正文已截断，展开已记录内容") }
            }
            .frame(maxWidth: .infinity, alignment: item.role == "user" ? .trailing : .leading)
        } else if item.kind == "toolCall" || item.kind == "toolResult" {
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    expanded.toggle()
                    if expanded { loadDetails() }
                } label: {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: icon)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(item.kind == "toolResult" ? "结果 · " : "")\(item.name ?? "工具") · \(item.statusLabel)")
                                .font(.subheadline.weight(.semibold))
                            if let preview = item.preview {
                                Text(verbatim: preview).font(.caption).lineLimit(2)
                                    .foregroundColor(DesignTokens.Colors.textSecondary)
                            }
                        }
                        Spacer(minLength: 4)
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("tool-\(item.id)")
                .accessibilityLabel("\(item.name ?? "工具")，\(item.statusLabel)，\(expanded ? "收起" : "展开")详情")
                if expanded { detailFields }
            }
            .padding(12)
            .foregroundColor(item.status == "failed" ? DesignTokens.Colors.warning : DesignTokens.Colors.textPrimary)
            .background(DesignTokens.Colors.glassLight)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .onChange(of: item.status) { _, _ in if expanded { loadDetails() } }
        } else if item.kind == "boundary" {
            VStack(alignment: .leading, spacing: 6) {
                Label(item.text ?? "历史边界", systemImage: "text.append")
                    .font(.caption).foregroundColor(DesignTokens.Colors.textSecondary)
                if item.detailId != nil { detailsDisclosure(label: "展开安全摘要") }
            }
        } else {
            Text(item.text ?? "内容未载入").font(.caption).foregroundColor(DesignTokens.Colors.textSecondary)
        }
    }

    private var icon: String {
        switch item.status {
        case "running": return "arrow.triangle.2.circlepath"
        case "succeeded": return "checkmark.circle"
        case "failed": return "exclamationmark.circle"
        case "cancelled": return "stop.circle"
        default: return "wrench.and.screwdriver"
        }
    }

    @ViewBuilder private var detailFields: some View {
        if item.kind == "toolCall" { detailField("arguments", label: "参数") }
        detailField("result", label: item.kind == "message" ? "正文" : "结果")
        if item.status == "failed" { detailField("error", label: "错误") }
    }

    private func detailsDisclosure(label: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(label) {
                expanded.toggle()
                if expanded { loadDetails() }
            }
            .font(.caption).frame(minHeight: 44).tint(DesignTokens.Colors.accentGreen)
            if expanded { detailFields }
        }
    }

    private func loadDetails() {
        if item.kind == "toolCall" { client.loadToolDetail(item, field: "arguments") }
        client.loadToolDetail(item, field: "result")
        if item.status == "failed" { client.loadToolDetail(item, field: "error") }
    }

    @ViewBuilder private func detailField(_ field: String, label: String) -> some View {
        let key = "\(item.id):\(field)"
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.caption.weight(.semibold))
            if let page = client.toolDetails[key] {
                if let error = page.error {
                    Text(error).font(.caption).foregroundColor(DesignTokens.Colors.warning)
                } else if !page.recorded {
                    Text("未记录").font(.caption).foregroundColor(DesignTokens.Colors.textSecondary)
                } else {
                    ScrollView(.horizontal) {
                        Text(verbatim: page.text.isEmpty ? "（空）" : page.text)
                            .font(.caption.monospaced()).textSelection(.enabled)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                    if page.sourceTruncated { Text("原会话已截断，无法读取被删除的内容").font(.caption) }
                    if page.nextCursor != nil {
                        Button("加载更多\(label)") { client.loadToolDetail(item, field: field, more: true) }
                            .frame(minHeight: 44).disabled(client.loadingDetails.contains(key))
                    }
                }
            }
            if client.loadingDetails.contains(key) { ProgressView().accessibilityLabel("正在读取\(label)") }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// 用户消息：右对齐的圆角气泡，回复则保持左侧通栏正文，靠位置区分说话方
struct UserMessageBubble: View {
    let text: String

    var body: some View {
        Text(verbatim: text)
            .font(DesignTokens.Fonts.notoRegular(15))
            .foregroundColor(DesignTokens.Colors.textPrimary)
            .textSelection(.enabled)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(DesignTokens.Colors.glassCard)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .padding(.leading, 48)
            .frame(maxWidth: .infinity, alignment: .trailing)
    }
}
