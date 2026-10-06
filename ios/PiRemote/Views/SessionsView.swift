import SwiftUI

public struct SessionsView: View {
    @Bindable var client: RelayClient
    public var onNewSessionTapped: () -> Void = {}
    public var onSessionSelected: (SessionItem) -> Void = { _ in }
    public var onDisconnectTapped: () -> Void = {}

    @State private var searchText = ""
    @State private var selectedFilter: SessionFilter = .all
    @State private var selectedTab = 0

    public init(
        client: RelayClient,
        onNewSessionTapped: @escaping () -> Void = {},
        onSessionSelected: @escaping (SessionItem) -> Void = { _ in },
        onDisconnectTapped: @escaping () -> Void = {}
    ) {
        self.client = client
        self.onNewSessionTapped = onNewSessionTapped
        self.onSessionSelected = onSessionSelected
        self.onDisconnectTapped = onDisconnectTapped
    }

    private var visibleSessions: [SessionItem] {
        client.sessions
            .filter(selectedFilter.matches)
            .filter { searchText.isEmpty || $0.title.localizedCaseInsensitiveContains(searchText) }
    }

    public var body: some View {
        ZStack(alignment: .bottom) {
            DesignTokens.Colors.background
                .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        Text(selectedTab == 0 ? "会话" : "设备")
                            .font(DesignTokens.Fonts.notoBold(32))
                            .foregroundColor(DesignTokens.Colors.textPrimary)

                        Spacer()

                        if client.isConnecting {
                            ProgressView()
                                .padding(.trailing, 8)
                        }

                        if selectedTab == 0 {
                            Button(action: onNewSessionTapped) {
                                Image(systemName: "plus")
                                    .font(.system(size: 16, weight: .semibold))
                                    .foregroundColor(DesignTokens.Colors.textPrimary)
                                    .frame(width: 44, height: 44)
                                    .glassCircle()
                            }
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 12)

                    if selectedTab == 0 {
                        sessionsTab
                    } else {
                        deviceTab
                    }

                    Spacer().frame(height: 100)
                }
            }
            .refreshable {
                client.refreshSessions()
            }

            tabBar
        }
    }

    private var sessionsTab: some View {
        VStack(alignment: .leading, spacing: 16) {
            deviceCard

            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14))
                    .foregroundColor(DesignTokens.Colors.textSecondary)
                TextField("搜索会话", text: $searchText)
                    .font(DesignTokens.Fonts.notoRegular(14))
                    .foregroundColor(DesignTokens.Colors.textPrimary)
            }
            .padding(.horizontal, 14)
            .frame(height: 44)
            .background(DesignTokens.Colors.glassMediumAlt)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .padding(.horizontal, 20)

            HStack(spacing: 8) {
                ForEach(SessionFilter.allCases) { filter in
                    let isSelected = selectedFilter == filter
                    let count = client.sessions.filter(filter.matches).count
                    Button(action: { selectedFilter = filter }) {
                        Text(filter.label(count: count))
                            .font(DesignTokens.Fonts.notoRegular(13))
                            .foregroundColor(isSelected ? Color.white : DesignTokens.Colors.textSecondary)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 8)
                            .background(isSelected ? DesignTokens.Colors.darkButton : Color.clear)
                            .clipShape(Capsule())
                    }
                }
                Spacer()
            }
            .padding(.horizontal, 20)

            if client.isConnected {
                if !client.supportsArchive {
                    noticeRow(text: "历史和工具详情需升级 Mac 助手；当前仍可读取旧快照。", color: DesignTokens.Colors.textSecondary)
                } else if client.historyIndexState == "building" {
                    noticeRow(text: "正在索引历史，已找到的会话会先显示。", color: DesignTokens.Colors.textSecondary)
                }
                ForEach(client.historyWarnings, id: \.self) { warning in
                    noticeRow(text: warning, color: DesignTokens.Colors.warning)
                }
            }
            if let error = client.connectionError {
                noticeRow(text: error, color: DesignTokens.Colors.warning)
            } else if let notice = client.lastError {
                noticeRow(text: notice, color: DesignTokens.Colors.warning)
            }

            if !visibleSessions.isEmpty {
                Text(selectedFilter == .history ? "历史快照 · 只读" : "会话")
                    .font(DesignTokens.Fonts.notoRegular(12))
                    .foregroundColor(DesignTokens.Colors.textSecondary)
                    .padding(.horizontal, 24)
                    .padding(.top, 8)

                VStack(spacing: 0) {
                    ForEach(Array(visibleSessions.enumerated()), id: \.element.id) { index, session in
                        SessionRowView(session: session, projectName: client.projectName(for: session.id)) {
                            onSessionSelected(session)
                        }
                        if index < visibleSessions.count - 1 {
                            Divider()
                                .background(DesignTokens.Colors.divider)
                                .padding(.horizontal, 24)
                        }
                    }
                }
                .background(DesignTokens.Colors.background)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .padding(.horizontal, 20)
            } else {
                emptyState
            }
            if client.sessionsCursor != nil {
                Button("加载更多历史会话") { client.loadMoreSessions() }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .tint(DesignTokens.Colors.accentGreen)
            }
        }
    }

    private var deviceCard: some View {
        Button(action: { selectedTab = 1 }) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(DesignTokens.Colors.glassMedium)
                        .frame(width: 42, height: 42)
                    Image(systemName: "laptopcomputer")
                        .font(.system(size: 18))
                        .foregroundColor(DesignTokens.Colors.textPrimary)
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text(client.agentName ?? "我的 MacBook Pro")
                        .font(DesignTokens.Fonts.notoBold(15))
                        .foregroundColor(DesignTokens.Colors.textPrimary)
                    Text(deviceSubtitle)
                        .font(DesignTokens.Fonts.notoRegular(12))
                        .foregroundColor(DesignTokens.Colors.textSecondary)
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(DesignTokens.Colors.textSecondary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .glassCard(cornerRadius: 18)
        .padding(.horizontal, 20)
    }

    private var deviceSubtitle: String {
        if !client.isConnected {
            return client.connectionError ?? "尚未连接 Relay"
        }
        if !client.agentConnected {
            return "Relay 已连接 · 等待 Mac 上的 pi"
        }
        let running = client.sessions.filter { $0.isActive }.count
        return running > 0 ? "已连接 · \(running) 个任务运行中" : "已连接 · 暂无运行中的任务"
    }

    private var deviceTab: some View {
        VStack(alignment: .leading, spacing: 16) {
            deviceCard

            VStack(alignment: .leading, spacing: 12) {
                infoRow(label: "服务器", value: client.config.serverUrl)
                infoRow(label: "本机设备名", value: client.config.deviceName)
                infoRow(label: "Relay", value: client.isConnected ? "已连接" : "未连接")
                infoRow(label: "Mac 上的 pi", value: client.agentName ?? (client.agentConnected ? "已连接" : "未连接"))
                infoRow(label: "会话数", value: "\(client.sessions.count)")
            }
            .padding(16)
            .cardSurface()
            .padding(.horizontal, 20)

            VStack(spacing: 10) {
                Button {
                    client.refreshSessions()
                } label: {
                    Text("刷新会话")
                        .font(DesignTokens.Fonts.notoBold(15))
                        .foregroundColor(DesignTokens.Colors.textPrimary)
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                }
                .glassCard(cornerRadius: 16)
                .disabled(!client.isConnected)

                Button {
                    onDisconnectTapped()
                } label: {
                    Text("断开连接")
                        .font(DesignTokens.Fonts.notoBold(15))
                        .foregroundColor(DesignTokens.Colors.textOnGreen)
                        .frame(maxWidth: .infinity)
                        .frame(height: 52)
                        .background(DesignTokens.Colors.darkButton)
                        .clipShape(Capsule())
                }
            }
            .padding(.horizontal, 20)
        }
    }

    private func infoRow(label: String, value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(DesignTokens.Fonts.notoRegular(13))
                .foregroundColor(DesignTokens.Colors.textSecondary)
            Spacer(minLength: 16)
            Text(value)
                .font(DesignTokens.Fonts.sfProRegular(13))
                .foregroundColor(DesignTokens.Colors.textPrimary)
                .multilineTextAlignment(.trailing)
        }
    }

    private func noticeRow(text: String, color: Color) -> some View {
        Text(text)
            .font(DesignTokens.Fonts.notoRegular(12))
            .foregroundColor(color)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(color.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .padding(.horizontal, 20)
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Text(client.isConnected ? "暂无会话" : "尚未连接 Mac")
                .font(DesignTokens.Fonts.notoRegular(14))
                .foregroundColor(DesignTokens.Colors.textSecondary)
            Text(client.isConnected ? "点击右上角加号开始一个任务。" : "在连接页填写 Relay 地址与 Token。")
                .font(DesignTokens.Fonts.notoRegular(12))
                .foregroundColor(DesignTokens.Colors.textPlaceholder)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }

    private var tabBar: some View {
        HStack(spacing: 40) {
            Button(action: { selectedTab = 0 }) {
                HStack(spacing: 6) {
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                        .font(.system(size: 15))
                    Text("会话")
                        .font(DesignTokens.Fonts.notoBold(14))
                }
                .foregroundColor(selectedTab == 0 ? DesignTokens.Colors.accentGreen : DesignTokens.Colors.textSecondary)
            }

            Button(action: { selectedTab = 1 }) {
                HStack(spacing: 6) {
                    Image(systemName: "laptopcomputer")
                        .font(.system(size: 15))
                    Text("设备")
                        .font(DesignTokens.Fonts.notoBold(14))
                }
                .foregroundColor(selectedTab == 1 ? DesignTokens.Colors.accentGreen : DesignTokens.Colors.textSecondary)
            }
        }
        .padding(.horizontal, 36)
        .padding(.vertical, 16)
        .glassCapsule(isSelected: true)
        .padding(.bottom, 4)
    }
}

private struct SessionRowView: View {
    let session: SessionItem
    let projectName: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(session.title)
                        .font(DesignTokens.Fonts.notoRegular(16))
                        .foregroundColor(DesignTokens.Colors.textPrimary)
                        .lineLimit(1)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DesignTokens.Colors.textSecondary)
                }

                Text(session.subtitle)
                    .font(DesignTokens.Fonts.notoRegular(13))
                    .foregroundColor(DesignTokens.Colors.textSecondary)
                    .lineLimit(1)

                HStack {
                    if let projectName {
                        HStack(spacing: 4) {
                            Circle()
                                .fill(dotColor)
                                .frame(width: 7, height: 7)
                            Text(projectName)
                                .font(DesignTokens.Fonts.sfProRegular(11))
                                .foregroundColor(DesignTokens.Colors.textSecondary)
                        }
                    }

                    Spacer()

                    Text(session.timeAgo)
                        .font(DesignTokens.Fonts.notoRegular(11))
                        .foregroundColor(DesignTokens.Colors.textSecondary)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
            .background(DesignTokens.Colors.background)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var dotColor: Color {
        switch session.status {
        case .running: return DesignTokens.Colors.accentGreen
        case .approval: return DesignTokens.Colors.warning
        case .done: return DesignTokens.Colors.textPlaceholder
        }
    }
}

#if DEBUG
#Preview {
    SessionsView(client: RelayClient.shared)
}
#endif
