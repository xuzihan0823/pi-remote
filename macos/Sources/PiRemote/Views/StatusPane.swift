import AppKit
import PiRemoteCore
import SwiftUI

struct StatusPane: View {
    @ObservedObject var model: AppModel
    let windowVisible: Bool
    @State private var appeared = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let presentation = model.presentation
        GeometryReader { geo in
            ScrollView {
                Group {
                    if model.isDeployFlowVisible {
                        VStack(alignment: .leading, spacing: 28) {
                            header(presentation)
                            errorNotice
                            DeployStageView(model: model)
                                .frame(maxWidth: .infinity)
                                .opacity(appeared ? 1 : 0)
                                .offset(y: appeared || reduceMotion ? 0 : 6)
                        }
                        .frame(maxWidth: 640, alignment: .leading)
                    } else {
                        // Side by side so the full code fits the 900×640 minimum window without scrolling.
                        HStack(alignment: .center, spacing: 40) {
                            VStack(alignment: .leading, spacing: 28) {
                                header(presentation)
                                errorNotice
                                Group {
                                    ConnectionRouteView(
                                        relayTitle: relayTitle,
                                        relaySymbol: model.mode == .cloudflare ? "cloud" : "server.rack",
                                        state: routeState,
                                        windowVisible: windowVisible
                                    )
                                }
                                .opacity(appeared ? 1 : 0)
                                .offset(y: appeared || reduceMotion ? 0 : 6)
                            }
                            .frame(maxWidth: 440, alignment: .leading)
                            PairingCodeView(
                                image: model.connectedIOSURL != nil ? model.qrImage : nil,
                                placeholderSymbol: placeholderSymbol,
                                placeholderTone: presentation.tone,
                                placeholderText: placeholderText
                            )
                            .frame(width: 360)
                            .opacity(appeared ? 1 : 0)
                            .offset(y: appeared || reduceMotion ? 0 : 6)
                        }
                    }
                }
                .padding(32)
                .frame(maxWidth: .infinity, minHeight: geo.size.height)
            }
            .scrollIndicators(.hidden)
        }
        .onAppear {
            guard !appeared else { return }
            withAnimation(Motion.resolved(Motion.entrance, reduceMotion: reduceMotion)) { appeared = true }
        }
    }

    private func header(_ presentation: ConnectionPresentation) -> some View {
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
    }

    @ViewBuilder
    private var errorNotice: some View {
        if let error = model.errorMessage, model.phase == .error, !model.isDeployFlowVisible {
            Notice(title: "原因", message: error, tone: .danger, actionTitle: "查看诊断") {
                withAnimation(Motion.resolved(Motion.disclosure, reduceMotion: reduceMotion)) {
                    model.diagnosticsExpanded = true
                }
            }
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
}
