import SwiftUI

public struct ConnectView: View {
    @Bindable var client: RelayClient
    public var onConnected: () -> Void = {}

    @State private var activeSheet: Sheet?
    @State private var showScanner = false
    @State private var sheetAfterScanning: Sheet?

    private enum Sheet: Identifiable {
        case configuration(ConnectionConfig?)
        case help

        var id: String {
            switch self {
            case .configuration: return "configuration"
            case .help: return "help"
            }
        }
    }

    public init(client: RelayClient, onConnected: @escaping () -> Void = {}) {
        self.client = client
        self.onConnected = onConnected
    }

    public var body: some View {
        ZStack {
            DesignTokens.Colors.background
                .ignoresSafeArea()

            RadialGradient(
                colors: [DesignTokens.Colors.surface.opacity(0.8), DesignTokens.Colors.background.opacity(0.1)],
                center: .top,
                startRadius: 40,
                endRadius: 360
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                HStack(alignment: .firstTextBaseline) {
                    HStack(spacing: 6) {
                        Text("pi")
                            .font(DesignTokens.Fonts.sfProBold(29))
                            .foregroundColor(DesignTokens.Colors.textPrimary)
                        Text("Remote")
                            .font(DesignTokens.Fonts.sfProRegular(15))
                            .foregroundColor(DesignTokens.Colors.textSecondary)
                    }

                    Spacer()

                    Button(action: { activeSheet = .help }) {
                        Text("帮助")
                            .font(DesignTokens.Fonts.notoRegular(13))
                            .foregroundColor(DesignTokens.Colors.textSecondary)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 16)

                Spacer()

                ZStack {
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [DesignTokens.Colors.surface.opacity(0.85), DesignTokens.Colors.glassCard.opacity(0.65)],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .frame(width: 233, height: 165)
                        .overlay(
                            RoundedRectangle(cornerRadius: 24, style: .continuous)
                                .stroke(DesignTokens.Colors.surface.opacity(0.9), lineWidth: 1)
                        )
                        .shadow(color: Color.black.opacity(0.04), radius: 12, x: 0, y: 4)

                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text("pi")
                                .font(DesignTokens.Fonts.sfProBold(18))
                                .foregroundColor(DesignTokens.Colors.accentGreen)
                            Spacer()
                        }

                        RoundedRectangle(cornerRadius: 2)
                            .fill(Color(light: 0xAFC4B5, dark: 0x4A5E51))
                            .frame(width: 108, height: 5)
                        RoundedRectangle(cornerRadius: 2)
                            .fill(Color(light: 0xC3D1C4, dark: 0x3E4D43))
                            .frame(width: 87, height: 5)
                        RoundedRectangle(cornerRadius: 2)
                            .fill(Color(light: 0xD5DFD2, dark: 0x343F38))
                            .frame(width: 116, height: 5)
                    }
                    .padding(24)
                    .frame(width: 217, height: 146)
                }

                Spacer()

                VStack(spacing: 6) {
                    Text("工作在 Mac 上，")
                        .font(DesignTokens.Fonts.notoBold(29))
                        .foregroundColor(DesignTokens.Colors.textPrimary)
                    Text("灵感随你出发。")
                        .font(DesignTokens.Fonts.notoBold(29))
                        .foregroundColor(DesignTokens.Colors.textPrimary)

                    Spacer().frame(height: 14)

                    Text("连接本地 pi，随时继续你的任务。")
                        .font(DesignTokens.Fonts.notoRegular(14))
                        .foregroundColor(DesignTokens.Colors.textSecondary)
                    Text("项目、模型和上下文，都留在 Mac。")
                        .font(DesignTokens.Fonts.notoRegular(14))
                        .foregroundColor(DesignTokens.Colors.textSecondary)
                }
                .multilineTextAlignment(.center)

                Spacer()

                VStack(spacing: 20) {
                    if let message = statusMessage {
                        Text(message)
                            .font(DesignTokens.Fonts.notoRegular(12))
                            .foregroundColor(statusIsError ? DesignTokens.Colors.warning : DesignTokens.Colors.accentGreen)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 28)
                    }

                    Button {
                        sheetAfterScanning = nil
                        showScanner = true
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "qrcode.viewfinder")
                                .font(.system(size: 17, weight: .bold))
                            Text("扫码连接 Mac")
                                .font(DesignTokens.Fonts.notoBold(16))
                        }
                        .foregroundColor(DesignTokens.Colors.textOnGreen)
                        .frame(maxWidth: .infinity)
                        .frame(height: 55)
                        .background(DesignTokens.Colors.darkButton)
                        .clipShape(Capsule())
                    }
                    .disabled(client.isConnecting)
                    .padding(.horizontal, 28)

                    Button(action: { activeSheet = .configuration(nil) }) {
                        Text("手动连接")
                            .font(DesignTokens.Fonts.notoRegular(14))
                            .foregroundColor(DesignTokens.Colors.accentGreen)
                    }

                    HStack(spacing: 6) {
                        Image(systemName: "lock.fill")
                            .font(.system(size: 10))
                            .foregroundColor(DesignTokens.Colors.textSecondary)
                        Text("仅已配对的设备可以访问")
                            .font(DesignTokens.Fonts.notoRegular(11))
                            .foregroundColor(DesignTokens.Colors.textSecondary)
                    }
                    .padding(.bottom, 16)
                }
            }
        }
        .sheet(item: $activeSheet) { sheet in
            switch sheet {
            case .help:
                ConnectionHelpView()
            case .configuration(let config):
                ConnectionConfigSheet(client: client, initialConfig: config) {
                    activeSheet = nil
                    if client.isConnected { onConnected() }
                }
            }
        }
        .fullScreenCover(isPresented: $showScanner, onDismiss: {
            activeSheet = sheetAfterScanning
            sheetAfterScanning = nil
        }) {
            ConnectionScannerView(
                deviceName: client.config.deviceName,
                onScanned: { config in
                    sheetAfterScanning = .configuration(config)
                    showScanner = false
                },
                onManualConnection: {
                    sheetAfterScanning = .configuration(nil)
                    showScanner = false
                }
            )
        }
    }

    private var statusMessage: String? {
        switch client.state {
        case .connecting:
            return "正在连接…"
        case .reconnecting(let seconds):
            return "连接中断，\(seconds) 秒后重试"
        case .failed(let message):
            return message
        case .connected, .idle:
            return nil
        }
    }

    private var statusIsError: Bool {
        if case .failed = client.state { return true }
        return false
    }
}

struct ConnectionConfigSheet: View {
    @Bindable var client: RelayClient
    var initialConfig: ConnectionConfig? = nil
    var onDismiss: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var serverUrl = ""
    @State private var token = ""
    @State private var deviceName = ""
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("wss://your-server/ws/ios", text: $serverUrl)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    SecureField("Relay Token", text: $token)
                    TextField("这台设备的名字", text: $deviceName)
                } header: {
                    Text("Relay 服务器")
                } footer: {
                    if initialConfig != nil {
                        Text("已识别连接信息，请确认服务器地址后再连接。")
                    }
                }

                if let errorText {
                    Section {
                        Text(errorText)
                            .foregroundColor(DesignTokens.Colors.warning)
                    }
                }

                Section {
                    Button(client.isConnecting ? "正在连接…" : "连接") {
                        connect()
                    }
                    .disabled(client.isConnecting || serverUrl.isEmpty)

                    if client.isConnected {
                        Button("断开连接", role: .destructive) {
                            client.disconnect()
                            dismiss()
                        }
                    }
                }
            }
            .navigationTitle(initialConfig == nil ? "连接你的 Mac" : "确认连接")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
            .onAppear {
                let config = initialConfig ?? client.config
                serverUrl = config.serverUrl
                token = config.token
                deviceName = config.deviceName
            }
            .onChange(of: client.state) { _, state in
                switch state {
                case .connected:
                    onDismiss()
                    dismiss()
                case .failed(let message):
                    errorText = message
                default:
                    errorText = nil
                }
            }
        }
    }

    private func connect() {
        let trimmedUrl = serverUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmedUrl),
              let scheme = url.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss" else {
            errorText = "服务器地址需要以 ws:// 或 wss:// 开头"
            return
        }
        client.connect(
            config: ConnectionConfig(
                serverUrl: trimmedUrl,
                token: token.trimmingCharacters(in: .whitespacesAndNewlines),
                deviceName: deviceName.isEmpty ? "iPhone" : deviceName
            )
        )
    }
}

#if DEBUG
#Preview {
    ConnectView(client: RelayClient.shared)
}
#endif
