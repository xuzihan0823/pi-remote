import AppKit
import PiRemoteCore
import SwiftUI

struct ClaudeConfigPane: View {
    @ObservedObject var claude: ClaudeServiceController
    @State private var draft = ClaudeServiceConfiguration()
    @State private var showAdvanced = false
    @FocusState private var focus: Field?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum Field: Hashable { case port, executable }

    var body: some View {
        let editable = claude.state.canEdit
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 4) {
                        SectionTitle(text: "Claude 服务设置")
                        if !editable {
                            Text("停止服务后可修改配置")
                                .font(Theme.Font.caption)
                                .foregroundColor(Theme.textSecondary)
                        }
                    }
                    InputField(label: "访问方式", help: modeHelp) {
                        SegmentedChoice(
                            options: [(ClaudeServiceMode.local, "仅本机"), (ClaudeServiceMode.cloudflare, "临时隧道")],
                            selection: $draft.mode,
                            accessibilityName: "Claude 访问方式"
                        )
                    }
                    InputField(label: "端口", help: "本机后端监听 127.0.0.1 上的这个端口。") {
                        TextField("8788", value: $draft.port, format: .number.grouping(.never))
                            .focused($focus, equals: .port)
                            .fieldBox(focused: focus == .port)
                    }
                    advancedSection
                }
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .leading)
                .disabled(!editable)
                .animation(Motion.resolved(Motion.modeSwitch, reduceMotion: reduceMotion), value: draft.mode)
            }
            Divider().overlay(Theme.border)
            primaryAction
                .padding(.horizontal, 24)
                .padding(.vertical, 16)
        }
        .onAppear { draft = claude.configuration }
        .onChange(of: claude.configuration) { draft = $0 }
    }

    private var modeHelp: String {
        draft.mode == .cloudflare
            ? "通过 Cloudflare 临时地址供手机访问，每次启动地址都会变化。"
            : "只在这台 Mac 上可访问，适合本机调试。"
    }

    private var advancedSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            Button {
                withAnimation(Motion.resolved(Motion.disclosure, reduceMotion: reduceMotion)) { showAdvanced.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .rotationEffect(.degrees(showAdvanced ? 90 : 0))
                    Text("高级设置")
                        .font(Theme.Font.control)
                }
                .foregroundColor(Theme.textPrimary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(showAdvanced ? "收起高级设置" : "展开高级设置")

            if showAdvanced {
                VStack(alignment: .leading, spacing: 20) {
                    InputField(label: "Claude 可执行文件", help: "CLAUDE_BIN · 通常无需修改") {
                        TextField("/usr/local/bin/claude", text: $draft.executablePath)
                            .focused($focus, equals: .executable)
                            .fieldBox(focused: focus == .executable)
                            .help(draft.executablePath)
                    }
                    directoryField(label: "会话目录", help: "Claude 保存会话记录的位置", path: $draft.projectsDirectory)
                    directoryField(label: "数据目录", help: "Claude 服务的上传文件与记录", path: $draft.dataDirectory)
                }
                .transition(.opacity)
            }
        }
    }

    private func directoryField(label: String, help: String, path: Binding<String>) -> some View {
        InputField(label: label, help: help) {
            HStack(spacing: 8) {
                Text((path.wrappedValue as NSString).abbreviatingWithTildeInPath)
                    .font(Theme.Font.body)
                    .foregroundColor(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .frame(height: 38)
                    .background(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).fill(Theme.surface))
                    .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).stroke(Theme.controlBorder, lineWidth: 1))
                    .help(path.wrappedValue)
                    .accessibilityLabel("\(label)：\(path.wrappedValue)")
                Button("选择…") {
                    if let chosen = Self.chooseDirectory(start: path.wrappedValue) { path.wrappedValue = chosen }
                }
                .buttonStyle(SecondaryButtonStyle())
                .accessibilityLabel("选择\(label)")
            }
        }
    }

    @ViewBuilder
    private var primaryAction: some View {
        switch claude.state {
        case .idle, .failed:
            Button(claude.state == .idle ? "启动 Claude 服务" : "重新启动") {
                let requested = draft
                Task { try? await claude.start(configuration: requested) }
            }
            .buttonStyle(PrimaryButtonStyle())
            .keyboardShortcut(.defaultAction)
        case .starting:
            Button("取消启动") { Task { await claude.stop() } }
                .buttonStyle(SecondaryButtonStyle(fill: true))
        case .running:
            Button("停止服务") { Task { await claude.stop() } }
                .buttonStyle(SecondaryButtonStyle(fill: true))
        case .stopping:
            Button("正在停止…") {}
                .buttonStyle(SecondaryButtonStyle(fill: true))
                .disabled(true)
        }
    }

    private static func chooseDirectory(start: String) -> String? {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: start)
        return panel.runModal() == .OK ? panel.url?.path : nil
    }
}
