import SwiftUI

public struct NewSessionView: View {
    @Bindable var client: RelayClient
    public var onBackTapped: () -> Void = {}
    public var onStarted: (String) -> Void = { _ in }

    @State private var promptText = ""
    @State private var cwd = ""
    @State private var mode: SessionStartMode = .terminal
    @State private var showProjectField = false

    public init(
        client: RelayClient,
        onBackTapped: @escaping () -> Void = {},
        onStarted: @escaping (String) -> Void = { _ in }
    ) {
        self.client = client
        self.onBackTapped = onBackTapped
        self.onStarted = onStarted
    }

    public var body: some View {
        ZStack {
            DesignTokens.Colors.background
                .ignoresSafeArea()

            VStack(spacing: 0) {
                HStack {
                    Button {
                        client.cancelSessionCreation()
                        onBackTapped()
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(DesignTokens.Colors.textPrimary)
                            .frame(width: 44, height: 44)
                            .glassCircle()
                    }

                    Spacer()

                    HStack(spacing: 6) {
                        Image(systemName: "laptopcomputer")
                            .font(.system(size: 13))
                            .foregroundColor(DesignTokens.Colors.textPrimary)
                        Text(client.agentName ?? "MacBook Pro")
                            .font(DesignTokens.Fonts.sfProRegular(13))
                            .foregroundColor(DesignTokens.Colors.textPrimary)
                        Circle()
                            .fill(client.agentConnected ? DesignTokens.Colors.accentGreen : DesignTokens.Colors.textPlaceholder)
                            .frame(width: 6, height: 6)
                    }
                    .padding(.horizontal, 16)
                    .frame(height: 38)
                    .glassCapsule()

                    Spacer()

                    Color.clear.frame(width: 44, height: 44)
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)

                Spacer()

                VStack(spacing: 12) {
                    ZStack {
                        RadialGradient(
                            colors: [DesignTokens.Colors.accentGreen.opacity(0.12), Color.clear],
                            center: .center,
                            startRadius: 20,
                            endRadius: 150
                        )
                        .frame(width: 300, height: 180)

                        Text("pi")
                            .font(DesignTokens.Fonts.sfProBold(30))
                            .foregroundColor(DesignTokens.Colors.textPrimary)
                            .frame(width: 65, height: 65)
                            .glassCircle()
                    }

                    Text(client.agentConnected ? "想从哪里开始？" : "Mac 上的 pi 尚未连接")
                        .font(DesignTokens.Fonts.notoBold(28))
                        .foregroundColor(DesignTokens.Colors.textPrimary)

                    Text(client.agentConnected
                         ? (mode == .terminal ? "手机与 Mac 终端共用同一会话。" : "会话在 Mac 后台运行。")
                         : "先在 Mac 上启动 agent，再开始任务。")
                        .font(DesignTokens.Fonts.notoRegular(14))
                        .foregroundColor(DesignTokens.Colors.textSecondary)

                    Picker("会话类型", selection: $mode) {
                        Text("Mac共享会话").tag(SessionStartMode.terminal)
                        Text("后台会话").tag(SessionStartMode.rpc)
                    }
                    .pickerStyle(.segmented)
                    .tint(DesignTokens.Colors.accentGreen)
                    .padding(.horizontal, 40)
                    .disabled(client.isCreatingSession)

                    Button(action: { showProjectField.toggle() }) {
                        HStack(spacing: 6) {
                            Image(systemName: "folder")
                                .font(.system(size: 13))
                                .foregroundColor(DesignTokens.Colors.textPrimary)
                            Text(cwd.isEmpty ? "选择项目" : cwd)
                                .font(DesignTokens.Fonts.notoRegular(13))
                                .foregroundColor(DesignTokens.Colors.textPrimary)
                            Image(systemName: "chevron.down")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundColor(DesignTokens.Colors.textPrimary)
                        }
                        .padding(.horizontal, 18)
                        .frame(height: 36)
                        .glassCapsule(isSelected: !cwd.isEmpty)
                    }
                    .disabled(client.isCreatingSession)
                    .padding(.top, 8)

                    if showProjectField {
                        TextField("项目目录（相对工作区，留空用默认）", text: $cwd)
                            .font(DesignTokens.Fonts.sfProRegular(13))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .padding(.horizontal, 14)
                            .frame(height: 40)
                            .background(DesignTokens.Colors.glassMediumAlt)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .padding(.horizontal, 40)
                            .disabled(client.isCreatingSession)
                    }
                }

                Spacer()

                VStack(spacing: 10) {
                    suggestionCard(
                        title: "帮我理解这个项目",
                        subtitle: "梳理结构与关键逻辑",
                        icon: "doc.text.magnifyingglass"
                    ) {
                        promptText = "帮我理解这个项目，梳理结构与关键逻辑"
                    }

                    suggestionCard(
                        title: "修复一个问题",
                        subtitle: "描述现象，一起找到原因",
                        icon: "wrench.and.screwdriver"
                    ) {
                        promptText = "我想修复一个问题："
                    }
                }
                .disabled(client.isCreatingSession)
                .padding(.horizontal, 28)
                .padding(.bottom, 24)

                if let error = client.lastError {
                    Text(error)
                        .font(DesignTokens.Fonts.notoRegular(12))
                        .foregroundColor(DesignTokens.Colors.warning)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 28)
                        .padding(.bottom, 8)
                }

                VStack(alignment: .leading, spacing: 6) {
                    if !cwd.isEmpty {
                        HStack(spacing: 6) {
                            Image(systemName: "folder")
                                .font(.system(size: 12))
                                .foregroundColor(DesignTokens.Colors.textPrimary)
                            Text(cwd)
                                .font(DesignTokens.Fonts.sfProRegular(13))
                                .foregroundColor(DesignTokens.Colors.textPrimary)
                        }
                        .padding(.horizontal, 16)
                        .frame(height: 36)
                        .glassCapsule(isSelected: true)
                    }

                    HStack(alignment: .top) {
                        TextField("描述你想完成的工作…", text: $promptText, axis: .vertical)
                            .font(DesignTokens.Fonts.notoRegular(14))
                            .foregroundColor(DesignTokens.Colors.textPrimary)
                            .lineLimit(2)
                            .disabled(client.isCreatingSession)

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

                    HStack {
                        Image(systemName: "paperclip")
                            .font(.system(size: 12))
                            .foregroundColor(DesignTokens.Colors.textSecondary)

                        Text(client.isCreatingSession ? "正在创建会话…" :
                             (mode == .terminal ? "确认和选择请在 Mac 终端完成" : "在你的 Mac 上执行"))
                            .font(DesignTokens.Fonts.notoRegular(11))
                            .foregroundColor(DesignTokens.Colors.textSecondary)

                        Spacer()
                    }
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 14)
                .glassCard(cornerRadius: 24)
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            }
        }
        .onDisappear { client.cancelSessionCreation() }
    }

    private var canSend: Bool {
        !promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            client.isConnected && client.agentConnected && !client.isCreatingSession
    }

    private func send() {
        let text = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend else { return }
        client.startNewSession(prompt: text, cwd: cwd.isEmpty ? nil : cwd, mode: mode) { sessionId in
            onStarted(sessionId)
        }
    }

    private func suggestionCard(title: String, subtitle: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 16))
                    .foregroundColor(DesignTokens.Colors.textPrimary)

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(DesignTokens.Fonts.notoRegular(14))
                        .foregroundColor(DesignTokens.Colors.textPrimary)
                    Text(subtitle)
                        .font(DesignTokens.Fonts.notoRegular(11))
                        .foregroundColor(DesignTokens.Colors.textSecondary)
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(DesignTokens.Colors.textSecondary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(DesignTokens.Colors.glassLight)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

#if DEBUG
#Preview {
    NewSessionView(client: RelayClient.shared)
}
#endif
