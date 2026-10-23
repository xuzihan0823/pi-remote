import SwiftUI
import UIKit

/// 连接 Mac 上的 Claude 后端：扫描 / 粘贴 `claude-remote://setup?…` 配对码，或手动填写地址与 Token。
struct ClaudeConnectView: View {
    @Bindable var client: ClaudeClient
    var onSwitchBackend: () -> Void = {}
    /// 深链带来的配对码：进入页面即请求确认。
    var incomingCode: ClaudePairingCode? = nil

    @State private var showScanner = false
    @State private var confirmCode: ClaudePairingCode?
    @State private var scannedCode: ClaudePairingCode?
    @State private var manualAfterScanning = false
    @State private var showManual = false
    @State private var pasteError: String?

    var body: some View {
        ZStack {
            DesignTokens.Colors.background.ignoresSafeArea()

            VStack(spacing: 0) {
                HStack(alignment: .firstTextBaseline) {
                    HStack(spacing: 6) {
                        Text("Claude")
                            .font(DesignTokens.Fonts.sfProBold(29))
                            .foregroundColor(DesignTokens.Colors.textPrimary)
                        Text("Remote")
                            .font(DesignTokens.Fonts.sfProRegular(15))
                            .foregroundColor(DesignTokens.Colors.textSecondary)
                    }
                    Spacer()
                    Button("改用 Pi Relay", action: onSwitchBackend)
                        .font(DesignTokens.Fonts.notoRegular(13))
                        .foregroundColor(DesignTokens.Colors.textSecondary)
                        .accessibilityIdentifier("claude-switch-to-relay")
                }
                .padding(.horizontal, 24)
                .padding(.top, 16)

                Spacer()

                VStack(spacing: 10) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 44, weight: .light))
                        .foregroundColor(DesignTokens.Colors.accentGreen)
                        .accessibilityHidden(true)
                    Text("连接 Mac 上的 Claude")
                        .font(DesignTokens.Fonts.notoBold(26))
                        .foregroundColor(DesignTokens.Colors.textPrimary)
                    Text("在 Mac 助手的 Claude 页或 CLI 中显示配对二维码，\n扫码后即可浏览会话、继续对话和处理审批。")
                        .font(DesignTokens.Fonts.notoRegular(14))
                        .foregroundColor(DesignTokens.Colors.textSecondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 24)

                Spacer()

                VStack(spacing: 18) {
                    if let message = statusMessage {
                        Text(message)
                            .font(DesignTokens.Fonts.notoRegular(12))
                            .foregroundColor(statusIsError ? DesignTokens.Colors.warning : DesignTokens.Colors.accentGreen)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 28)
                    }

                    if client.hasSavedConnection, !client.isConnected {
                        Button("重新连接已配对的 Mac") { client.reconnectNow() }
                            .font(DesignTokens.Fonts.notoBold(14))
                            .foregroundColor(DesignTokens.Colors.accentGreen)
                            .disabled(client.phase == .connecting)
                    }

                    Button {
                        showScanner = true
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "qrcode.viewfinder")
                                .font(.system(size: 17, weight: .bold))
                            Text("扫码配对")
                                .font(DesignTokens.Fonts.notoBold(16))
                        }
                        .foregroundColor(DesignTokens.Colors.textOnGreen)
                        .frame(maxWidth: .infinity)
                        .frame(height: 55)
                        .background(DesignTokens.Colors.darkButton)
                        .clipShape(Capsule())
                    }
                    .disabled(client.phase == .connecting)
                    .padding(.horizontal, 28)
                    .accessibilityIdentifier("claude-scan")

                    HStack(spacing: 24) {
                        Button("粘贴配对码", action: pasteCode)
                        Button("手动连接") { showManual = true }
                    }
                    .font(DesignTokens.Fonts.notoRegular(14))
                    .foregroundColor(DesignTokens.Colors.accentGreen)

                    if let pasteError {
                        Text(pasteError)
                            .font(DesignTokens.Fonts.notoRegular(12))
                            .foregroundColor(DesignTokens.Colors.warning)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 28)
                    }

                    HStack(spacing: 6) {
                        Image(systemName: "lock.fill").font(.system(size: 10))
                        Text("Token 只保存在本机钥匙串；明文 http 仅限局域网 / Tailscale")
                            .font(DesignTokens.Fonts.notoRegular(11))
                    }
                    .foregroundColor(DesignTokens.Colors.textSecondary)
                    .padding(.bottom, 16)
                }
            }
        }
        .fullScreenCover(isPresented: $showScanner, onDismiss: {
            // 等扫码页完全关掉再弹确认，避免与转场冲突
            if let scannedCode { confirmCode = scannedCode }
            scannedCode = nil
            if manualAfterScanning { showManual = true }
            manualAfterScanning = false
        }) {
            ConnectionScannerView(
                deviceName: "",
                onScanned: { _ in },
                onManualConnection: {
                    manualAfterScanning = true
                    showScanner = false
                },
                payloadHandler: { payload in
                    scannedCode = try ClaudePairing.parse(payload)
                    showScanner = false
                },
                title: "扫描 Claude 配对码"
            )
        }
        .sheet(isPresented: $showManual) {
            ClaudeManualConnectSheet(client: client)
        }
        .alert("连接这台 Mac？", isPresented: Binding(
            get: { confirmCode != nil }, set: { if !$0 { confirmCode = nil } }
        ), presenting: confirmCode) { code in
            Button("连接") {
                confirmCode = nil
                Task { await client.pair(with: code) }
            }
            Button("取消", role: .cancel) { confirmCode = nil }
        } message: { code in
            Text("将依次尝试：\n" + code.bases.map { $0.absoluteString }.joined(separator: "\n"))
        }
        .onAppear {
            if let incomingCode { confirmCode = incomingCode }
        }
        .onChange(of: incomingCode) { _, code in
            if let code { confirmCode = code }
        }
    }

    private var statusMessage: String? {
        switch client.phase {
        case .connecting: return "正在连接…"
        case .reconnecting(let seconds): return "连接中断，\(seconds) 秒后重试"
        case .failed(let message): return message
        case .connected, .idle: return nil
        }
    }

    private var statusIsError: Bool {
        if case .failed = client.phase { return true }
        return false
    }

    private func pasteCode() {
        guard let text = UIPasteboard.general.string, !text.isEmpty else {
            pasteError = "剪贴板里没有配对码"
            return
        }
        do {
            confirmCode = try ClaudePairing.parse(text)
            pasteError = nil
        } catch {
            pasteError = error.localizedDescription
        }
    }
}

/// 手动填写 Claude 后端地址（http://Tailscale或局域网IP:8788，或 https://…）与 Token。
struct ClaudeManualConnectSheet: View {
    @Bindable var client: ClaudeClient
    @Environment(\.dismiss) private var dismiss
    @State private var base = ""
    @State private var token = ""
    @State private var connecting = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://100.x.y.z:8788", text: $base)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    SecureField("BRIDGE_TOKEN", text: $token)
                } header: {
                    Text("Claude 后端")
                } footer: {
                    Text("明文 http:// 只允许本机、局域网、.local 与 Tailscale 地址；公网请使用 https://。")
                }

                if case .failed(let message) = client.phase {
                    Section { Text(message).foregroundColor(DesignTokens.Colors.warning) }
                }

                Section {
                    Button(connecting ? "正在连接…" : "连接") {
                        connecting = true
                        Task {
                            let ok = await client.connect(manualBase: base, token: token)
                            connecting = false
                            if ok { dismiss() }
                        }
                    }
                    .disabled(connecting || base.isEmpty || token.isEmpty)
                }
            }
            .navigationTitle("手动连接")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
            }
            .onAppear {
                if let connection = client.connection { base = connection.baseURL.absoluteString }
            }
        }
    }
}
