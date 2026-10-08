import AppKit
import PiRemoteCore
import SwiftUI

struct ClaudeStatusPane: View {
    @ObservedObject var claude: ClaudeServiceController
    let windowVisible: Bool
    let showDiagnostics: () -> Void
    @State private var qrImage: NSImage?
    @State private var pairError: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var mode: ClaudeServiceMode { claude.configuration.mode }
    private var isTunnel: Bool { mode == .cloudflare }

    var body: some View {
        let presentation = ClaudePresentation.make(state: claude.state, mode: mode)
        GeometryReader { geo in
            ScrollView {
                HStack(alignment: .center, spacing: 40) {
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

                        if let message = claude.state.failureMessage {
                            Notice(title: "原因", message: message, tone: .danger, actionTitle: "查看诊断", action: showDiagnostics)
                        } else if let pairError, claude.state == .running, isTunnel {
                            Notice(title: "连接码暂不可用", message: pairError, tone: .warning)
                        }

                        ConnectionRouteView(
                            relayTitle: isTunnel ? "临时隧道" : "Claude 后端",
                            relaySymbol: isTunnel ? "cloud" : "terminal",
                            state: routeState,
                            windowVisible: windowVisible
                        )
                    }
                    .frame(maxWidth: 440, alignment: .leading)
                    PairingCodeView(
                        image: claude.state == .running && isTunnel ? qrImage : nil,
                        placeholderSymbol: placeholderSymbol,
                        placeholderTone: presentation.tone,
                        placeholderText: placeholderText
                    )
                    .frame(width: 360)
                }
                .padding(32)
                .frame(maxWidth: .infinity, minHeight: geo.size.height)
            }
            .scrollIndicators(.hidden)
        }
        .task(id: PairKey(state: claude.state, publicURL: claude.publicURL, mode: mode)) { await loadPairCode() }
        .onChange(of: claude.state) { state in
            ContentView.announce("Claude \(ClaudePresentation.make(state: state, mode: mode).badge)")
        }
    }

    private struct PairKey: Equatable {
        let state: ClaudeServiceController.State
        let publicURL: URL?
        let mode: ClaudeServiceMode
    }

    /// The code is cleared first on every state change, so a stale code can never stay on screen.
    private func loadPairCode() async {
        qrImage = nil
        pairError = nil
        guard claude.state == .running, isTunnel else { return }
        do {
            let info = try await pairInfo()
            guard !Task.isCancelled, claude.state == .running else { return }
            guard let image = ConnectionQRCode.image(from: info.setupLink) else {
                pairError = "二维码生成失败"
                return
            }
            qrImage = NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
        } catch {
            guard !Task.isCancelled else { return }
            pairError = error.localizedDescription
        }
    }

    private func pairInfo() async throws -> ClaudePairInfo {
        #if DEBUG
        if let fixture = claude.fixturePairInfo { return fixture }
        #endif
        return try await claude.readPairInfo()
    }

    // MARK: - Derived

    private var routeState: RouteState {
        switch claude.state {
        case .idle, .stopping: return .idle
        case .starting: return .waiting
        case .running: return .done
        case .failed: return .broken
        }
    }

    private var placeholderSymbol: String {
        switch claude.state {
        case .failed: return "exclamationmark.triangle"
        case .starting: return "qrcode"
        case .running: return isTunnel ? "qrcode" : "lock.laptopcomputer"
        default: return "iphone"
        }
    }

    private var placeholderText: String {
        switch claude.state {
        case .idle: return isTunnel ? "启动成功后，连接码会显示在这里。" : "仅本机模式不生成手机连接码。"
        case .starting: return isTunnel ? "临时地址确认后即可扫码。" : "仅本机模式不生成手机连接码。"
        case .running: return isTunnel ? "正在准备连接码。" : "仅本机模式不生成手机连接码；需要手机访问请改用临时隧道。"
        case .stopping: return "连接码已移除。"
        case .failed: return "处理问题后，重新启动服务。"
        }
    }
}

struct ClaudeDiagnosticsPane: View {
    @ObservedObject var claude: ClaudeServiceController
    @Binding var expanded: Bool
    @State private var copied = false
    @State private var copyTask: Task<Void, Never>?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Button {
                    withAnimation(Motion.resolved(Motion.disclosure, reduceMotion: reduceMotion)) { expanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                        Text("Claude 诊断")
                            .font(Theme.Font.caption.weight(.semibold))
                        if claude.state.failureMessage != nil {
                            Circle().fill(Theme.danger).frame(width: 6, height: 6)
                                .accessibilityLabel("有错误")
                        }
                    }
                    .foregroundColor(Theme.textPrimary)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(expanded ? "收起诊断" : "展开诊断")
                if !expanded, let last = claude.logs.last {
                    Text(last)
                        .font(Theme.Font.mono)
                        .foregroundColor(Theme.textSecondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if expanded {
                    Button(copied ? "已复制" : "复制诊断") { copyLogs() }
                        .buttonStyle(LinkButtonStyle())
                        .frame(minWidth: 56, alignment: .trailing)
                        .disabled(claude.logs.isEmpty)
                }
            }
            .padding(.horizontal, 16)
            .frame(height: DiagnosticsPane.collapsedHeight)
            if expanded {
                Divider().overlay(Theme.border)
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            if claude.logs.isEmpty {
                                Text("暂无运行记录").foregroundColor(Theme.textSecondary)
                            }
                            ForEach(Array(claude.logs.enumerated()), id: \.offset) { _, line in
                                Text(line)
                                    .foregroundColor(Theme.textPrimary)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            Color.clear.frame(height: 1).id("bottom")
                        }
                        .font(Theme.Font.mono)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                    }
                    .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
                    .onChange(of: claude.logs.count) { _ in proxy.scrollTo("bottom", anchor: .bottom) }
                }
                .transition(.opacity)
            }
        }
        .frame(height: expanded ? DiagnosticsPane.expandedHeight : DiagnosticsPane.collapsedHeight)
        .background(Theme.sidebar)
        .clipped()
        .onDisappear { copyTask?.cancel() }
    }

    /// Controller logs are already redacted of the service token when appended.
    private func copyLogs() {
        NSPasteboard.general.clearContents()
        guard NSPasteboard.general.setString(claude.logs.joined(separator: "\n"), forType: .string) else { return }
        withAnimation(Motion.feedback) { copied = true }
        copyTask?.cancel()
        copyTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if !Task.isCancelled { withAnimation(Motion.feedback) { copied = false } }
        }
    }
}
