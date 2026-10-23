import SwiftUI

/// Claude 会话页：转录分页（向上加载更早）、末尾流式草稿、运行状态、停止 / 解除占用、run 报错提示、搜索命中高亮。
struct ClaudeConversationView: View {
    @Bindable var client: ClaudeClient
    var onShowApprovals: () -> Void = {}

    @State private var inputText = ""
    @State private var followsBottom = true
    @State private var highlightedId: String?
    @State private var loadingOlderAnchor: String?
    @FocusState private var inputFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        header

                        if client.transcript.hasMore {
                            Button(client.isLoadingOlder ? "正在加载…" : "加载更早的消息") {
                                followsBottom = false
                                loadingOlderAnchor = client.transcript.messages.first?.id
                                Task {
                                    await client.loadOlder()
                                    if let anchor = loadingOlderAnchor {
                                        proxy.scrollTo(anchor, anchor: .top)
                                    }
                                    loadingOlderAnchor = nil
                                }
                            }
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .disabled(client.isLoadingOlder)
                            .accessibilityIdentifier("claude-load-older")
                        }

                        if client.isLoadingTranscript && client.transcript.isEmpty {
                            ProgressView().frame(maxWidth: .infinity)
                        }
                        if let error = client.transcriptError, client.transcript.isEmpty {
                            notice(error, color: DesignTokens.Colors.warning)
                        }

                        ForEach(client.transcript.messages) { message in
                            ClaudeMessageRow(message: message)
                                .padding(6)
                                .background(
                                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                                        .fill(highlightedId == message.id ? DesignTokens.Colors.accentGreen.opacity(0.14) : Color.clear)
                                )
                                .id(message.id)
                        }

                        if let pending = client.pendingUserText {
                            UserMessageBubble(text: pending)
                                .opacity(0.6)
                                .accessibilityLabel("正在发送：\(pending)")
                        }

                        ForEach(client.drafts) { draft in
                            MarkdownMessageView(text: draft.text, messageID: "draft-\(draft.key)")
                                .padding(.horizontal, 6)
                                .id("draft-\(draft.key)")
                        }

                        if client.isRunning && !client.drafts.contains(where: { !$0.done }) {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text("Claude 正在工作…")
                                    .font(DesignTokens.Fonts.notoRegular(12))
                                    .foregroundColor(DesignTokens.Colors.textSecondary)
                            }
                            .padding(.horizontal, 6)
                        }

                        if let error = client.runError {
                            runErrorCard(error)
                        }

                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 14)
                    .padding(.top, 8)
                    .padding(.bottom, 16)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: client.transcript.messages.last?.id) { _, _ in follow(proxy) }
                .onChange(of: client.drafts) { _, _ in follow(proxy) }
                .onChange(of: client.pendingUserText) { _, _ in follow(proxy) }
                .onChange(of: client.runError) { _, _ in follow(proxy) }
                .onChange(of: client.focus) { _, focus in
                    guard let focus else { return }
                    followsBottom = false
                    highlightedId = focus.messageId
                    DispatchQueue.main.async {
                        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.25)) {
                            proxy.scrollTo(focus.messageId, anchor: .center)
                        }
                    }
                    Task {
                        try? await Task.sleep(nanoseconds: 2_500_000_000)
                        if highlightedId == focus.messageId { highlightedId = nil }
                    }
                }
                .onAppear { if client.focus == nil { proxy.scrollTo("bottom", anchor: .bottom) } }
            }

            banners
            composer
        }
        .background(DesignTokens.Colors.background.ignoresSafeArea())
        .navigationTitle(client.activeSession?.title ?? "会话")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("刷新") {
                        Task { await client.refreshSessions() }
                    }
                    if client.isRunning || client.activeStatus == .terminalDriving {
                        Button(client.isTerminalDriving ? "解除终端占用" : "停止运行", role: .destructive) {
                            Task { await client.stopOrRelease() }
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
    }

    // MARK: Pieces

    private var header: some View {
        HStack(spacing: 8) {
            if let session = client.activeSession {
                Text(projectLabel(session))
                    .font(DesignTokens.Fonts.notoRegular(12))
                    .foregroundColor(DesignTokens.Colors.textSecondary)
                    .lineLimit(1)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Capsule().fill(DesignTokens.Colors.glassMedium))
            }
            Spacer()
            ClaudeStatusBadge(status: client.activeStatus)
        }
    }

    private func projectLabel(_ session: ClaudeSessionSummary) -> String {
        if let project = client.catalog.project(forCwd: session.cwd) { return client.catalog.title(for: project) }
        return session.cwd.isEmpty ? "未归类" : ClaudeProjectCatalog.shortPath(session.cwd)
    }

    private func runErrorCard(_ error: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(DesignTokens.Colors.warning)
            VStack(alignment: .leading, spacing: 4) {
                Text("运行出错")
                    .font(DesignTokens.Fonts.notoBold(13))
                Text(error)
                    .font(DesignTokens.Fonts.notoRegular(12))
                    .textSelection(.enabled)
            }
            .foregroundColor(DesignTokens.Colors.textPrimary)
            Spacer(minLength: 0)
            Button {
                client.dismissRunError()
            } label: {
                Image(systemName: "xmark").font(.system(size: 12, weight: .semibold))
            }
            .accessibilityLabel("关闭错误提示")
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(DesignTokens.Colors.warning.opacity(0.12)))
        .accessibilityIdentifier("claude-run-error")
    }

    @ViewBuilder
    private var banners: some View {
        let pendingHere = client.unresolvedInteractions.filter { $0.interaction.sessionId == client.activeSessionId }
        if !pendingHere.isEmpty {
            Button(action: onShowApprovals) {
                Label("此会话有 \(pendingHere.count) 个请求等待处理", systemImage: "hand.raised.fill")
                    .font(DesignTokens.Fonts.notoBold(13))
                    .foregroundColor(DesignTokens.Colors.warning)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .glassCapsule()
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 6)
        }
        if client.isTerminalDriving {
            HStack(spacing: 10) {
                Image(systemName: "terminal")
                Text("Mac 终端里的 Claude 正在使用此会话，手机暂不能发送。若终端已退出，可解除占用。")
                    .font(DesignTokens.Fonts.notoRegular(12))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Button(client.isStopping ? "处理中…" : "解除占用") {
                    Task { await client.stopOrRelease() }
                }
                .font(DesignTokens.Fonts.notoBold(12))
                .disabled(client.isStopping || !client.isConnected)
                .accessibilityIdentifier("claude-release")
            }
            .foregroundColor(DesignTokens.Colors.textPrimary)
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(DesignTokens.Colors.glassLight))
            .padding(.horizontal, 16)
            .padding(.bottom, 6)
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField(placeholder, text: $inputText, axis: .vertical)
                .font(DesignTokens.Fonts.notoRegular(15))
                .lineLimit(1...5)
                .focused($inputFocused)
                .disabled(!client.isConnected || client.isTerminalDriving)
                .accessibilityIdentifier("claude-input")
                .padding(.horizontal, 6)
                .frame(minHeight: 36)

            if client.isRunning {
                Button {
                    Task { await client.stopOrRelease() }
                } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(DesignTokens.Colors.textOnGreen)
                        .frame(width: 40, height: 40)
                        .background(DesignTokens.Colors.darkButton)
                        .clipShape(Circle())
                }
                .disabled(client.isStopping || !client.isConnected)
                .accessibilityLabel("停止运行")
                .accessibilityIdentifier("claude-stop")
            } else {
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundColor(DesignTokens.Colors.textOnGreen)
                        .frame(width: 40, height: 40)
                        .background(canSend ? DesignTokens.Colors.darkButton : DesignTokens.Colors.textPlaceholder)
                        .clipShape(Circle())
                }
                .disabled(!canSend)
                .accessibilityLabel("发送消息")
                .accessibilityIdentifier("claude-send")
            }
        }
        .padding(12)
        .glassCard(cornerRadius: 24)
        .padding(.horizontal, 16)
        .padding(.bottom, 12)
    }

    private var placeholder: String {
        if !client.isConnected { return "未连接" }
        if client.isTerminalDriving { return "终端正在使用此会话" }
        if client.isRunning { return "Claude 正在运行…" }
        return "继续对话…"
    }

    private var canSend: Bool {
        client.canSend && !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        let text = inputText
        guard canSend else { return }
        followsBottom = true
        Task {
            if await client.sendMessage(text), inputText == text { inputText = "" }
        }
    }

    private func follow(_ proxy: ScrollViewProxy) {
        guard followsBottom, loadingOlderAnchor == nil else { return }
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) {
            proxy.scrollTo("bottom", anchor: .bottom)
        }
    }

    private func notice(_ text: String, color: Color) -> some View {
        Text(text)
            .font(DesignTokens.Fonts.notoRegular(12))
            .foregroundColor(color)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// 单条转录消息：用户文本气泡、助手 Markdown、思考与工具调用折叠展示。
struct ClaudeMessageRow: View {
    let message: ClaudeMessage

    var body: some View {
        switch message.kind {
        case .text:
            if message.isUser {
                UserMessageBubble(text: message.text ?? "")
            } else {
                MarkdownMessageView(text: message.text ?? "", messageID: "claude-\(message.id)")
            }
        case .thinking:
            DisclosureGroup {
                Text(verbatim: message.text ?? "")
                    .font(DesignTokens.Fonts.notoRegular(12))
                    .foregroundColor(DesignTokens.Colors.textSecondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } label: {
                Label("思考", systemImage: "brain")
                    .font(DesignTokens.Fonts.notoRegular(12))
                    .foregroundColor(DesignTokens.Colors.textSecondary)
            }
        case .toolUse:
            DisclosureGroup {
                if let input = message.toolInputPreview {
                    ScrollView(.horizontal) {
                        Text(verbatim: input)
                            .font(.system(size: 11, design: .monospaced))
                            .textSelection(.enabled)
                    }
                }
            } label: {
                Label(message.toolName ?? "工具", systemImage: "wrench.and.screwdriver")
                    .font(DesignTokens.Fonts.notoRegular(12))
                    .foregroundColor(DesignTokens.Colors.textSecondary)
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(DesignTokens.Colors.glassLight))
        case .toolResult:
            DisclosureGroup {
                Text(verbatim: String((message.text ?? "").prefix(6000)))
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } label: {
                Label(message.isError ? "工具出错" : "工具结果",
                      systemImage: message.isError ? "exclamationmark.triangle" : "checkmark.circle")
                    .font(DesignTokens.Fonts.notoRegular(12))
                    .foregroundColor(message.isError ? DesignTokens.Colors.warning : DesignTokens.Colors.textSecondary)
            }
            .padding(.horizontal, 10)
        case .meta, .other:
            if let text = message.text, !text.isEmpty {
                Text(verbatim: text.count > 300 ? String(text.prefix(300)) + "…" : text)
                    .font(DesignTokens.Fonts.notoRegular(11))
                    .foregroundColor(DesignTokens.Colors.textPlaceholder)
                    .lineLimit(4)
            }
        }
    }
}
