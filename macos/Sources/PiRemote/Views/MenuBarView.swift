import AppKit
import SwiftUI

struct MenuBarLabel: View {
    @ObservedObject var model: AppModel

    var body: some View {
        Image(systemName: symbol)
            .accessibilityLabel("Pi Remote \(model.presentation.badge)")
    }

    private var symbol: String {
        if model.deployStage.isWorking { return "arrow.up.circle" }
        switch model.phase {
        case .idle: return "bolt.horizontal.circle"
        case .connecting, .recovering, .stopping: return "arrow.triangle.2.circlepath.circle"
        case .connected: return "checkmark.circle.fill"
        case .error: return "exclamationmark.triangle.fill"
        }
    }
}

struct MenuBarView: View {
    @ObservedObject var model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let presentation = model.presentation
        Text("Pi Remote · \(presentation.badge)")
        Text("\(model.mode == .server ? "服务器" : "临时隧道") · \(model.runtime.rawValue)")
        Divider()
        Button("打开主窗口") {
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
        }
        if model.deployStage.locksConfig {
            Button("取消部署") { model.cancelDeploy() }
        } else if model.canConnect && !(model.mode == .server && model.serverSource == .deploy) {
            Button(model.phase == .error ? "重试连接" : "连接") { model.connect() }
        }
        switch model.phase {
        case .connecting: Button("取消连接") { model.disconnect() }
        case .connected: Button("断开连接") { model.disconnect() }
        case .recovering: Button("停止重连") { model.disconnect() }
        default: EmptyView()
        }
        if model.legacyAgentDetected {
            Button("接管后台连接服务") { model.takeoverLegacyAgent() }
        }
        Divider()
        ClaudeMenuSection(claude: model.claudeService) {
            model.activeService = .claude
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
        }
        Divider()
        Button("退出 Pi Remote") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}

private struct ClaudeMenuSection: View {
    @ObservedObject var claude: ClaudeServiceController
    let openClaude: () -> Void

    var body: some View {
        let presentation = ClaudePresentation.make(state: claude.state, mode: claude.configuration.mode)
        Text("Claude · \(presentation.badge)")
        Text(claude.configuration.mode == .cloudflare ? "临时隧道" : "仅本机")
        switch claude.state {
        case .idle, .failed:
            Button(claude.state == .idle ? "启动 Claude 服务" : "重新启动 Claude 服务") {
                Task { try? await claude.start() }
            }
        case .starting:
            Button("取消启动 Claude 服务") { Task { await claude.stop() } }
        case .running:
            Button("停止 Claude 服务") { Task { await claude.stop() } }
        case .stopping:
            Text("Claude 服务正在停止…")
        }
        Button("查看 Claude 服务…", action: openClaude)
    }
}
