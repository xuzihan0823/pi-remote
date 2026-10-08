import SwiftUI

public struct SessionsView: View {
    @Bindable var client: RelayClient
    public var onNewSessionTapped: () -> Void = {}
    public var onSessionSelected: (SessionItem) -> Void = { _ in }
    public var onDisconnectTapped: () -> Void = {}
    public var onDeviceSwitched: () -> Void = {}

    @State private var searchText = ""
    @State private var selectedFilter: SessionFilter = .all
    @State private var showSettings = false
    @State private var collapsedProjects: Set<String> = []
    @State private var seenSessionIds: Set<String> = []
    @State private var freshSessionIds: Set<String> = []
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        client: RelayClient,
        onNewSessionTapped: @escaping () -> Void = {},
        onSessionSelected: @escaping (SessionItem) -> Void = { _ in },
        onDisconnectTapped: @escaping () -> Void = {},
        onDeviceSwitched: @escaping () -> Void = {}
    ) {
        self.client = client
        self.onNewSessionTapped = onNewSessionTapped
        self.onSessionSelected = onSessionSelected
        self.onDisconnectTapped = onDisconnectTapped
        self.onDeviceSwitched = onDeviceSwitched
    }

    private var visibleSessions: [SessionItem] {
        client.sessions
            .filter(selectedFilter.matches)
            .filter {
                searchText.isEmpty
                    || $0.title.localizedCaseInsensitiveContains(searchText)
                    || (client.projectName(for: $0.id)?.localizedCaseInsensitiveContains(searchText) ?? false)
            }
    }

    private var projectGroups: [SessionProjectGroup] {
        SessionProjectGroup.group(visibleSessions) { client.projectName(for: $0.id) }
    }

    public var body: some View {
        ZStack(alignment: .bottomLeading) {
            DesignTokens.Colors.background
                .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        Text("会话")
                            .font(DesignTokens.Fonts.notoBold(32))
                            .foregroundColor(DesignTokens.Colors.textPrimary)

                        Spacer()

                        if client.isConnecting {
                            ProgressView()
                                .padding(.trailing, 8)
                        }

                        Button(action: onNewSessionTapped) {
                            Image(systemName: "plus")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundColor(DesignTokens.Colors.textPrimary)
                                .frame(width: 44, height: 44)
                                .glassCircle()
                        }
                        .accessibilityLabel("新建会话")
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 12)

                    sessionsTab

                    Spacer().frame(height: 80)
                }
            }
            .refreshable {
                client.refreshSessions()
            }

            settingsButton
        }
        .sheet(isPresented: $showSettings) {
            SettingsView(
                client: client,
                onDeviceSwitched: onDeviceSwitched,
                onDisconnectTapped: onDisconnectTapped
            )
        }
    }

    private var settingsButton: some View {
        Button { showSettings = true } label: {
            HStack(spacing: 8) {
                Image(systemName: "gearshape")
                    .font(.system(size: 16, weight: .semibold))
                Text("设置")
                    .font(DesignTokens.Fonts.notoBold(14))
            }
            .foregroundColor(DesignTokens.Colors.textPrimary)
            .padding(.horizontal, 16)
            .frame(height: 44)
            .glassCapsule()
        }
        .buttonStyle(.plain)
        .padding(.leading, 20)
        .padding(.bottom, 8)
    }

    private var sessionsTab: some View {
        VStack(alignment: .leading, spacing: 16) {
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

            HStack(spacing: 4) {
                ForEach(SessionFilter.allCases) { filter in
                    let isSelected = selectedFilter == filter
                    let count = client.sessions.filter(filter.matches).count
                    Button(action: { selectedFilter = filter }) {
                        Text(filter.label(count: count))
                            .font(DesignTokens.Fonts.notoRegular(13))
                            .lineLimit(1)
                            .fixedSize()
                            .foregroundColor(isSelected ? Color.white : DesignTokens.Colors.textSecondary)
                            .padding(.horizontal, 12)
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
                if selectedFilter == .history {
                    Text("历史快照 · 只读")
                        .font(DesignTokens.Fonts.notoRegular(12))
                        .foregroundColor(DesignTokens.Colors.textSecondary)
                        .padding(.horizontal, 24)
                        .padding(.top, 8)
                }

                LazyVStack(alignment: .leading, spacing: 4) {
                    ForEach(projectGroups) { group in
                        projectSection(group)
                    }
                }
                .padding(.horizontal, 20)
                .animation(reduceMotion ? nil : .spring(response: 0.45, dampingFraction: 0.82), value: visibleSessions.map(\.id))
            } else {
                emptyState
            }
        }
        .onAppear { seenSessionIds = Set(client.sessions.map(\.id)) }
        .onChange(of: client.sessions.map(\.id)) { _, ids in
            markFreshSessions(ids)
        }
    }

    /// 只高亮比已见会话更新的条目，分页补齐的旧历史和首次加载不触发动画。
    private func markFreshSessions(_ ids: [String]) {
        let current = Set(ids)
        guard !seenSessionIds.isEmpty else {
            seenSessionIds = current
            return
        }
        let newestSeen = client.sessions
            .filter { seenSessionIds.contains($0.id) }
            .compactMap(\.startedAt)
            .max() ?? .distantPast
        let added = client.sessions
            .filter { !seenSessionIds.contains($0.id) && ($0.startedAt ?? .distantPast) >= newestSeen }
            .map(\.id)
        seenSessionIds.formUnion(current)
        guard !added.isEmpty else { return }
        freshSessionIds.formUnion(added)
        Task {
            try? await Task.sleep(for: .seconds(1.6))
            withAnimation(.easeOut(duration: 0.6)) { freshSessionIds.subtract(added) }
        }
    }

    private func projectSection(_ group: SessionProjectGroup) -> some View {
        let isCollapsed = searchText.isEmpty && collapsedProjects.contains(group.id)

        return VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(reduceMotion ? nil : .snappy) {
                    if collapsedProjects.contains(group.id) {
                        collapsedProjects.remove(group.id)
                    } else {
                        collapsedProjects.insert(group.id)
                    }
                }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: group.isUngrouped ? "tray" : (isCollapsed ? "folder" : "folder.fill"))
                        .font(.system(size: 15))
                        .foregroundColor(DesignTokens.Colors.textSecondary)
                        .frame(width: 20)
                    Text(group.name)
                        .font(DesignTokens.Fonts.notoBold(15))
                        .foregroundColor(DesignTokens.Colors.textPrimary)
                        .lineLimit(1)
                    Text("\(group.sessions.count)")
                        .font(DesignTokens.Fonts.sfProRegular(12))
                        .foregroundColor(DesignTokens.Colors.textSecondary)
                    Spacer()
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DesignTokens.Colors.textSecondary)
                        .rotationEffect(.degrees(isCollapsed ? -90 : 0))
                }
                .padding(.horizontal, 4)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(group.name)，\(group.sessions.count) 个会话")
            .accessibilityValue(isCollapsed ? "已折叠" : "已展开")
            .accessibilityHint("轻点以\(isCollapsed ? "展开" : "折叠")")

            if !isCollapsed {
                VStack(spacing: 0) {
                    ForEach(Array(group.sessions.enumerated()), id: \.element.id) { index, session in
                        SessionRowView(session: session) {
                            onSessionSelected(session)
                        }
                        .background(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(DesignTokens.Colors.accentGreen.opacity(freshSessionIds.contains(session.id) ? 0.14 : 0))
                        )
                        .transition(reduceMotion ? .opacity : .asymmetric(
                            insertion: .move(edge: .top).combined(with: .opacity).combined(with: .scale(scale: 0.96, anchor: .top)),
                            removal: .opacity
                        ))
                        if index < group.sessions.count - 1 {
                            Divider()
                                .background(DesignTokens.Colors.divider)
                                .padding(.leading, 34)
                        }
                    }
                }
                .transition(.opacity)
            }
        }
        .padding(.bottom, 8)
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
}

private struct SessionRowView: View {
    let session: SessionItem
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Group {
                    if session.status == .running {
                        ProgressView()
                            .controlSize(.mini)
                            .tint(DesignTokens.Colors.accentGreen)
                    } else {
                        Circle()
                            .fill(dotColor)
                            .frame(width: 7, height: 7)
                    }
                }
                .frame(width: 20, height: 20)

                Text(session.title)
                    .font(DesignTokens.Fonts.notoRegular(15))
                    .foregroundColor(DesignTokens.Colors.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(session.timeAgo)
                    .font(DesignTokens.Fonts.notoRegular(11))
                    .foregroundColor(DesignTokens.Colors.textSecondary)
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 12)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityValue(session.subtitle)
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
