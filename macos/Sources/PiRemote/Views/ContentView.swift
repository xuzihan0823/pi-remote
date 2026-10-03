import AppKit
import SwiftUI

struct ContentView: View {
    @ObservedObject var model: AppModel
    @State private var windowVisible = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let presentation = model.presentation
        VStack(spacing: 0) {
            topBar(presentation)
            Divider().overlay(Theme.border)
            HStack(spacing: 0) {
                ConfigPane(model: model)
                    .frame(width: 340)
                    .background(Theme.sidebar)
                Divider().overlay(Theme.border)
                StatusPane(model: model, windowVisible: windowVisible)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Theme.canvas)
            }
            .frame(maxHeight: .infinity)
            Divider().overlay(Theme.border)
            DiagnosticsPane(model: model)
        }
        .background(Theme.canvas)
        .background(WindowVisibilityReader(isVisible: $windowVisible))
        .onAppear { model.onAppear() }
        .onChange(of: presentation.badge) { badge in
            NSAccessibility.post(
                element: NSApp as Any,
                notification: .announcementRequested,
                userInfo: [.announcement: "Pi Remote \(badge)", .priority: NSAccessibilityPriorityLevel.medium.rawValue]
            )
        }
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
            StatusBadge(text: presentation.badge, tone: presentation.tone)
                .animation(Motion.crossfade, value: presentation.badge)
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
}
