import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    #if DEBUG
    let model = SnapshotRenderer.isActive ? SnapshotRenderer.fixtureModel() : AppModel()
    #else
    let model = AppModel()
    #endif

    func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGPIPE, SIG_IGN)
        #if DEBUG
        if SnapshotRenderer.isActive {
            SnapshotRenderer.renderAll()
            exit(0)
        }
        #endif
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if model.isShuttingDown { return .terminateNow }
        Task { @MainActor in
            await self.model.shutdown()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

@main
struct PiRemoteApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Window("Pi Remote", id: "main") {
            ContentView(model: appDelegate.model)
                .frame(minWidth: 900, minHeight: 640)
        }
        .defaultSize(width: 1040, height: 720)
        .commands {
            CommandGroup(after: .newItem) {
                Button("从 .env 导入…") { Panels.chooseEnvFile(model: appDelegate.model) }
                    .keyboardShortcut("o", modifiers: .command)
                    .disabled(!appDelegate.model.canEditConfig)
            }
            CommandGroup(after: .sidebar) {
                Button(appDelegate.model.diagnosticsExpanded ? "收起诊断" : "展开诊断") {
                    appDelegate.model.diagnosticsExpanded.toggle()
                }
                .keyboardShortcut("l", modifiers: .command)
            }
        }

        MenuBarExtra {
            MenuBarView(model: appDelegate.model)
        } label: {
            MenuBarLabel(model: appDelegate.model)
        }
    }
}
