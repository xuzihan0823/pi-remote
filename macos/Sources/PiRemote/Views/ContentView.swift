import AppKit
import SwiftUI

struct ContentView: View {
    @ObservedObject var model: AppModel
    @State private var windowVisible = true
    @State private var settingsPresented = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let presentation = model.presentation
        VStack(spacing: 0) {
            topBar(presentation)
            Divider().overlay(Theme.border)
            Group {
                if model.activeService == .pi {
                    StatusPane(model: model, windowVisible: windowVisible)
                } else {
                    ClaudeStatusPane(claude: model.claudeService, windowVisible: windowVisible) {
                        withAnimation(Motion.resolved(Motion.disclosure, reduceMotion: reduceMotion)) {
                            model.diagnosticsExpanded = true
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.canvas)
            .sheet(isPresented: $settingsPresented) {
                SettingsSheet(model: model) { settingsPresented = false }
            }
            Divider().overlay(Theme.border)
            serviceBar
        }
        .background(Theme.canvas)
        .background(WindowVisibilityReader(isVisible: $windowVisible))
        .onAppear { model.onAppear() }
        .sheet(isPresented: $model.diagnosticsExpanded) {
            Group {
                if model.activeService == .pi {
                    DiagnosticsPane(model: model)
                } else {
                    ClaudeDiagnosticsPane(claude: model.claudeService, expanded: $model.diagnosticsExpanded)
                }
            }
            .frame(width: 720)
        }
        .onChange(of: presentation.badge) { badge in
            Self.announce("Pi Remote \(badge)")
        }
    }

    static func announce(_ text: String) {
        NSAccessibility.post(
            element: NSApp as Any,
            notification: .announcementRequested,
            userInfo: [.announcement: text, .priority: NSAccessibilityPriorityLevel.medium.rawValue]
        )
    }

    private func topBar(_ presentation: ConnectionPresentation) -> some View {
        HStack(spacing: 10) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .interpolation(.high)
                .frame(width: 24, height: 24)
                .accessibilityHidden(true)
            Text("Pi Remote")
                .font(Theme.Font.brand)
                .foregroundColor(Theme.textPrimary)
            Spacer()
            if model.activeService == .pi {
                StatusBadge(text: presentation.badge, tone: presentation.tone)
                    .animation(Motion.crossfade, value: presentation.badge)
            } else {
                ClaudeStatusBadge(claude: model.claudeService)
            }
            Button {
                settingsPresented = true
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(settingsPresented ? Theme.accent : Theme.textSecondary)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("设置（⌘,）")
            .keyboardShortcut(",", modifiers: .command)
            .accessibilityLabel(model.activeService == .pi ? "连接设置" : "Claude 服务设置")
            Button {
                withAnimation(Motion.resolved(Motion.disclosure, reduceMotion: reduceMotion)) {
                    model.diagnosticsExpanded.toggle()
                }
            } label: {
                Image(systemName: "text.alignleft")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(model.diagnosticsExpanded ? Theme.accent : Theme.textSecondary)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("诊断（⌘L）")
            .accessibilityLabel(model.diagnosticsExpanded ? "收起诊断" : "展开诊断")
        }
        .padding(.horizontal, 20)
        .frame(height: 56)
        .background(Theme.canvas)
    }

    private var serviceBar: some View {
        SegmentedChoice(
            options: [(ServiceKind.pi, ServiceKind.pi.title), (ServiceKind.claude, ServiceKind.claude.title)],
            selection: $model.activeService,
            compact: true,
            accessibilityName: "服务"
        )
        .frame(width: 240)
        .frame(maxWidth: .infinity)
        .frame(height: 52)
        .background(Theme.canvas)
    }
}

private struct ClaudeStatusBadge: View {
    @ObservedObject var claude: ClaudeServiceController

    var body: some View {
        let presentation = ClaudePresentation.make(state: claude.state, mode: claude.configuration.mode)
        StatusBadge(text: presentation.badge, tone: presentation.tone)
            .animation(Motion.crossfade, value: presentation.badge)
    }
}

/// The configuration form for the selected service, presented from the gear button.
struct SettingsSheet: View {
    @ObservedObject var model: AppModel
    let dismiss: () -> Void

    var body: some View {
        Group {
            if model.activeService == .pi {
                ConfigPane(model: model)
            } else {
                ClaudeConfigPane(claude: model.claudeService)
            }
        }
        .overlay(alignment: .topTrailing) {
            Button("完成", action: dismiss)
                .buttonStyle(SecondaryButtonStyle())
                .keyboardShortcut(.cancelAction)
                .padding(.top, 18)
                .padding(.trailing, 20)
        }
        .frame(width: 380, height: 600)
        .background(Theme.sidebar)
    }
}
