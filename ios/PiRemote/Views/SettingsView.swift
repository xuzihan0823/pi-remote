import SwiftUI

struct SettingsView: View {
    @Bindable var client: RelayClient
    var onDeviceSwitched: () -> Void = {}
    var onDisconnectTapped: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @AppStorage(AppAppearance.storageKey) private var appearance = AppAppearance.system
    @State private var devices = ConnectionConfig.savedDevices()
    @State private var showConfiguration = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    infoRow(label: "Relay", value: client.isConnected ? "已连接" : "未连接")
                    infoRow(label: "Mac 上的 pi", value: client.agentName ?? (client.agentConnected ? "已连接" : "未连接"))
                    infoRow(label: "本机设备名", value: client.config.deviceName)
                    infoRow(label: "会话数", value: "\(client.sessions.count)")
                    Button("刷新会话") { client.refreshSessions() }
                        .disabled(!client.isConnected)
                } header: {
                    Text("当前设备")
                }

                Section {
                    ForEach(devices, id: \.serverUrl) { device in
                        deviceRow(device)
                    }
                    .onDelete(perform: forgetDevices)

                    Button("添加设备") { showConfiguration = true }
                } header: {
                    Text("切换设备")
                } footer: {
                    Text("连接过的 Mac 会保存在这里，左滑可以移除。")
                }

                Section {
                    Picker("外观", selection: $appearance) {
                        ForEach(AppAppearance.allCases) { option in
                            Text(option.title).tag(option)
                        }
                    }
                    .pickerStyle(.segmented)
                } header: {
                    Text("外观")
                }

                if client.isConnected {
                    Section {
                        Button("断开连接", role: .destructive) {
                            dismiss()
                            onDisconnectTapped()
                        }
                    }
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .sheet(isPresented: $showConfiguration, onDismiss: {
                devices = ConnectionConfig.savedDevices()
            }) {
                ConnectionConfigSheet(client: client) { onDeviceSwitched() }
            }
        }
    }

    private func deviceRow(_ device: ConnectionConfig) -> some View {
        let isCurrent = device.serverUrl == client.config.serverUrl
        return Button {
            switchTo(device)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "laptopcomputer")
                    .foregroundColor(DesignTokens.Colors.textSecondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(URL(string: device.serverUrl)?.host() ?? device.serverUrl)
                        .font(DesignTokens.Fonts.sfProRegular(15))
                        .foregroundColor(DesignTokens.Colors.textPrimary)
                        .lineLimit(1)
                    Text(isCurrent ? statusText : device.serverUrl)
                        .font(DesignTokens.Fonts.notoRegular(12))
                        .foregroundColor(DesignTokens.Colors.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer()
                if isCurrent {
                    Image(systemName: "checkmark")
                        .foregroundColor(DesignTokens.Colors.accentGreen)
                }
            }
        }
        .disabled(client.isConnecting)
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
    }

    private var statusText: String {
        switch client.state {
        case .connected: return "当前 · 已连接"
        case .connecting, .reconnecting: return "当前 · 正在连接…"
        case .failed: return "当前 · 连接失败"
        case .idle: return "当前 · 未连接"
        }
    }

    private func switchTo(_ device: ConnectionConfig) {
        if device.serverUrl == client.config.serverUrl && client.isConnected { return }
        // 先断开，清掉上一台 Mac 的会话列表和当前会话，避免串到新设备
        client.disconnect()
        client.connect(config: ConnectionConfig(
            serverUrl: device.serverUrl,
            token: device.token,
            deviceName: client.config.deviceName
        ))
        devices = ConnectionConfig.savedDevices()
        onDeviceSwitched()
    }

    private func forgetDevices(at offsets: IndexSet) {
        for index in offsets {
            ConnectionConfig.forgetDevice(serverUrl: devices[index].serverUrl)
        }
        devices = ConnectionConfig.savedDevices()
    }

    private func infoRow(label: String, value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .foregroundColor(DesignTokens.Colors.textSecondary)
            Spacer(minLength: 16)
            Text(value)
                .foregroundColor(DesignTokens.Colors.textPrimary)
                .multilineTextAlignment(.trailing)
        }
        .font(DesignTokens.Fonts.notoRegular(14))
    }
}

extension AppAppearance {
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}
