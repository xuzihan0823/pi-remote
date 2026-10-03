import AppKit
import SwiftUI

struct DiagnosticsPane: View {
    @ObservedObject var model: AppModel
    @State private var followLatest = true
    @State private var copied = false
    @State private var copyTask: Task<Void, Never>?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let collapsedHeight: CGFloat = 36
    static let expandedHeight: CGFloat = 200

    var body: some View {
        VStack(spacing: 0) {
            header
            if model.diagnosticsExpanded {
                Divider().overlay(Theme.border)
                logList
                    .transition(.opacity)
            }
        }
        .frame(height: model.diagnosticsExpanded ? Self.expandedHeight : Self.collapsedHeight)
        .background(Theme.sidebar)
        .clipped()
        .onDisappear { copyTask?.cancel() }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Button {
                withAnimation(Motion.resolved(Motion.disclosure, reduceMotion: reduceMotion)) {
                    model.diagnosticsExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .rotationEffect(.degrees(model.diagnosticsExpanded ? 90 : 0))
                    Text("诊断")
                        .font(Theme.Font.caption.weight(.semibold))
                    if hasError {
                        Circle().fill(Theme.danger).frame(width: 6, height: 6)
                            .accessibilityLabel("有错误")
                    }
                }
                .foregroundColor(Theme.textPrimary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(model.diagnosticsExpanded ? "收起诊断" : "展开诊断")

            if !model.diagnosticsExpanded, let last = model.logs.last {
                Text(last.text)
                    .font(Theme.Font.mono)
                    .foregroundColor(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 8)
            if model.diagnosticsExpanded {
                if !followLatest {
                    Button("回到最新") { followLatest = true }
                        .buttonStyle(LinkButtonStyle())
                }
                Button(copied ? "已复制" : "复制诊断") { copyDiagnostics() }
                    .buttonStyle(LinkButtonStyle())
                    .frame(minWidth: 56, alignment: .trailing)
                    .disabled(model.logs.isEmpty)
            }
        }
        .padding(.horizontal, 16)
        .frame(height: Self.collapsedHeight)
    }

    private var logList: some View {
        ScrollViewReader { proxy in
            ScrollView([.vertical]) {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if model.logs.isEmpty {
                        Text("暂无运行记录")
                            .foregroundColor(Theme.textSecondary)
                    }
                    ForEach(model.logs) { entry in
                        Text(entry.text)
                            .foregroundColor(Theme.textPrimary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id(entry.id)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id("bottom")
                        .onAppear { followLatest = true }
                        .onDisappear { followLatest = false }
                }
                .font(Theme.Font.mono)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: model.logs.last?.id) { _ in
                if followLatest { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: followLatest) { follow in
                if follow { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
    }

    private var hasError: Bool {
        if model.phase == .error { return true }
        if case .failed = model.deployStage { return true }
        return false
    }

    private func copyDiagnostics() {
        NSPasteboard.general.clearContents()
        guard NSPasteboard.general.setString(model.diagnosticsReport(), forType: .string) else { return }
        withAnimation(Motion.feedback) { copied = true }
        copyTask?.cancel()
        copyTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if !Task.isCancelled { withAnimation(Motion.feedback) { copied = false } }
        }
    }
}
