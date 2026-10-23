import SwiftUI

/// Claude 后端的主界面：会话列表（按项目筛选）+ 搜索 + 新建 + 审批入口，点进会话进入对话页。
struct ClaudeRootView: View {
    @Bindable var client: ClaudeClient
    var onSwitchBackend: () -> Void = {}
    /// 深链 claude-remote://setup 带来的配对码，确认后清空。
    @Binding var incomingCode: ClaudePairingCode?

    @State private var searchText = ""
    @State private var showNewSession = false
    @State private var showApprovals = false
    @State private var confirmForget = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if showsConnect {
                ClaudeConnectView(client: client, onSwitchBackend: onSwitchBackend, incomingCode: incomingCode)
            } else {
                home
            }
        }
        .onAppear { client.resumeSavedConnection() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { client.reconnectNow() }
        }
        .onChange(of: client.isConnected) { _, connected in
            if connected { incomingCode = nil }
        }
        .onChange(of: client.approvalSheetRequested) { _, requested in
            guard requested else { return }
            client.approvalSheetRequested = false
            if !showsConnect { showApprovals = true }
        }
        .overlay(alignment: .top) { ClaudeNoticeBanner(client: client) }
    }

    private var showsConnect: Bool {
        if incomingCode != nil { return true }
        if client.connection == nil { return true }
        if case .failed = client.phase { return true }
        return false
    }

    private var home: some View {
        NavigationStack {
            List {
                if let status = connectionNotice {
                    Text(status)
                        .font(DesignTokens.Fonts.notoRegular(12))
                        .foregroundColor(DesignTokens.Colors.textSecondary)
                        .listRowBackground(Color.clear)
                }

                if !client.unresolvedInteractions.isEmpty {
                    Button {
                        showApprovals = true
                    } label: {
                        Label("\(client.unresolvedInteractions.count) 个请求等待你处理", systemImage: "hand.raised.fill")
                            .font(DesignTokens.Fonts.notoBold(14))
                            .foregroundColor(DesignTokens.Colors.warning)
                    }
                    .accessibilityIdentifier("claude-approvals-banner")
                }

                if searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    sessionRows
                } else {
                    searchRows
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(DesignTokens.Colors.background)
            .searchable(text: $searchText, prompt: "搜索标题、路径或正文")
            .onChange(of: searchText) { _, text in client.setSearchQuery(text) }
            .refreshable {
                await client.refreshSessions()
                await client.refreshCatalog()
            }
            .navigationTitle(filterTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { projectMenu }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showNewSession = true
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .disabled(!client.isConnected)
                    .accessibilityLabel("新建会话")
                }
                ToolbarItem(placement: .topBarTrailing) { settingsMenu }
            }
            .navigationDestination(isPresented: Binding(
                get: { client.activeSessionId != nil },
                set: { if !$0 { client.closeActiveSession() } }
            )) {
                ClaudeConversationView(client: client, onShowApprovals: { showApprovals = true })
            }
        }
        .sheet(isPresented: $showNewSession) {
            ClaudeNewSessionView(client: client, initialProjectFilter: client.filter) { _ in
                showNewSession = false
            }
        }
        .sheet(isPresented: $showApprovals) {
            ClaudeApprovalSheet(client: client)
        }
        .confirmationDialog("忘记这台 Mac？", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("忘记并断开", role: .destructive) { client.disconnect(forget: true) }
            Button("取消", role: .cancel) {}
        } message: {
            Text("将从钥匙串删除 Token，之后需要重新扫码配对。")
        }
    }

    // MARK: Sessions

    @ViewBuilder
    private var sessionRows: some View {
        Section {
            if client.sessions.isEmpty {
                if client.isLoadingSessions {
                    ProgressView().frame(maxWidth: .infinity)
                } else if let error = client.sessionsError {
                    Text(error).foregroundColor(DesignTokens.Colors.warning)
                } else {
                    Text("还没有会话").foregroundColor(DesignTokens.Colors.textSecondary)
                }
            }
            ForEach(client.sessions) { session in
                Button {
                    client.open(sessionId: session.id)
                } label: {
                    ClaudeSessionRow(session: session, subtitle: session.lastPreview, catalog: client.catalog)
                }
                .accessibilityIdentifier("claude-session-\(session.id)")
            }
            if client.hasMoreSessions {
                Button(client.isLoadingMoreSessions ? "正在加载…" : "加载更多（共 \(client.sessionsTotal) 个）") {
                    Task { await client.loadMoreSessions() }
                }
                .disabled(client.isLoadingMoreSessions)
                .frame(maxWidth: .infinity)
            }
        } header: {
            if client.sessionsTotal > 0 { Text("\(client.sessionsTotal) 个会话") }
        }
    }

    @ViewBuilder
    private var searchRows: some View {
        Section {
            if client.search.loading {
                ProgressView().frame(maxWidth: .infinity)
            }
            if let error = client.search.error {
                HStack {
                    Text(error).foregroundColor(DesignTokens.Colors.warning)
                    Spacer()
                    Button("重试") { client.retrySearch() }
                }
            }
            ForEach(client.search.results) { result in
                Button {
                    let target = result.target
                    client.open(sessionId: target.sessionId, focusSeq: target.focusSeq)
                } label: {
                    ClaudeSessionRow(session: result.session, subtitle: "\(result.field.label)：\(result.snippet)", catalog: client.catalog)
                }
            }
            if !client.search.loading, client.search.error == nil, client.search.results.isEmpty, !client.search.fullLoading {
                Text("没有找到").foregroundColor(DesignTokens.Colors.textSecondary)
            }
        } header: {
            Text("搜索结果")
        } footer: {
            if client.search.fullLoading {
                Text("正在搜索正文…")
            } else if client.search.truncated {
                Text("历史较多，正文结果可能不完整。")
            }
        }
    }

    // MARK: Toolbar

    private var filterTitle: String {
        switch client.filter {
        case .all: return "全部会话"
        case .unclassified: return "未归类"
        case .project(let id): return client.catalog.projects.first { $0.id == id }.map { client.catalog.title(for: $0) } ?? "项目"
        }
    }

    private var projectMenu: some View {
        Menu {
            Picker("项目", selection: Binding(get: { client.filter }, set: { client.setFilter($0) })) {
                Text("全部会话（\(client.catalog.totalSessions)）").tag(ClaudeProjectFilter.all)
                ForEach(client.catalog.projects) { project in
                    Text("\(client.catalog.title(for: project))（\(project.sessionCount)）").tag(ClaudeProjectFilter.project(project.id))
                }
                if client.catalog.unclassifiedCount > 0 {
                    Text("未归类（\(client.catalog.unclassifiedCount)）").tag(ClaudeProjectFilter.unclassified)
                }
            }
        } label: {
            Image(systemName: "folder")
        }
        .accessibilityLabel("按项目筛选")
    }

    private var settingsMenu: some View {
        Menu {
            Section(client.hostname.map { "已连接 \($0)" } ?? "Claude 后端") {
                if let base = client.connection?.baseURL {
                    Text(base.absoluteString)
                }
            }
            Button("刷新") {
                Task {
                    await client.refreshSessions()
                    await client.refreshCatalog()
                    await client.syncPending()
                }
            }
            Button("改用 Pi Relay", action: onSwitchBackend)
            Button("忘记这台 Mac", role: .destructive) { confirmForget = true }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("更多")
    }

    private var connectionNotice: String? {
        switch client.phase {
        case .connecting: return "正在连接…"
        case .reconnecting(let seconds): return "连接中断，\(seconds) 秒后重试"
        default: return nil
        }
    }
}

struct ClaudeSessionRow: View {
    let session: ClaudeSessionSummary
    let subtitle: String
    let catalog: ClaudeProjectCatalog

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(session.title)
                    .font(DesignTokens.Fonts.notoBold(15))
                    .foregroundColor(DesignTokens.Colors.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                ClaudeStatusBadge(status: session.status)
            }
            if !subtitle.isEmpty {
                Text(subtitle)
                    .font(DesignTokens.Fonts.notoRegular(12))
                    .foregroundColor(DesignTokens.Colors.textSecondary)
                    .lineLimit(2)
            }
            HStack(spacing: 6) {
                Text(projectLabel)
                    .lineLimit(1)
                if let date = session.lastActiveAt {
                    Text("·")
                    Text(date, style: .relative)
                }
            }
            .font(DesignTokens.Fonts.notoRegular(11))
            .foregroundColor(DesignTokens.Colors.textPlaceholder)
        }
        .padding(.vertical, 2)
    }

    private var projectLabel: String {
        if let project = catalog.project(forCwd: session.cwd) { return catalog.title(for: project) }
        return session.cwd.isEmpty ? "未归类" : ClaudeProjectCatalog.shortPath(session.cwd)
    }
}

struct ClaudeStatusBadge: View {
    let status: ClaudeSessionStatus

    var body: some View {
        if status != .idle && status != .unknown {
            Text(status.label)
                .font(DesignTokens.Fonts.notoRegular(10))
                .foregroundColor(status == .daemonDriving ? DesignTokens.Colors.accentGreen : DesignTokens.Colors.warning)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(Capsule().fill(DesignTokens.Colors.glassMedium))
                .accessibilityLabel("状态：\(status.label)")
        }
    }
}

/// 一次性提示条（停止结果、审批冲突、加载失败等），3 秒后自动消失。
struct ClaudeNoticeBanner: View {
    @Bindable var client: ClaudeClient

    var body: some View {
        if let notice = client.notice {
            Text(notice)
                .font(DesignTokens.Fonts.notoRegular(13))
                .foregroundColor(DesignTokens.Colors.textPrimary)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .glassCapsule()
                .padding(.top, 8)
                .transition(.move(edge: .top).combined(with: .opacity))
                .onTapGesture { client.notice = nil }
                .task(id: notice) {
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    if client.notice == notice { client.notice = nil }
                }
                .accessibilityAddTraits(.isStaticText)
        }
    }
}
