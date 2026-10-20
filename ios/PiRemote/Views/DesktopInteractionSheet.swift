import SwiftUI

struct DesktopInteractionSheet: View {
    @Bindable var client: RelayClient
    let interaction: DesktopInteraction
    let session: SessionItem?

    @Environment(\.dismiss) private var dismiss
    @State private var drafts: [DesktopQuestionDraft]

    init(client: RelayClient, interaction: DesktopInteraction, session: SessionItem?) {
        self.client = client
        self.interaction = interaction
        self.session = session
        _drafts = State(initialValue: interaction.question?.questions.map { _ in
            DesktopQuestionDraft()
        } ?? [])
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    sourceHeader
                    interactionContent
                }
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 12)
            }
            .background(DesignTokens.Colors.background)
            .navigationTitle(navigationTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                        .disabled(client.isSubmittingDesktopInteraction)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                actionArea
            }
            .tint(DesignTokens.Colors.accentGreen)
        }
        .interactiveDismissDisabled(client.isSubmittingDesktopInteraction)
        .accessibilityIdentifier("desktop-interaction-sheet")
    }

    private var navigationTitle: String {
        switch interaction.kind {
        case .permission: return "权限请求"
        case .question: return "需要你的回答"
        }
    }

    private var sourceHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("来自 Pi Desktop", systemImage: "desktopcomputer")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(DesignTokens.Colors.accentGreen)

            if case .permission(let request) = interaction.kind {
                HStack(spacing: 6) {
                    Text("工具")
                        .font(.caption)
                        .foregroundStyle(DesignTokens.Colors.textSecondary)
                    Text(request.toolName)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(DesignTokens.Colors.textPrimary)
                }
                if let agentName = request.agentName, !agentName.isEmpty {
                    Text("代理：\(agentName)")
                        .font(.caption)
                        .foregroundStyle(DesignTokens.Colors.textSecondary)
                }
            } else if case .question(let request) = interaction.kind {
                Text("问题 · \(request.questions.count) 项")
                    .font(.caption)
                    .foregroundStyle(DesignTokens.Colors.textSecondary)
            }

            Text("会话：\(session?.title ?? interaction.sessionId)")
                .font(.caption)
                .foregroundStyle(DesignTokens.Colors.textSecondary)
                .lineLimit(2)
        }
    }

    @ViewBuilder
    private var interactionContent: some View {
        switch interaction.kind {
        case .permission(let request):
            permissionContent(request)
        case .question(let request):
            questionContent(request)
        }
    }

    private func permissionContent(_ request: DesktopPermissionRequest) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if !request.reason.isEmpty {
                Text(request.reason)
                    .font(.body)
                    .foregroundStyle(DesignTokens.Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let argsPreview = request.argsPreview, !argsPreview.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("请求参数")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(DesignTokens.Colors.textSecondary)
                    Text(argsPreview)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(DesignTokens.Colors.textPrimary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(DesignTokens.Colors.glassLight)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
    }

    private func questionContent(_ request: DesktopQuestionRequest) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(request.questions.enumerated()), id: \.offset) { index, question in
                questionCard(question, at: index, total: request.questions.count)
            }
        }
    }

    private func questionCard(_ question: DesktopQuestion, at index: Int, total: Int) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text("问题 \(index + 1)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(DesignTokens.Colors.textSecondary)
                Text("共 \(total) 题")
                    .font(.caption)
                    .foregroundStyle(DesignTokens.Colors.textSecondary)
                Spacer(minLength: 0)
                if drafts[index].skipped {
                    Text("已跳过")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(DesignTokens.Colors.warning)
                }
            }

            Text(question.question)
                .font(.body)
                .foregroundStyle(DesignTokens.Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            if question.options.isEmpty {
                Text("请直接填写回答。")
                    .font(.footnote)
                    .foregroundStyle(DesignTokens.Colors.textSecondary)
            } else {
                VStack(spacing: 8) {
                    ForEach(Array(question.options.enumerated()), id: \.offset) { optionIndex, option in
                        optionRow(question: question, option: option, questionIndex: index, optionIndex: optionIndex)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(question.options.isEmpty ? "回答" : "其他回答")
                    .font(.caption)
                    .foregroundStyle(DesignTokens.Colors.textSecondary)
                TextField(
                    question.options.isEmpty ? "输入回答" : "其他回答",
                    text: otherBinding(index: index, question: question),
                    axis: .vertical
                )
                .font(.body)
                .lineLimit(1...5)
                .padding(10)
                .background(DesignTokens.Colors.glassLight)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityIdentifier("desktop-question-\(index)-other")
            }
            .disabled(drafts[index].skipped)

            Button(drafts[index].skipped ? "取消跳过" : "跳过本题") {
                drafts[index].skipped.toggle()
            }
            .font(.footnote.weight(.semibold))
            .frame(minHeight: 44)
            .accessibilityIdentifier("desktop-question-\(index)-skip")
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DesignTokens.Colors.glassLight)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func optionRow(
        question: DesktopQuestion,
        option: DesktopQuestionOption,
        questionIndex: Int,
        optionIndex: Int
    ) -> some View {
        let isSelected = drafts[questionIndex].selectedOptionIndices.contains(optionIndex)
        return Button {
            guard !drafts[questionIndex].skipped else { return }
            if question.multiSelect {
                if isSelected {
                    drafts[questionIndex].selectedOptionIndices.remove(optionIndex)
                } else {
                    drafts[questionIndex].selectedOptionIndices.insert(optionIndex)
                }
            } else {
                drafts[questionIndex].selectedOptionIndices = [optionIndex]
                drafts[questionIndex].otherText = ""
            }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: selectionIcon(multiSelect: question.multiSelect, selected: isSelected))
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(isSelected ? DesignTokens.Colors.accentGreen : DesignTokens.Colors.textSecondary)
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 3) {
                    Text(option.label)
                        .font(.body)
                        .foregroundStyle(DesignTokens.Colors.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let description = option.description, !description.isEmpty {
                        Text(description)
                            .font(.footnote)
                            .foregroundStyle(DesignTokens.Colors.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isSelected ? DesignTokens.Colors.accentGreen.opacity(0.12) : DesignTokens.Colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(drafts[questionIndex].skipped)
        .accessibilityIdentifier("desktop-question-\(questionIndex)-option-\(optionIndex)")
    }

    private func selectionIcon(multiSelect: Bool, selected: Bool) -> String {
        if multiSelect {
            return selected ? "checkmark.square.fill" : "square"
        }
        return selected ? "checkmark.circle.fill" : "circle"
    }

    private func otherBinding(index: Int, question: DesktopQuestion) -> Binding<String> {
        Binding(
            get: { drafts[index].otherText },
            set: { value in
                drafts[index].otherText = value
                if !question.multiSelect,
                   !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    drafts[index].selectedOptionIndices.removeAll()
                }
            }
        )
    }

    private var actionArea: some View {
        VStack(alignment: .leading, spacing: 10) {
            statusMessages
            switch interaction.kind {
            case .permission:
                permissionActions
            case .question:
                questionActions
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity)
        .background(.bar)
    }

    @ViewBuilder
    private var statusMessages: some View {
        if client.isSubmittingDesktopInteraction {
            HStack(spacing: 8) {
                ProgressView()
                Text("正在提交…")
                    .font(.footnote)
                    .foregroundStyle(DesignTokens.Colors.textSecondary)
            }
        }

        if let error = client.desktopInteractionError {
            HStack(alignment: .top, spacing: 8) {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(DesignTokens.Colors.warning)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if !client.canRespondDesktopInteraction, !client.isSubmittingDesktopInteraction {
                    Button("重新读取") { client.refreshDesktopControls() }
                        .font(.footnote.weight(.semibold))
                        .frame(minHeight: 44)
                        .disabled(!client.isConnected || !client.agentConnected)
                }
            }
        } else if !client.canRespondDesktopInteraction, !client.isSubmittingDesktopInteraction {
            HStack(alignment: .top, spacing: 8) {
                Text(unavailableHint)
                    .font(.footnote)
                    .foregroundStyle(DesignTokens.Colors.warning)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Button("重新读取") { client.refreshDesktopControls() }
                    .font(.footnote.weight(.semibold))
                    .frame(minHeight: 44)
                    .disabled(!client.isConnected || !client.agentConnected)
            }
        }
    }

    private var unavailableHint: String {
        if !client.isConnected || !client.agentConnected {
            return "连接中断，暂时无法提交回应。"
        }
        return "控制状态尚未确认或当前会话不可控制，暂时无法提交回应。"
    }

    private var permissionActions: some View {
        VStack(spacing: 10) {
            Button {
                client.respondToDesktopPermission(interaction, allow: true)
            } label: {
                Text("允许这一次")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(DesignTokens.Colors.textOnGreen)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 52)
                    .background(DesignTokens.Colors.accentGreen)
                    .clipShape(Capsule())
            }
            .disabled(!client.canRespondDesktopInteraction)
            .accessibilityIdentifier("desktop-allow-once")

            Button {
                client.respondToDesktopPermission(interaction, allow: false)
            } label: {
                Text("不允许")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(DesignTokens.Colors.textPrimary)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 48)
                    .background(DesignTokens.Colors.glassMedium)
                    .clipShape(Capsule())
            }
            .disabled(!client.canRespondDesktopInteraction)
            .accessibilityIdentifier("desktop-deny")
        }
    }

    private var questionActions: some View {
        Button {
            client.respondToDesktopQuestion(interaction, answers: currentAnswers)
        } label: {
            Text("提交回答")
                .font(.body.weight(.semibold))
                .foregroundStyle(DesignTokens.Colors.textOnGreen)
                .frame(maxWidth: .infinity)
                .frame(minHeight: 52)
                .background(canSubmitAnswers ? DesignTokens.Colors.accentGreen : DesignTokens.Colors.textPlaceholder)
                .clipShape(Capsule())
        }
        .disabled(!canSubmitAnswers)
        .accessibilityIdentifier("desktop-submit-answers")
    }

    private var canSubmitAnswers: Bool {
        client.canRespondDesktopInteraction && allQuestionsAnswered
    }

    private var allQuestionsAnswered: Bool {
        guard let request = interaction.question, drafts.count == request.questions.count else { return false }
        return drafts.allSatisfy { draft in
            draft.skipped || !draft.selectedOptionIndices.isEmpty ||
                !draft.otherText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private var currentAnswers: [[String]?] {
        guard let request = interaction.question else { return [] }
        return request.questions.enumerated().map { index, question in
            let draft = drafts[index]
            if draft.skipped { return nil }
            var values = question.options.enumerated()
                .filter { draft.selectedOptionIndices.contains($0.offset) }
                .map { $0.element.label }
            let custom = draft.otherText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !custom.isEmpty { values.append(custom) }
            return values.isEmpty ? nil : values
        }
    }
}

private struct DesktopQuestionDraft {
    var selectedOptionIndices: Set<Int> = []
    var otherText = ""
    var skipped = false
}
