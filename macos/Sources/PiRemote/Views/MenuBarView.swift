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
        Button("退出 Pi Remote") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}
