import AppKit
import PiRemoteCore
import SwiftUI

struct StatusPane: View {
    @ObservedObject var model: AppModel
    let windowVisible: Bool
    @State private var didCopyAddress = false
    @State private var copyResetTask: Task<Void, Never>?
    @State private var appeared = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let presentation = model.presentation
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(presentation.title)
                        .font(Theme.Font.hero)
                        .foregroundColor(Theme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(presentation.subtitle)
                        .font(Theme.Font.body)
                        .foregroundColor(Theme.textSecondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .animation(Motion.crossfade, value: presentation)
                .opacity(appeared ? 1 : 0)
                .offset(y: appeared || reduceMotion ? 0 : 6)

                if let error = model.errorMessage, model.phase == .error, !model.isDeployFlowVisible {
                    Notice(title: "原因", message: error, tone: .danger, actionTitle: "查看诊断") {
                        withAnimation(Motion.resolved(Motion.disclosure, reduceMotion: reduceMotion)) {
                            model.diagnosticsExpanded = true
                        }
                    }
                }

                VStack(spacing: 28) {
                    if model.isDeployFlowVisible {
                        DeployStageView(model: model)
                    } else {
                        ConnectionRouteView(
                            relayTitle: relayTitle,
                            relaySymbol: model.mode == .cloudflare ? "cloud" : "server.rack",
                            state: routeState,
                            windowVisible: windowVisible
                        )
                        PairingCodeView(
                            image: model.connectedIOSURL != nil ? model.qrImage : nil,
                            placeholderSymbol: placeholderSymbol,
                            placeholderTone: presentation.tone,
                            placeholderText: placeholderText
                        )
                        summary
                            .frame(maxWidth: 440)
                    }
                }
                .frame(maxWidth: .infinity)
                .opacity(appeared ? 1 : 0)
                .offset(y: appeared || reduceMotion ? 0 : 6)
            }
            .frame(maxWidth: 640, alignment: .leading)
            .padding(32)
            .frame(maxWidth: .infinity)
        }
        .onAppear {
            guard !appeared else { return }
            withAnimation(Motion.resolved(Motion.entrance, reduceMotion: reduceMotion)) { appeared = true }
        }
        .onChange(of: model.connectedIOSURL) { _ in
            copyResetTask?.cancel()
            didCopyAddress = false
        }
        .onDisappear { copyResetTask?.cancel() }
    }

    private var summary: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(addressTitle)
                    .font(Theme.Font.control)
                    .foregroundColor(model.phase == .recovering ? Theme.warning : Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(model.connectedIOSURL?.absoluteString ?? "")
                Text("运行于本机 · \(model.runtime.rawValue) · \((model.workspacePath as NSString).lastPathComponent)")
                    .font(Theme.Font.caption)
                    .foregroundColor(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(model.workspacePath)
                if model.connectedIOSURL != nil {
                    Text(model.mode == .cloudflare ? "临时隧道需扫码配对；仅有地址不能完成连接。" : "手动连接还需要连接密钥；复制的地址不含密钥。")
                        .font(Theme.Font.caption)
                        .foregroundColor(Theme.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            Button(didCopyAddress ? "已复制" : "复制地址") {
                if let url = model.connectedIOSURL { copyAddress(url) }
            }
            .buttonStyle(SecondaryButtonStyle())
            .frame(width: 96)
            .disabled(model.connectedIOSURL == nil)
            .accessibilityLabel(didCopyAddress ? "手机连接地址已复制" : "复制手机连接地址")
        }
    }

    // MARK: - Derived

    private var relayTitle: String {
        if model.mode == .cloudflare { return "临时隧道" }
        if model.serverSource == .deploy { return model.deployTarget.host.isEmpty ? "你的服务器" : model.deployTarget.host }
        return URL(string: model.serverURL)?.host ?? "中转服务"
    }

    private var routeState: RouteState {
        switch model.phase {
        case .idle, .stopping: return .idle
        case .connecting, .recovering: return .waiting
        case .connected: return model.connectedIOSURL != nil ? .done : .waiting
        case .error: return .broken
        }
    }

    private var addressTitle: String {
        if let url = model.connectedIOSURL { return url.host ?? url.absoluteString }
        if model.phase == .recovering { return "\(relayTitle) · 暂不可用" }
        if model.mode == .cloudflare { return "地址将在连接后生成" }
        return relayTitle
    }

    private var placeholderSymbol: String {
        switch model.phase {
        case .recovering: return "arrow.clockwise"
        case .error: return "exclamationmark.triangle"
        case .connecting, .connected: return "qrcode"
        default: return "iphone"
        }
    }

    private var placeholderText: String {
        switch model.phase {
        case .idle: return model.serverSource == .deploy && model.mode == .server ? "部署并连接成功后，连接码会显示在这里。" : "连接成功后，连接码会显示在这里。"
        case .connecting: return "服务器确认后即可扫码。"
        case .recovering: return "连接码已暂时隐藏，恢复后会重新显示。"
        case .stopping: return "连接码已移除。"
        case .error: return "处理连接问题后，重新生成连接码。"
        case .connected: return "正在准备连接码。"
        }
    }

    private func copyAddress(_ url: URL) {
        guard model.connectedIOSURL == url else { return }
        NSPasteboard.general.clearContents()
        guard NSPasteboard.general.setString(url.absoluteString, forType: .string) else { return }
        withAnimation(Motion.feedback) { didCopyAddress = true }
        copyResetTask?.cancel()
        copyResetTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if !Task.isCancelled { withAnimation(Motion.feedback) { didCopyAddress = false } }
        }
    }
}
