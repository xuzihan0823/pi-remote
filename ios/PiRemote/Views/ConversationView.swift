import SwiftUI

public struct ConversationView: View {
    @Bindable var client: RelayClient
    public var session: SessionItem?
    public var onSidebarTapped: () -> Void = {}

    @State private var inputText = ""
    @State private var showMenu = false
    @State private var scrollPosition = ScrollPosition(idType: String.self)
    @State private var followsBottom = true
    @State private var hasNewMessages = false
    @State private var didOpenLatest = false
    @State private var userIsScrolling = false
    @State private var scrollOffset: CGFloat = 0
    @State private var pendingPageAnchor: (id: String, y: CGFloat, height: CGFloat)?
    @State private var readingAnchor: (id: String, y: CGFloat)?
    @State private var visibleRows: [String: CGRect] = [:]
    @State private var viewportHeight: CGFloat = 0
    @State private var branchOffsets: [String: CGFloat] = [:]
    @State private var pendingBranchOffset: CGFloat?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        client: RelayClient,
        session: SessionItem? = nil,
        onSidebarTapped: @escaping () -> Void = {}
    ) {
        self.client = client
        self.session = session
        self.onSidebarTapped = onSidebarTapped
    }

    public var body: some View {
        ZStack {
            DesignTokens.Colors.background
                .ignoresSafeArea()

            VStack(spacing: 0) {
                navigationBar

                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 14) {
                            if let project = client.activeProject {
                                projectPill(project)
                            }

                            if client.isActiveArchive {
                                historyControls
                            }
                            if client.terminal.hasMoreBefore {
                                Button(client.isLoadingEarlier ? "正在加载…" : "加载更早的消息") {
                                    readingAnchor = nil
                                    if let row = visibleRows.filter({ $0.value.minY >= 0 }).min(by: { $0.value.minY < $1.value.minY }) {
                                        pendingPageAnchor = (row.key, row.value.minY, row.value.height)
                                    }
                                    client.loadEarlier { inserted in
                                        if inserted, let anchor = pendingPageAnchor {
                                            let alignment = anchor.y / max(1, viewportHeight - anchor.height)
                                            DispatchQueue.main.async {
                                                proxy.scrollTo(anchor.id, anchor: UnitPoint(x: 0.5, y: alignment))
                                            }
                                        }
                                        pendingPageAnchor = nil
                                    }
                                }
                                .frame(minHeight: 44)
                                .disabled(client.isLoadingEarlier)
                                .accessibilityIdentifier("load-earlier")
                            }
                            if client.usesSessionTimeline {
                                terminalContent
                            } else {
                                managedContent
                            }

                            if let notice = client.lastNotice {
                                noticeLine(notice)
                            }

                            if let error = client.lastError {
                                noticeLine(error, color: DesignTokens.Colors.warning)
                            }

                            if let session, session.state == .failed, let error = session.error {
                                noticeLine(error, color: DesignTokens.Colors.warning)
                            }

                            Color.clear.frame(height: 1).id("bottom")
                        }
                        .scrollTargetLayout()
                        .padding(.horizontal, 20)
                        .padding(.top, 12)
                        .padding(.bottom, 24)
                    }
                    .scrollPosition($scrollPosition)
                    .coordinateSpace(name: "conversationViewport")
                    .onPreferenceChange(ConversationRowFrames.self) { frames in
                        visibleRows = frames.filter { $0.value.maxY > 0 && $0.value.minY < viewportHeight }
                        if !followsBottom, !userIsScrolling, pendingPageAnchor == nil,
                           let anchor = readingAnchor, let frame = frames[anchor.id],
                           abs(frame.minY - anchor.y) > 0.5 {
                            let alignment = anchor.y / max(1, viewportHeight - frame.height)
                            DispatchQueue.main.async {
                                guard !userIsScrolling, readingAnchor?.id == anchor.id else { return }
                                proxy.scrollTo(anchor.id, anchor: UnitPoint(x: 0.5, y: alignment))
                            }
                        }
                    }
                    .onScrollPhaseChange { _, phase in
                        userIsScrolling = phase == .interacting || phase == .decelerating
                        if userIsScrolling {
                            readingAnchor = nil
                        } else if phase == .idle, !followsBottom, readingAnchor == nil,
                                  let row = visibleRows.filter({ $0.value.minY >= 0 }).min(by: { $0.value.minY < $1.value.minY }) {
                            readingAnchor = (row.key, row.value.minY)
                        }
                    }
                    .onScrollGeometryChange(for: ConversationScrollMetrics.self) { geometry in
                        ConversationScrollMetrics(offset: geometry.contentOffset.y, height: geometry.contentSize.height,
                            viewport: geometry.containerSize.height, bottomInset: geometry.contentInsets.bottom)
                    } action: { old, new in
                        scrollOffset = new.offset
                        viewportHeight = new.viewport
                        if userIsScrolling {
                            followsBottom = new.height - new.offset - new.viewport + new.bottomInset <= 80
                            if followsBottom { hasNewMessages = false }
                        }
                    }
                    .onChange(of: client.streamingText) { _, _ in followOutput(proxy) }
                    .onChange(of: client.steps.count) { _, _ in followOutput(proxy) }
                    .onChange(of: client.terminal.messages) { _, _ in followOutput(proxy) }
                    .onChange(of: client.terminal.items) { old, new in
                        guard pendingPageAnchor == nil, !client.isLoadingEarlier else { return }
                        if new.count > old.count && Array(new.suffix(old.count)) == old { return }
                        followOutput(proxy)
                    }
                    .onChange(of: client.terminal.loaded, initial: true) { _, loaded in
                        if loaded, !didOpenLatest {
                            didOpenLatest = true
                            if let offset = pendingBranchOffset {
                                scrollPosition.scrollTo(y: offset)
                                pendingBranchOffset = nil
                            } else {
                                scrollToBottom(proxy)
                            }
                        }
                    }
                    .overlay(alignment: .bottomTrailing) {
                        if hasNewMessages || !followsBottom {
                            Button(hasNewMessages ? "有新消息 · 回到底部" : "回到底部") {
                                followsBottom = true
                                hasNewMessages = false
                                scrollToBottom(proxy)
                            }
                            .font(.caption.weight(.semibold))
                            .frame(minHeight: 44)
                            .padding(.horizontal, 12)
                            .background(DesignTokens.Colors.glassMedium)
                            .clipShape(Capsule())
                            .padding(12)
                            .accessibilityIdentifier("back-to-bottom")
                        }
                    }
                }

                inputBar
            }
        }
        .sheet(item: client.pendingApprovalBinding) { request in
            ApprovalSheet(client: client, request: request)
                .presentationDetents([.height(460)])
                .presentationDragIndicator(.hidden)
        }
        .onAppear {
            subscribeIfNeeded()
            if let draft = client.pendingDraft {
                inputText = draft
                client.pendingDraft = nil
            }
        }
        .onDisappear {
            client.cancelSessionCreation()
            client.stopTerminalPolling()
        }
        .onChange(of: client.isConnected) { _, _ in subscribeIfNeeded() }
        .onChange(of: client.activeSessionId) { _, _ in
            didOpenLatest = false
            followsBottom = true
            hasNewMessages = false
            pendingPageAnchor = nil
            readingAnchor = nil
        }
    }

    private func subscribeIfNeeded() {
        guard let session, client.isConnected else { return }
        if client.activeSessionId != session.id {
            client.openSession(session)
        } else if client.usesSessionTimeline && !client.isActiveArchive {
            client.startTerminalPolling()
        }
    }

    @ViewBuilder
    private var managedContent: some View {
        if let message = client.lastUserMessage {
            userMessage(message)
        }

        if hasAgentOutput {
            agentBlock
        }
    }

    @ViewBuilder
    private var terminalContent: some View {
        if let session, client.isActiveTerminal, !client.isActiveArchive, !session.subagentModelIsolation {
            noticeLine("旧终端尚未启用子 agent 模型隔离；需要隔离时，请通过 Mac 助手启动受控 OMP。", color: DesignTokens.Colors.warning)
        }
        if let error = client.terminal.error {
            noticeLine(error, color: DesignTokens.Colors.warning)
        }

        if client.terminal.messages.isEmpty, client.terminal.items.isEmpty, client.terminal.error == nil {
            Text(client.isActiveArchive ? (client.terminal.loaded ? "尚无可显示的历史正文" : "正在读取历史会话…") :
                 (terminalOffline ? "会话暂时离线" :
                 (!client.terminal.loaded ? "正在读取会话…" :
                  (client.terminal.isBusy ? "正在运行，等待输出…" : "会话已就绪，发送消息开始。"))))
                .font(DesignTokens.Fonts.notoRegular(13))
                .foregroundColor(DesignTokens.Colors.textSecondary)
        }

        ForEach(client.terminal.messages) { message in
            Group {
                if message.role == "user" {
                    userMessage(message.text)
                } else {
                    terminalAssistantMessage(message.text)
                }
            }
            .id(message.id)
        }

        ForEach(client.terminal.items) { item in
            TimelineItemView(item: item, client: client).id(item.id)
                .background(GeometryReader { geometry in
                    Color.clear.preference(key: ConversationRowFrames.self,
                        value: [item.id: geometry.frame(in: .named("conversationViewport"))])
                })
        }
        ForEach(client.terminal.warnings, id: \.self) { warning in
            noticeLine(warning, color: DesignTokens.Colors.warning)
        }

        if client.terminal.truncated {
            noticeLine(client.terminal.usesTimeline ? "部分正文已截断，可展开读取已记录内容" : "仅显示最近部分消息；历史和工具详情需升级 Mac 助手与扩展")
        }
    }

    private var historyControls: some View {
        HStack {
            Label("历史记录 · 最后记录分支", systemImage: "clock")
                .font(.caption).foregroundColor(DesignTokens.Colors.textSecondary)
            Spacer()
            if client.branches.count > 1 {
                Menu("分支") {
                    ForEach(client.branches) { branch in
                        Button(branch.title) {
                            didOpenLatest = false
                            followsBottom = true
                            readingAnchor = nil
                            if let current = client.terminal.branchId { branchOffsets[current] = scrollOffset }
                            pendingBranchOffset = branchOffsets[branch.id]
                            client.selectBranch(branch)
                        }
                        .disabled(branch.damaged)
                    }
                }
                .frame(minHeight: 44)
            }
            Button("刷新") {
                didOpenLatest = false
                readingAnchor = nil
                client.refreshHistory()
            }
            .frame(minHeight: 44)
        }
    }

    private var hasAgentOutput: Bool {
        !client.streamingText.isEmpty || !client.steps.isEmpty || !client.modifiedFiles.isEmpty
    }

    private var navigationBar: some View {
        HStack(spacing: 12) {
            Button(action: onSidebarTapped) {
                Image(systemName: "sidebar.left")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(DesignTokens.Colors.textPrimary)
                    .frame(width: 44, height: 44)
                    .glassCircle()
            }
            .accessibilityLabel("会话列表")
            .accessibilityIdentifier("open-sidebar")

            Spacer(minLength: 0)

            VStack(spacing: 2) {
                Text(session?.title ?? "会话")
                    .font(DesignTokens.Fonts.notoBold(16))
                    .foregroundColor(DesignTokens.Colors.textPrimary)
                    .lineLimit(1)
                Text("\(client.agentName ?? "MacBook Pro") · \(client.agentConnected ? "在线" : "离线")")
                    .font(DesignTokens.Fonts.notoRegular(11))
                    .foregroundColor(DesignTokens.Colors.textSecondary)
            }

            Spacer(minLength: 0)

            Button(action: { showMenu = true }) {
                Image(systemName: "ellipsis")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(DesignTokens.Colors.textPrimary)
                    .frame(width: 44, height: 44)
                    .glassCircle()
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 8)
        .confirmationDialog("会话操作", isPresented: $showMenu, titleVisibility: .hidden) {
            Button("中止任务", role: .destructive) {
                client.abortActiveSession()
            }
            .disabled(!client.canAbortSession)

            Button("复制会话 ID") {
                UIPasteboard.general.string = client.activeSessionId
            }

            Button("取消", role: .cancel) {}
        }
    }

    private func projectPill(_ project: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "folder")
                .font(.system(size: 10))
                .foregroundColor(DesignTokens.Colors.textSecondary)
            Text(project)
                .font(DesignTokens.Fonts.sfProRegular(12))
                .foregroundColor(DesignTokens.Colors.textSecondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .frame(height: 26)
        .background(DesignTokens.Colors.glassMediumAlt)
        .clipShape(Capsule())
    }

    private func userMessage(_ message: String) -> some View {
        UserMessageBubble(text: message)
            .padding(.top, 6)
    }

    private func terminalAssistantMessage(_ text: String) -> some View {
        MarkdownMessageView(text: text)
            .font(DesignTokens.Fonts.notoRegular(14))
            .foregroundColor(DesignTokens.Colors.textPrimary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
    }

    private var agentBlock: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(statusLine)
                .font(DesignTokens.Fonts.notoRegular(11))
                .foregroundColor(DesignTokens.Colors.textSecondary)

            if !client.streamingText.isEmpty {
                MarkdownMessageView(text: client.streamingText, baseFontSize: client.sessionSettled ? 14 : 15)
                    .font(DesignTokens.Fonts.notoRegular(client.sessionSettled ? 14 : 15))
                    .foregroundColor(DesignTokens.Colors.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }

            if !client.steps.isEmpty {
                stepsCard
            }

            if !client.modifiedFiles.isEmpty {
                filesCard
            }
        }
    }

    private var stepsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("执行过程")
                    .font(DesignTokens.Fonts.notoRegular(13))
                    .foregroundColor(DesignTokens.Colors.textPrimary)
                Spacer()
                Text("\(client.steps.count) 步")
                    .font(DesignTokens.Fonts.notoRegular(11))
                    .foregroundColor(DesignTokens.Colors.textSecondary)
            }

            VStack(alignment: .leading, spacing: 6) {
                ForEach(client.steps) { step in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: step.isError ? "exclamationmark.triangle" : (step.isRunning ? "arrow.triangle.2.circlepath" : "checkmark"))
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(step.isError ? DesignTokens.Colors.warning : (step.isRunning ? DesignTokens.Colors.accentGreen : DesignTokens.Colors.textSecondary))
                            .frame(width: 12)
                        Text(step.title)
                            .font(DesignTokens.Fonts.sfProRegular(12))
                            .foregroundColor(step.isRunning ? DesignTokens.Colors.accentGreen : DesignTokens.Colors.textSecondary)
                            .lineLimit(2)
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DesignTokens.Colors.glassLight)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var filesCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(client.sessionSettled ? "本次改动" : "\(client.modifiedFiles.count) 个文件已修改")
                    .font(DesignTokens.Fonts.notoBold(client.sessionSettled ? 14 : 13))
                    .foregroundColor(DesignTokens.Colors.textPrimary)
                Spacer()
            }

            ForEach(client.modifiedFiles, id: \.self) { path in
                Text(path)
                    .font(DesignTokens.Fonts.sfProRegular(12))
                    .foregroundColor(DesignTokens.Colors.textPrimary)
                    .lineLimit(1)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DesignTokens.Colors.surface)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func noticeLine(_ text: String, color: Color = DesignTokens.Colors.textSecondary) -> some View {
        Text(text)
            .font(DesignTokens.Fonts.sfProRegular(11))
            .foregroundColor(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .lineLimit(3)
    }

    private var statusLine: String {
        let elapsed = elapsedText
        if client.sessionSettled {
            return elapsed.isEmpty ? "已完成" : "已完成 · \(elapsed)"
        }
        if client.isThinking {
            return elapsed.isEmpty ? "思考中" : "已思考 \(elapsed)"
        }
        return "处理中"
    }

    private var elapsedText: String {
        guard let start = client.thinkingStartedAt ?? client.turnStartedAt else { return "" }
        let end = client.turnFinishedAt ?? Date()
        let seconds = max(0, Int(end.timeIntervalSince(start).rounded()))
        if seconds < 60 { return "\(seconds) 秒" }
        let minutes = seconds / 60
        let rest = seconds % 60
        return rest == 0 ? "\(minutes) 分钟" : "\(minutes) 分 \(rest) 秒"
    }

    private var inputBar: some View {
        VStack(spacing: 8) {
            if let reconnectSeconds = client.reconnectSeconds {
                Text("连接中断，\(reconnectSeconds) 秒后重连")
                    .font(DesignTokens.Fonts.notoRegular(11))
                    .foregroundColor(DesignTokens.Colors.warning)
            }

            if client.isResumingHistory || client.isPreparingHistoryPrompt {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(client.isResumingHistory ? client.historyRecoveryStageTitle : "正在确认会话和模型…")
                        .font(.caption)
                }
                .foregroundColor(DesignTokens.Colors.textSecondary)
            }
            if client.isActiveArchive {
                Text(client.supportsHistoryResume ? "发送消息时自动续接原会话" : "请更新 Mac 助手并选择 OMP，以继续历史会话")
                    .font(.caption)
                    .foregroundColor(DesignTokens.Colors.textSecondary)
            }
            if let message = client.historyRecoveryMessage, client.isActiveArchive {
                Label(message, systemImage: "exclamationmark.circle")
                    .font(.caption)
                    .foregroundColor(DesignTokens.Colors.warning)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("history-recovery-message")
            }
            if terminalOffline {
                Text("会话离线，暂时无法继续操作")
                    .font(DesignTokens.Fonts.notoRegular(11))
                    .foregroundColor(DesignTokens.Colors.warning)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if client.supportsModelSelection && client.isSessionRunning {
                Text("当前任务运行中，完成后即可切换模型")
                    .font(DesignTokens.Fonts.notoRegular(11))
                    .foregroundColor(DesignTokens.Colors.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let error = client.activeModelLoadError {
                HStack(alignment: .top) {
                    Text(error)
                        .font(DesignTokens.Fonts.notoRegular(11))
                        .foregroundColor(DesignTokens.Colors.warning)
                    Spacer(minLength: 8)
                    Button("重试") { client.refreshActiveModels() }
                        .font(DesignTokens.Fonts.notoBold(12))
                        .disabled(client.isLoadingActiveModels || client.isSwitchingModel || !client.isConnected)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                TextField(placeholder, text: $inputText, axis: .vertical)
                    .font(DesignTokens.Fonts.notoRegular(14))
                    .foregroundColor(DesignTokens.Colors.textPrimary)
                    .lineLimit(1...4)
                    .disabled(client.isActiveArchive ? !client.isConnected : (!client.isConnected || terminalOffline || !client.activeCanControl))
                    .accessibilityIdentifier("conversation-input")
                    .padding(.horizontal, 6)
                    .frame(minHeight: 32)

                HStack(spacing: 10) {
                    Spacer(minLength: 0)

                    if client.isActiveArchive && client.supportsModelCatalog {
                        ModelMenu(
                            models: client.activeModels,
                            selected: client.historyResumeModel,
                            isLoading: client.isLoadingActiveModels,
                            defaultTitle: "沿用历史模型",
                            onSelect: { client.selectHistoryResumeModel($0) }
                        )
                        .disabled(!client.canSelectHistoryModel)
                        .accessibilityIdentifier("history-resume-model")
                    }
                    if !client.isActiveArchive && client.supportsModelSelection {
                        ModelMenu(
                            models: client.activeModels,
                            selected: client.activeModel,
                            isLoading: client.isSwitchingModel || client.isLoadingActiveModels,
                            defaultTitle: client.activeModelLoadError == nil ? "当前模型" : "读取失败",
                            onSelect: { model in
                                if let model { client.setActiveModel(model) }
                            }
                        )
                        .disabled(!client.canSelectActiveModel)
                    }

                    if client.isSessionRunning {
                        Button(action: { client.abortActiveSession() }) {
                            Image(systemName: "stop.fill")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundColor(DesignTokens.Colors.textOnGreen)
                                .frame(width: 40, height: 40)
                                .background(DesignTokens.Colors.darkButton)
                                .clipShape(Circle())
                        }
                        .disabled(!client.canAbortSession)
                        .accessibilityLabel("停止任务")
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
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
            .glassCard(cornerRadius: 24)

            HStack(spacing: 4) {
                Image(systemName: "paperclip")
                    .font(.system(size: 10))
                Text(client.isActiveTerminal && !client.isActiveArchive ? "确认和选择请在 Mac 终端完成" : "在你的 Mac 上执行")
                    .font(DesignTokens.Fonts.notoRegular(11))
            }
            .foregroundColor(DesignTokens.Colors.textSecondary)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 12)
    }

    private var placeholder: String {
        if client.isActiveArchive { return "继续输入…" }
        if client.usesSessionTimeline {
            if terminalOffline { return "会话离线，无法发送" }
            if client.terminal.isBusy { return "正在运行，请等待完成…" }
            return client.terminal.loaded ? "继续输入…" : "正在读取会话状态…"
        }
        return client.sessionSettled ? "描述你想完成的工作…" : "补充要求，或开始下一步…"
    }
    private var terminalOffline: Bool {
        !client.isActiveArchive && client.usesSessionTimeline && (!client.isConnected || !client.agentConnected || client.terminal.isOffline)
    }

    private var canSend: Bool {
        !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && client.canSubmitPrompt
    }

    private func send() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend else { return }
        let draft = inputText
        followsBottom = true
        client.sendPrompt(text) { result in
            if case .success = result, inputText == draft { inputText = "" }
        }
    }

    private func followOutput(_ proxy: ScrollViewProxy) {
        guard pendingPageAnchor == nil, !client.isLoadingEarlier else { return }
        if followsBottom {
            scrollToBottom(proxy)
        } else {
            hasNewMessages = true
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        readingAnchor = nil
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) {
            proxy.scrollTo("bottom", anchor: .bottom)
        }
    }
}

private struct ConversationScrollMetrics: Equatable {
    var offset: CGFloat
    var height: CGFloat
    var viewport: CGFloat
    var bottomInset: CGFloat
}

struct ApprovalSheet: View {
    @Bindable var client: RelayClient
    let request: ApprovalRequest
    @State private var responseText = ""

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 4) {
                Text("需要你的确认")
                    .font(DesignTokens.Fonts.notoBold(20))
                    .foregroundColor(DesignTokens.Colors.textPrimary)
                Text("来自 pi · 当前会话")
                    .font(DesignTokens.Fonts.notoRegular(11))
                    .foregroundColor(DesignTokens.Colors.textSecondary)
            }
            .padding(.top, 26)

            VStack(alignment: .leading, spacing: 8) {
                Text(request.title)
                    .font(DesignTokens.Fonts.notoBold(18))
                    .foregroundColor(DesignTokens.Colors.textPrimary)

                if !request.message.isEmpty {
                    Text(request.message)
                        .font(DesignTokens.Fonts.notoRegular(13))
                        .foregroundColor(DesignTokens.Colors.textSecondary)
                }

                if let command = request.command, !command.isEmpty {
                    Text(command)
                        .font(DesignTokens.Fonts.sfProRegular(12))
                        .foregroundColor(DesignTokens.Colors.textPrimary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(DesignTokens.Colors.glassLight)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .textSelection(.enabled)
                }
                if request.method == "input" || request.method == "editor" {
                    TextField("输入回应", text: $responseText, axis: .vertical)
                        .lineLimit(request.method == "editor" ? 4...8 : 1...3)
                        .padding(12)
                        .background(DesignTokens.Colors.glassLight)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .autocorrectionDisabled()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 20)

            Spacer(minLength: 12)

            VStack(spacing: 10) {
                if request.options.isEmpty {
                    Button {
                        if request.method == "input" || request.method == "editor" {
                            client.respondToUiRequest(request, choice: responseText)
                        } else {
                            client.respondToUiRequest(request, approved: true)
                        }
                    } label: {
                        Text(request.method == "confirm" ? "允许这一次" : "确认")
                            .font(DesignTokens.Fonts.notoBold(15))
                            .foregroundColor(DesignTokens.Colors.textOnGreen)
                            .frame(maxWidth: .infinity)
                            .frame(height: 52)
                            .background(DesignTokens.Colors.accentGreen)
                            .clipShape(Capsule())
                    }

                    Button {
                        client.cancelUiRequest(request)
                    } label: {
                        Text(request.method == "confirm" ? "不允许" : "取消")
                            .font(DesignTokens.Fonts.notoBold(15))
                            .foregroundColor(DesignTokens.Colors.textPrimary)
                            .frame(maxWidth: .infinity)
                            .frame(height: 48)
                            .background(DesignTokens.Colors.glassMedium)
                            .clipShape(Capsule())
                    }
                } else {
                    ForEach(request.options, id: \.self) { option in
                        Button {
                            client.respondToUiRequest(request, choice: option)
                        } label: {
                            Text(option)
                                .font(DesignTokens.Fonts.notoRegular(15))
                                .foregroundColor(DesignTokens.Colors.textPrimary)
                                .frame(maxWidth: .infinity)
                                .frame(height: 48)
                                .background(DesignTokens.Colors.glassMedium)
                                .clipShape(Capsule())
                        }
                    }

                    Button {
                        client.cancelUiRequest(request)
                    } label: {
                        Text("取消")
                            .font(DesignTokens.Fonts.notoRegular(14))
                            .foregroundColor(DesignTokens.Colors.textSecondary)
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(DesignTokens.Colors.background)
        .onAppear { responseText = request.initialValue }
    }
}

extension RelayClient {
    /// pendingApproval 的可绑定投影：关闭弹层等价于取消该请求。
    var pendingApprovalBinding: Binding<ApprovalRequest?> {
        Binding(
            get: { self.pendingApproval },
            set: { newValue in
                if newValue == nil, let request = self.pendingApproval {
                    self.cancelUiRequest(request)
                }
            }
        )
    }
}

#if DEBUG
#Preview {
    ConversationView(client: RelayClient.shared, session: nil)
}
#endif

private struct ConversationRowFrames: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, latest in latest })
    }
}
