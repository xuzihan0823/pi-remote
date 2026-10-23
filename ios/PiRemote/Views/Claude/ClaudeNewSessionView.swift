import SwiftUI

/// 新建 Claude 会话：显式选择工作目录（daemon 只接受已有会话出现过的目录或主目录），输入第一条消息。
struct ClaudeNewSessionView: View {
    @Bindable var client: ClaudeClient
    var initialProjectFilter: ClaudeProjectFilter = .all
    var onStarted: (String) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    @State private var cwd = ""
    @State private var text = ""
    @State private var starting = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if client.catalog.selectableCwds.isEmpty {
                        Text("还没有读取到项目目录。")
                            .foregroundColor(DesignTokens.Colors.textSecondary)
                        Button("重新读取") { Task { await client.refreshCatalog() } }
                    } else {
                        Picker("工作目录", selection: $cwd) {
                            ForEach(client.catalog.projects) { project in
                                Section(client.catalog.title(for: project)) {
                                    ForEach(project.cwds, id: \.self) { directory in
                                        Text(ClaudeProjectCatalog.shortPath(directory)).tag(directory)
                                    }
                                }
                            }
                            if !client.catalog.homeCwd.isEmpty {
                                Text("主目录（\(ClaudeProjectCatalog.shortPath(client.catalog.homeCwd))）").tag(client.catalog.homeCwd)
                            }
                        }
                        .pickerStyle(.navigationLink)
                        .accessibilityIdentifier("claude-new-cwd")
                    }
                } header: {
                    Text("在哪个目录运行")
                } footer: {
                    Text("Claude 会在 Mac 上的这个目录中工作。只能选择已有会话用过的目录或主目录。")
                }

                Section("第一条消息") {
                    TextField("描述你想完成的工作…", text: $text, axis: .vertical)
                        .lineLimit(3...10)
                        .accessibilityIdentifier("claude-new-text")
                }

                Section {
                    Button(starting ? "正在创建…" : "开始") { start() }
                        .disabled(!canStart)
                        .accessibilityIdentifier("claude-new-start")
                }
            }
            .navigationTitle("新建 Claude 会话")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
            }
            .task {
                if client.catalog.selectableCwds.isEmpty { await client.refreshCatalog() }
                if cwd.isEmpty { cwd = defaultCwd }
            }
            .onChange(of: client.catalog) { _, _ in
                if cwd.isEmpty || !client.catalog.selectableCwds.contains(cwd) { cwd = defaultCwd }
            }
        }
    }

    private var defaultCwd: String {
        if case .project(let id) = initialProjectFilter, let project = client.catalog.projects.first(where: { $0.id == id }) {
            return project.cwd
        }
        return client.catalog.projects.first?.cwd ?? client.catalog.homeCwd
    }

    private var canStart: Bool {
        !starting && client.isConnected && !cwd.isEmpty && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func start() {
        guard canStart else { return }
        starting = true
        Task {
            let sessionId = await client.createSession(cwd: cwd, text: text)
            starting = false
            if let sessionId { onStarted(sessionId) }
        }
    }
}
