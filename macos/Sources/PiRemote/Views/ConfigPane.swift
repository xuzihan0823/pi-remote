import AppKit
import PiRemoteCore
import SwiftUI

struct ConfigPane: View {
    @ObservedObject var model: AppModel
    @State private var showAdvanced = false
    @FocusState private var focus: ConfigField?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            SettingsHeader(title: "连接设置", lockedHint: model.canEditConfig ? nil : "断开后可修改配置")
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if model.legacyAgentDetected {
                            legacyBanner
                        }
                        SettingsGroup(title: "连接方式") {
                            SegmentedChoice(
                                options: [(ConnectionMode.server, "服务器"), (ConnectionMode.cloudflare, "临时隧道")],
                                selection: $model.mode,
                                accessibilityName: "连接方式"
                            )
                            if model.mode == .cloudflare {
                                tunnelInfo
                                    .transition(.opacity)
                            }
                        }

                        if model.mode == .server {
                            serverSection
                                .transition(.opacity.combined(with: .offset(y: reduceMotion ? 0 : 4)))
                        }

                        SettingsGroup(title: "本机") {
                            workspaceField
                        }
                        SettingsGroup {
                            advancedSection
                        }
                        .id("advanced")
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 4)
                    .padding(.bottom, 24)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .disabled(!model.canEditConfig)
                    .animation(Motion.resolved(Motion.modeSwitch, reduceMotion: reduceMotion), value: model.mode)
                    .animation(Motion.resolved(Motion.modeSwitch, reduceMotion: reduceMotion), value: model.serverSource)
                }
                .onChange(of: model.fieldErrors[.piBin]) { error in
                    guard error != nil else { return }
                    withAnimation(Motion.resolved(Motion.disclosure, reduceMotion: reduceMotion)) { showAdvanced = true }
                    proxy.scrollTo("advanced", anchor: .center)
                }
                .onChange(of: model.fieldErrors[.deployPort]) { error in
                    if error != nil { showAdvanced = true }
                }
            }
            Divider().overlay(Theme.border)
            actions
                .padding(.horizontal, 24)
                .padding(.vertical, 14)
        }
        .onChange(of: focus) { [focus] _ in
            if let previous = focus { model.validateOnBlur(previous) }
        }
    }

    // MARK: - Sections

    private var serverSection: some View {
        SettingsGroup(title: "服务器") {
            SegmentedChoice(
                options: [(ServerSource.existing, "已有服务器"), (ServerSource.deploy, "部署到我的服务器")],
                selection: $model.serverSource,
                compact: true,
                accessibilityName: "服务器来源"
            )
            if model.serverSource == .existing {
                existingServerFields
            } else {
                deployFields
            }
        }
    }

    private var existingServerFields: some View {
        VStack(alignment: .leading, spacing: 16) {
            InputField(label: "服务器地址", error: model.fieldErrors[.serverURL]) {
                TextField("wss://example.com/ws/agent", text: $model.serverURL)
                    .focused($focus, equals: .serverURL)
                    .fieldBox(focused: focus == .serverURL, invalid: model.fieldErrors[.serverURL] != nil)
                    .onChange(of: model.serverURL) { _ in model.clearFieldError(.serverURL) }
            }
            InputField(label: "连接密钥", help: "连接时保存到系统钥匙串", error: model.fieldErrors[.token]) {
                SecureField("至少 32 个字符", text: $model.token)
                    .focused($focus, equals: .token)
                    .fieldBox(focused: focus == .token, invalid: model.fieldErrors[.token] != nil)
                    .onChange(of: model.token) { _ in model.clearFieldError(.token) }
            }
        }
    }

    private var deployFields: some View {
        VStack(alignment: .leading, spacing: 16) {
            InputField(label: "服务器地址", help: "IP 或主机名，需可通过 SSH 登录", error: model.fieldErrors[.deployHost]) {
                TextField("203.0.113.10", text: $model.deployTarget.host)
                    .focused($focus, equals: .deployHost)
                    .fieldBox(focused: focus == .deployHost, invalid: model.fieldErrors[.deployHost] != nil)
                    .onChange(of: model.deployTarget.host) { _ in model.clearFieldError(.deployHost) }
            }
            InputField(label: "用户名", help: "非 root 用户需要免密 sudo", error: model.fieldErrors[.deployUser]) {
                TextField("root", text: $model.deployTarget.user)
                    .focused($focus, equals: .deployUser)
                    .fieldBox(focused: focus == .deployUser, invalid: model.fieldErrors[.deployUser] != nil)
                    .onChange(of: model.deployTarget.user) { _ in model.clearFieldError(.deployUser) }
            }
            InputField(label: "SSH 私钥", help: "只记录文件位置，不读取或复制私钥内容", error: model.fieldErrors[.deployKey]) {
                HStack(spacing: 8) {
                    HStack(spacing: 6) {
                        Image(systemName: "key")
                            .foregroundColor(Theme.textSecondary)
                            .accessibilityHidden(true)
                        Text(model.deployTarget.identityFile.isEmpty ? "未选择" : abbreviated(model.deployTarget.identityFile))
                            .foregroundColor(model.deployTarget.identityFile.isEmpty ? Theme.textTertiary : Theme.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help(model.deployTarget.identityFile)
                        Spacer(minLength: 0)
                    }
                    .fieldBox(focused: false, invalid: model.fieldErrors[.deployKey] != nil)
                    Button("选择…") { chooseKeyFile() }
                        .buttonStyle(SecondaryButtonStyle())
                }
            }
            InputField(
                label: "域名（可选）",
                help: "留空将使用 sslip.io 免费域名：\(model.deployDomainPreview)。需服务器 IP 固定。",
                error: model.fieldErrors[.deployDomain]
            ) {
                TextField("relay.example.com", text: $model.deployTarget.domain)
                    .focused($focus, equals: .deployDomain)
                    .fieldBox(focused: focus == .deployDomain, invalid: model.fieldErrors[.deployDomain] != nil)
                    .onChange(of: model.deployTarget.domain) { _ in model.clearFieldError(.deployDomain) }
            }
        }
    }

    private var tunnelInfo: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("自动生成临时公网地址，无需配置服务器；重新连接后，请用手机重新扫码。")
                .font(Theme.Font.caption)
                .foregroundColor(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Label("由 Cloudflare 提供隧道", systemImage: "cloud")
                .font(Theme.Font.caption)
                .foregroundColor(Theme.textTertiary)
        }
    }

    @ViewBuilder
    private var workspaceField: some View {
        Label("会话范围：本机全部目录", systemImage: "laptopcomputer")
            .font(Theme.Font.caption)
            .foregroundColor(Theme.textSecondary)
        InputField(label: "默认项目目录", help: "会话范围为本机全部目录；此目录只用于新建会话和项目选择的起始位置。", error: model.fieldErrors[.workspace]) {
            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "folder")
                        .foregroundColor(Theme.textSecondary)
                        .accessibilityHidden(true)
                    TextField("~/Desktop", text: $model.workspacePath)
                        .textFieldStyle(.plain)
                        .focused($focus, equals: .workspace)
                        .help(model.workspacePath)
                        .onChange(of: model.workspacePath) { _ in model.clearFieldError(.workspace) }
                }
                .fieldBox(focused: focus == .workspace, invalid: model.fieldErrors[.workspace] != nil)
                Button("选择…") { chooseDirectory() }
                    .buttonStyle(SecondaryButtonStyle())
            }
        }
    }

    private var advancedSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            Button {
                withAnimation(Motion.resolved(Motion.disclosure, reduceMotion: reduceMotion)) { showAdvanced.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .rotationEffect(.degrees(showAdvanced ? 90 : 0))
                    Text("高级设置")
                        .font(Theme.Font.control)
                }
                .foregroundColor(Theme.textPrimary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(showAdvanced ? "收起高级设置" : "展开高级设置")

            if showAdvanced {
                VStack(alignment: .leading, spacing: 16) {
                    InputField(label: "运行时", help: "共享会话和后台会话使用的程序，支持 pi 与 omp。") {
                        SegmentedChoice(
                            options: [(AgentRuntime.pi, "pi"), (AgentRuntime.omp, "omp")],
                            selection: Binding(get: { model.runtime }, set: { model.setRuntime($0) }),
                            compact: true,
                            accessibilityName: "运行时"
                        )
                    }
                    InputField(label: "\(model.runtime.rawValue) 可执行文件", help: "PI_BIN · 通常无需修改", error: model.fieldErrors[.piBin]) {
                        TextField(model.runtime.defaultBinaryPath, text: $model.piBinPath)
                            .focused($focus, equals: .piBin)
                            .fieldBox(focused: focus == .piBin, invalid: model.fieldErrors[.piBin] != nil)
                            .help(model.piBinPath)
                            .onChange(of: model.piBinPath) { _ in model.clearFieldError(.piBin) }
                    }
                    if model.mode == .server && model.serverSource == .deploy {
                        InputField(label: "SSH 端口", error: model.fieldErrors[.deployPort]) {
                            TextField("22", value: $model.deployTarget.port, format: .number.grouping(.never))
                                .focused($focus, equals: .deployPort)
                                .fieldBox(focused: focus == .deployPort, invalid: model.fieldErrors[.deployPort] != nil)
                        }
                    }
                }
                .transition(.opacity)
            }
        }
    }

    // MARK: - Actions

    private var actions: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Button("从 .env 导入") { Panels.chooseEnvFile(model: model) }
                    .buttonStyle(LinkButtonStyle())
                    .disabled(!model.canEditConfig)
                    .keyboardShortcut("o", modifiers: .command)
                Spacer(minLength: 0)
                primaryAction
                    .frame(width: 168)
            }
            if let info = model.infoMessage {
                Text(info)
                    .font(Theme.Font.caption)
                    .foregroundColor(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            }
        }
        .animation(Motion.feedback, value: model.infoMessage)
    }

    @ViewBuilder
    private var primaryAction: some View {
        if model.deployStage.locksConfig {
            Button("取消部署") { model.cancelDeploy() }
                .buttonStyle(SecondaryButtonStyle(fill: true))
        } else {
            switch model.phase {
            case .idle, .error:
                if model.mode == .server && model.serverSource == .deploy {
                    Button("部署到服务器") { model.startDeploy() }
                        .buttonStyle(PrimaryButtonStyle())
                        .keyboardShortcut(.defaultAction)
                } else {
                    Button(model.phase == .error ? "重试连接" : model.idleReason == .disconnected ? "重新连接" : "连接") { model.connect() }
                        .buttonStyle(PrimaryButtonStyle())
                        .keyboardShortcut(.defaultAction)
                }
            case .connecting:
                Button("取消连接") { model.disconnect() }
                    .buttonStyle(SecondaryButtonStyle(fill: true))
            case .connected:
                Button("断开连接") { model.disconnect() }
                    .buttonStyle(SecondaryButtonStyle(fill: true))
            case .recovering:
                Button("停止重连") { model.disconnect() }
                    .buttonStyle(SecondaryButtonStyle(fill: true))
            case .stopping:
                Button("正在断开…") {}
                    .buttonStyle(SecondaryButtonStyle(fill: true))
                    .disabled(true)
            }
        }
    }

    private var legacyBanner: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("检测到后台连接服务", systemImage: "exclamationmark.triangle.fill")
                .font(Theme.Font.control)
                .foregroundColor(Theme.warning)
            Text("接管后，由此应用维持连接。退出应用后，旧服务不会自动恢复。")
                .font(Theme.Font.caption)
                .foregroundColor(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button("接管服务") { model.takeoverLegacyAgent() }
                    .buttonStyle(SecondaryButtonStyle(tint: Theme.warning))
                Button("重新检测") { model.refreshLegacyAgent() }
                    .buttonStyle(LinkButtonStyle())
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).fill(Theme.warning.opacity(0.1)))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).stroke(Theme.warning.opacity(0.4), lineWidth: 1))
    }

    // MARK: - Panels

    private func chooseDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "选择默认项目目录，不影响本机会话的显示范围"
        if panel.runModal() == .OK, let url = panel.url {
            model.workspacePath = url.path
        }
    }

    private func chooseKeyFile() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        panel.directoryURL = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".ssh", isDirectory: true)
        panel.message = "选择用于登录服务器的 SSH 私钥（不会复制私钥内容）"
        if panel.runModal() == .OK, let url = panel.url {
            model.deployTarget.identityFile = url.path
            model.clearFieldError(.deployKey)
        }
    }

    private func abbreviated(_ path: String) -> String {
        (path as NSString).abbreviatingWithTildeInPath
    }
}

enum Panels {
    @MainActor
    static func chooseEnvFile(model: AppModel) {
        guard model.canEditConfig else { return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        panel.message = "选择 .env 文件（已显示隐藏文件）"
        if panel.runModal() == .OK, let url = panel.url {
            model.importDotEnv(from: url)
        }
    }
}
