import SwiftUI

public struct NewSessionView: View {
    @Bindable var client: RelayClient
    public var onSidebarTapped: () -> Void = {}
    public var onStarted: (String) -> Void = { _ in }

    @State private var promptText = ""
    @State private var cwd = ""
    @State private var mode: SessionStartMode = .terminal
    @State private var showProjectPicker = false
    @State private var selectedModel: RemoteModel?
    @FocusState private var promptFocused: Bool

    public init(
        client: RelayClient,
        onSidebarTapped: @escaping () -> Void = {},
        onStarted: @escaping (String) -> Void = { _ in }
    ) {
        self.client = client
        self.onSidebarTapped = onSidebarTapped
        self.onStarted = onStarted
    }

    public var body: some View {
        ZStack {
            DesignTokens.Colors.background
                .ignoresSafeArea()

            VStack(spacing: 0) {
                topBar

                ScrollView {
                    greeting
                        .frame(maxWidth: .infinity)
                        .containerRelativeFrame(.vertical)
                }
                .scrollDismissesKeyboard(.interactively)
                .onTapGesture { promptFocused = false }
            }
            .safeAreaInset(edge: .bottom) { composer }
        }
        .onDisappear { client.cancelSessionCreation() }
        .task(id: catalogKey) {
            client.loadModelCatalog(cwd: cwd, mode: mode)
        }
        .onChange(of: client.catalogModels) { _, models in
            if let selectedModel, !models.contains(selectedModel) { self.selectedModel = nil }
        }
        .sheet(isPresented: $showProjectPicker) {
            MacProjectPicker(client: client) { project in
                cwd = project.path
                promptFocused = false
                showProjectPicker = false
            }
        }
    }

    private var topBar: some View {
        HStack {
            Button(action: onSidebarTapped) {
                Image(systemName: "sidebar.left")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(DesignTokens.Colors.textPrimary)
                    .frame(width: 44, height: 44)
                    .glassCircle()
            }
            .accessibilityLabel("会话列表")
            .accessibilityIdentifier("open-sidebar")

            Spacer()

            HStack(spacing: 6) {
                Image(systemName: "laptopcomputer")
                    .font(.system(size: 13))
                Text(client.agentName ?? "MacBook Pro")
                    .font(DesignTokens.Fonts.sfProRegular(13))
                    .lineLimit(1)
                Circle()
                    .fill(client.agentConnected ? DesignTokens.Colors.accentGreen : DesignTokens.Colors.textPlaceholder)
                    .frame(width: 6, height: 6)
            }
            .foregroundColor(DesignTokens.Colors.textPrimary)
            .padding(.horizontal, 16)
            .frame(height: 38)
            .glassCapsule()

            Spacer()

            Color.clear.frame(width: 44, height: 44)
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
    }

    private var greeting: some View {
        VStack(spacing: 8) {
            Text(client.agentConnected ? "想从哪里开始？" : "Mac 上的 pi 尚未连接")
                .font(DesignTokens.Fonts.notoBold(26))
                .foregroundColor(DesignTokens.Colors.textPrimary)
            Text(client.agentConnected
                 ? (mode == .terminal ? "手机与 Mac 终端共用同一会话。" : "会话在 Mac 后台运行。")
                 : "先在 Mac 上启动 agent，再开始任务。")
                .font(DesignTokens.Fonts.notoRegular(14))
                .foregroundColor(DesignTokens.Colors.textSecondary)

            Button {
                promptFocused = false
                showProjectPicker = true
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: cwd.isEmpty ? "folder.badge.plus" : "folder.fill")
                        .font(.system(size: 15))
                    Text(cwd.isEmpty ? "选择项目" : (cwd as NSString).lastPathComponent)
                        .font(DesignTokens.Fonts.notoBold(15))
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                }
                .foregroundColor(cwd.isEmpty ? DesignTokens.Colors.textPrimary : DesignTokens.Colors.accentGreen)
                .padding(.horizontal, 20)
                .frame(minHeight: 46)
                .glassCapsule(isSelected: !cwd.isEmpty)
            }
            .buttonStyle(.plain)
            .padding(.top, 18)
            .accessibilityIdentifier("choose-mac-project")
            .disabled(client.isCreatingSession || !client.isConnected || !client.agentConnected)
        }
        .multilineTextAlignment(.center)
        .padding(.horizontal, 28)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let error = client.lastError {
                Text(error)
                    .font(DesignTokens.Fonts.notoRegular(12))
                    .foregroundColor(DesignTokens.Colors.warning)
            }

            TextField("描述你想完成的工作…", text: $promptText, axis: .vertical)
                .font(DesignTokens.Fonts.notoRegular(15))
                .foregroundColor(DesignTokens.Colors.textPrimary)
                .lineLimit(1...5)
                .focused($promptFocused)
                .disabled(client.isCreatingSession)
                .frame(minHeight: 36, alignment: .topLeading)
                .padding(.horizontal, 4)

            HStack(spacing: 10) {
                Menu {
                    Picker("会话类型", selection: $mode) {
                        Label("Mac 共享会话", systemImage: "terminal").tag(SessionStartMode.terminal)
                        Label("后台会话", systemImage: "gearshape.2").tag(SessionStartMode.rpc)
                    }
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundColor(DesignTokens.Colors.textPrimary)
                        .frame(width: 40, height: 40)
                        .contentShape(Circle())
                }
                .disabled(client.isCreatingSession)
                .accessibilityLabel("更多选项")

                Text(mode == .terminal ? "共享" : "后台")
                    .font(DesignTokens.Fonts.notoRegular(12))
                    .foregroundColor(DesignTokens.Colors.textSecondary)

                Spacer(minLength: 0)

                ModelMenu(
                    models: client.catalogModels,
                    selected: selectedModel,
                    isLoading: client.isLoadingModels,
                    defaultTitle: "默认模型",
                    onSelect: { selectedModel = $0 }
                )
                .disabled(client.isCreatingSession || !client.supportsModelCatalog)

                Button(action: send) {
                    Group {
                        if client.isCreatingSession {
                            ProgressView()
                                .tint(DesignTokens.Colors.textOnGreen)
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 16, weight: .bold))
                                .foregroundColor(DesignTokens.Colors.textOnGreen)
                        }
                    }
                    .frame(width: 40, height: 40)
                    .background(canSend ? DesignTokens.Colors.darkButton : DesignTokens.Colors.textPlaceholder)
                    .clipShape(Circle())
                }
                .disabled(!canSend)
                .accessibilityLabel(client.isCreatingSession ? "正在创建会话" : "创建并发送")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
        .glassCard(cornerRadius: 24)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    private var catalogKey: String {
        "\(client.isConnected)|\(client.agentConnected)|\(client.supportsModelCatalog)|\(mode.rawValue)|\(cwd)"
    }

    private var canSend: Bool {
        !promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !cwd.isEmpty && client.isConnected && client.agentConnected && !client.isCreatingSession
    }

    private func send() {
        let text = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend else { return }
        client.startNewSession(prompt: text, cwd: cwd, mode: mode, model: selectedModel) { sessionId in
            onStarted(sessionId)
        }
    }
}

/// 输入框右下角的模型选择，新建页和会话页共用。nil 表示沿用 Mac 上的默认模型。
struct ModelMenu: View {
    let models: [RemoteModel]
    let selected: RemoteModel?
    var isLoading = false
    let defaultTitle: String
    let onSelect: (RemoteModel?) -> Void
    @State private var isPresented = false
    @State private var search = ""

    var body: some View {
        Button {
            search = ""
            isPresented = true
        } label: {
            HStack(spacing: 4) {
                if isLoading {
                    ProgressView().controlSize(.mini)
                }
                Text(selected?.name ?? defaultTitle)
                    .font(DesignTokens.Fonts.sfProRegular(14))
                    .foregroundColor(selected == nil ? DesignTokens.Colors.textSecondary : DesignTokens.Colors.textPrimary)
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(DesignTokens.Colors.textSecondary)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("选择模型，当前\(selected?.name ?? defaultTitle)")
        .sheet(isPresented: $isPresented) {
            NavigationStack {
                List {
                    Button {
                        onSelect(nil)
                        isPresented = false
                    } label: {
                        selectionLabel(defaultTitle, isSelected: selected == nil)
                    }
                    ForEach(groupedProviders, id: \.self) { provider in
                        Section(provider) {
                            ForEach(filteredModels.filter { $0.provider == provider }) { model in
                                Button {
                                    onSelect(model)
                                    isPresented = false
                                } label: {
                                    selectionLabel(model.name, isSelected: model == selected)
                                }
                            }
                        }
                    }
                    if isLoading { ProgressView("正在读取模型…") }
                    if !search.isEmpty && filteredModels.isEmpty {
                        Text("没有匹配的模型").foregroundStyle(.secondary)
                    }
                }
                .accessibilityIdentifier("model-selection-list")
                .navigationTitle("选择模型")
                .navigationBarTitleDisplayMode(.inline)
                .searchable(text: $search, prompt: "搜索模型或提供商")
                .tint(DesignTokens.Colors.accentGreen)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("取消") { isPresented = false }
                    }
                }
            }
        }
    }

    private func selectionLabel(_ title: String, isSelected: Bool) -> some View {
        HStack {
            Text(title).foregroundStyle(DesignTokens.Colors.textPrimary)
            Spacer()
            if isSelected { Image(systemName: "checkmark") }
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var filteredModels: [RemoteModel] {
        models.filter {
            search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) ||
                $0.modelId.localizedCaseInsensitiveContains(search) ||
                $0.provider.localizedCaseInsensitiveContains(search)
        }
    }

    private var groupedProviders: [String] {
        var seen = Set<String>()
        return filteredModels.map(\.provider).filter { seen.insert($0).inserted }
    }
}

private struct MacProjectPicker: View {
    let client: RelayClient
    let onSelect: (MacProject) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var projects: MacProjectList?
    @State private var error: String?
    @State private var loading = false
    @State private var search = ""

    private var filteredProjects: [MacProject] {
        (projects?.projects ?? []).filter {
            search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) ||
                $0.path.localizedCaseInsensitiveContains(search)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if let projects {
                    Section("已有项目") {
                        if filteredProjects.isEmpty {
                            Text(search.isEmpty ? "还没有可用的最近项目，请浏览 Mac 目录。" : "没有匹配的项目。")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(filteredProjects) { project in
                            Button { onSelect(project) } label: { MacProjectRow(project: project) }
                                .accessibilityIdentifier("select-project-\(project.path)")
                                .disabled(!client.isConnected || !client.agentConnected)
                        }
                    }
                    Section("浏览 Mac") {
                        NavigationLink(value: MacProject(name: "用户目录", path: projects.home)) {
                            Label("用户目录", systemImage: "house")
                        }
                        NavigationLink(value: MacProject(name: "默认项目目录", path: projects.defaultDirectory)) {
                            Label("默认项目目录", systemImage: "folder")
                        }
                        NavigationLink(value: MacProject(name: "本机全部目录", path: "/")) {
                            Label("本机全部目录", systemImage: "laptopcomputer")
                        }
                    }
                }
                if loading { ProgressView("正在读取 Mac 项目…") }
                if let error {
                    Section {
                        Text(error).foregroundStyle(.secondary)
                        Button("重新读取") { Task { await load() } }
                    }
                }
            }
            .navigationTitle("选择 Mac 项目")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $search, prompt: "搜索项目名称或路径")
            .tint(DesignTokens.Colors.accentGreen)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
            }
            .navigationDestination(for: MacProject.self) { project in
                MacDirectoryPicker(client: client, directory: project, onSelect: onSelect)
            }
            .task { await load() }
        }
    }

    @MainActor
    private func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do { projects = try await client.fetchProjects() }
        catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }
}

private struct MacDirectoryPicker: View {
    let client: RelayClient
    let directory: MacProject
    let onSelect: (MacProject) -> Void
    @State private var page: MacDirectoryPage?
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        List {
            Section {
                Text(page?.path ?? directory.path)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                Button("使用此目录") {
                    if let page { onSelect(MacProject(name: directory.name, path: page.path)) }
                }
                .accessibilityIdentifier("use-mac-directory")
                .disabled(page == nil || !client.isConnected || !client.agentConnected)
            } footer: {
                Text("在这个已有目录中新建会话，不会创建或上传项目文件。")
            }
            Section("子文件夹") {
                ForEach(page?.directories ?? []) { project in
                    NavigationLink(value: project) { MacProjectRow(project: project) }
                }
                if let page, page.directories.isEmpty, !loading {
                    Text("没有可访问的子文件夹。").foregroundStyle(.secondary)
                }
                if let offset = page?.nextOffset {
                    Button("加载更多文件夹") { Task { await load(offset: offset) } }
                        .disabled(loading)
                }
            }
            if loading { ProgressView("正在读取目录…") }
            if let error {
                Text(error).foregroundStyle(.secondary)
                Button("重试") { Task { await load(offset: page?.nextOffset ?? 0) } }
            }
        }
        .navigationTitle(directory.name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    @MainActor
    private func load(offset: Int = 0) async {
        guard !loading else { return }
        loading = true
        error = nil
        defer { loading = false }
        do {
            var incoming = try await client.fetchProjectDirectory(path: page?.path ?? directory.path, offset: offset)
            if offset > 0 {
                let existing = page?.directories ?? []
                let ids = Set(existing.map(\.id))
                incoming.directories = existing + incoming.directories.filter { !ids.contains($0.id) }
            }
            page = incoming
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }
}

private struct MacProjectRow: View {
    let project: MacProject

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "folder").foregroundStyle(DesignTokens.Colors.accentGreen)
            VStack(alignment: .leading, spacing: 4) {
                Text(project.name).font(.body).foregroundStyle(.primary)
                Text(project.path).font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(minHeight: 44, alignment: .leading)
    }
}

#if DEBUG
#Preview {
    NewSessionView(client: RelayClient.shared)
}
#endif
