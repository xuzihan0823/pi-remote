import SwiftUI

/// Claude 待处理请求：工具审批（允许一次 / 拒绝）与 AskUserQuestion 提问。
/// 每次（重）连上都会从 /api/interactions/pending 补拉，WS 的 approval / approval.resolved 帧实时增删。
struct ClaudeApprovalSheet: View {
    @Bindable var client: ClaudeClient
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if client.interactions.isEmpty {
                    Text("没有待处理的请求")
                        .foregroundColor(DesignTokens.Colors.textSecondary)
                }
                ForEach(client.interactions) { item in
                    ClaudeInteractionCard(client: client, item: item)
                }
            }
            .navigationTitle("待处理请求")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await client.syncPending() }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
            }
        }
    }
}

private struct ClaudeInteractionCard: View {
    @Bindable var client: ClaudeClient
    let item: ClaudeInteractionItem

    @State private var denyMessage = ""
    @State private var selections: [String: [String]] = [:]
    @State private var freeText: [String: String] = [:]
    @State private var busy = false

    private var interaction: ClaudeInteraction { item.interaction }
    private var disabled: Bool { busy || item.resolved != nil || !client.isConnected }

    var body: some View {
        Section {
            if interaction.kind == .approval {
                approvalBody
            } else {
                questionBody
            }
        } header: {
            HStack {
                Text(sessionLabel)
                Spacer()
                if let resolved = item.resolved {
                    Text(resolvedLabel(resolved))
                        .foregroundColor(resolved == "allowed" || resolved == "answered" ? DesignTokens.Colors.accentGreen : DesignTokens.Colors.warning)
                } else {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(countdown(now: context.date))
                            .monospacedDigit()
                    }
                }
            }
        }
    }

    // MARK: Approval

    @ViewBuilder
    private var approvalBody: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(interaction.toolName.isEmpty ? "工具调用" : interaction.toolName, systemImage: "wrench.and.screwdriver")
                .font(DesignTokens.Fonts.notoBold(14))
            if !interaction.prompt.isEmpty {
                Text(interaction.prompt)
                    .font(DesignTokens.Fonts.notoRegular(13))
                    .textSelection(.enabled)
            }
        }
        if let input = interaction.inputPreview, !input.isEmpty, input != "{\n\n}" {
            ScrollView {
                Text(verbatim: input)
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 220)
        }
        TextField("拒绝理由（可选，会告诉 Claude）", text: $denyMessage)
            .disabled(disabled)
        HStack(spacing: 12) {
            Button(role: .destructive) {
                decide(.deny(message: denyMessage))
            } label: {
                Text("拒绝").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("claude-approval-deny")
            Button {
                decide(.allowOnce)
            } label: {
                Text("允许一次").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(DesignTokens.Colors.accentGreen)
            .accessibilityIdentifier("claude-approval-allow")
        }
        .disabled(disabled)
    }

    // MARK: Question

    @ViewBuilder
    private var questionBody: some View {
        ForEach(interaction.questions, id: \.question) { question in
            VStack(alignment: .leading, spacing: 8) {
                if !question.header.isEmpty {
                    Text(question.header)
                        .font(DesignTokens.Fonts.notoRegular(11))
                        .foregroundColor(DesignTokens.Colors.textSecondary)
                }
                Text(question.question)
                    .font(DesignTokens.Fonts.notoBold(14))
                ForEach(question.options, id: \.label) { option in
                    Button {
                        toggle(option.label, in: question)
                    } label: {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: isSelected(option.label, in: question)
                                  ? (question.multiSelect ? "checkmark.square.fill" : "largecircle.fill.circle")
                                  : (question.multiSelect ? "square" : "circle"))
                                .foregroundColor(DesignTokens.Colors.accentGreen)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.label)
                                    .foregroundColor(DesignTokens.Colors.textPrimary)
                                if !option.description.isEmpty {
                                    Text(option.description)
                                        .font(DesignTokens.Fonts.notoRegular(11))
                                        .foregroundColor(DesignTokens.Colors.textSecondary)
                                }
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(disabled)
                }
                TextField("或者直接输入回答", text: Binding(
                    get: { freeText[question.question] ?? "" },
                    set: { freeText[question.question] = $0 }
                ))
                .disabled(disabled)
            }
            .padding(.vertical, 4)
        }
        HStack(spacing: 12) {
            Button(role: .destructive) {
                decide(.deny(message: nil))
            } label: {
                Text("不回答").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            Button {
                if let answers = ClaudeDecision.answers(for: interaction.questions, selections: selections, freeText: freeText) {
                    decide(.answer(answers))
                }
            } label: {
                Text("提交回答").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(DesignTokens.Colors.accentGreen)
            .disabled(ClaudeDecision.answers(for: interaction.questions, selections: selections, freeText: freeText) == nil)
            .accessibilityIdentifier("claude-question-submit")
        }
        .disabled(disabled)
    }

    private func isSelected(_ label: String, in question: ClaudeQuestion) -> Bool {
        selections[question.question]?.contains(label) == true
    }

    private func toggle(_ label: String, in question: ClaudeQuestion) {
        var picked = selections[question.question] ?? []
        if question.multiSelect {
            if let index = picked.firstIndex(of: label) { picked.remove(at: index) } else { picked.append(label) }
        } else {
            picked = picked == [label] ? [] : [label]
        }
        selections[question.question] = picked
    }

    // MARK: Helpers

    private func decide(_ decision: ClaudeDecision) {
        guard !disabled else { return }
        busy = true
        Task {
            await client.decide(item, decision)
            busy = false
        }
    }

    private var sessionLabel: String {
        if let session = client.sessions.first(where: { $0.id == interaction.sessionId }) {
            return session.title.count > 24 ? String(session.title.prefix(24)) + "…" : session.title
        }
        return "会话 \(interaction.sessionId.prefix(8))"
    }

    private func resolvedLabel(_ status: String) -> String {
        switch status {
        case "allowed": return "已允许"
        case "denied": return "已拒绝"
        case "answered": return "已回答"
        case "expired": return "已超时"
        default: return "已处理"
        }
    }

    private func countdown(now: Date) -> String {
        let left = max(0, Int(interaction.expiresAt.timeIntervalSince(now)))
        guard interaction.expiresAt != .distantFuture else { return "" }
        return String(format: "剩余 %d:%02d", left / 60, left % 60)
    }
}
