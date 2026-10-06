import Foundation
import SwiftUI

struct MarkdownMessageView: View {
    let text: String
    var baseFontSize: CGFloat = 14
    var messageID = "managed-output"
    @State private var blocks: [MarkdownRenderBlock] = []
    @State private var parsedText = ""
    @State private var pendingURL: URL?
    @Environment(\.openURL) private var openURL
    @ScaledMetric(relativeTo: .body) private var textScale: CGFloat = 1

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if blocks.isEmpty && !text.isEmpty {
                Text(verbatim: text).textSelection(.enabled)
            } else {
                ForEach(blocks) { block in
                    MarkdownBlockView(block: block, baseFontSize: baseFontSize * textScale)
                }
            }
        }
        .foregroundColor(DesignTokens.Colors.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .environment(\.openURL, OpenURLAction { url in
            guard ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return .discarded }
            pendingURL = url
            return .handled
        })
        .confirmationDialog("在浏览器中打开链接？", isPresented: Binding(
            get: { pendingURL != nil }, set: { if !$0 { pendingURL = nil } }
        ), titleVisibility: .visible) {
            if let url = pendingURL { Button("打开链接") { openURL(url); pendingURL = nil } }
            Button("取消", role: .cancel) { pendingURL = nil }
        } message: {
            if let url = pendingURL { Text(verbatim: url.absoluteString) }
        }
        .task(id: text) {
            if parsedText == text { return }
            try? await Task.sleep(for: .milliseconds(70))
            guard !Task.isCancelled else { return }
            let rendered = await MarkdownRenderCache.shared.blocks(text: text, messageID: messageID)
            guard !Task.isCancelled else { return }
            blocks = rendered
            parsedText = text
        }
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownRenderBlock
    let baseFontSize: CGFloat
    @State private var tableViewport: CGFloat = 320

    var body: some View {
        switch block.kind {
        case .paragraph:
            inlineText(block.inline)
        case .heading:
            inlineText(block.inline, size: baseFontSize + (block.level == 1 ? 5 : block.level == 2 ? 3 : 1), weight: .bold)
                .accessibilityAddTraits(.isHeader)
        case .quote:
            HStack(alignment: .top, spacing: 10) {
                Rectangle().fill(DesignTokens.Colors.accentGreen).frame(width: 3)
                children
            }
        case .list:
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(block.children.enumerated()), id: \.element.id) { index, child in
                    HStack(alignment: .top, spacing: 8) {
                        Text(block.startIndex.map { "\($0 + index)." } ?? "•")
                            .font(.system(size: baseFontSize, weight: .semibold))
                            .foregroundColor(DesignTokens.Colors.accentGreen)
                            .frame(minWidth: block.startIndex == nil ? 12 : 20, alignment: .trailing)
                        MarkdownBlockView(block: child, baseFontSize: baseFontSize)
                    }
                }
            }
        case .listItem:
            children
        case .code:
            VStack(alignment: .leading, spacing: 6) {
                if let language = block.language, !language.isEmpty {
                    Text(verbatim: language).font(.caption.monospaced()).foregroundColor(DesignTokens.Colors.textSecondary)
                }
                ScrollView(.horizontal) {
                    Text(verbatim: block.code.isEmpty ? " " : block.code)
                        .font(.system(size: max(12, baseFontSize - 2), design: .monospaced))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(DesignTokens.Colors.glassLight)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        case .table:
            table
        case .divider:
            Rectangle().fill(DesignTokens.Colors.divider).frame(height: 1).padding(.vertical, 4)
        }
    }

    private var children: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(block.children) { child in
                MarkdownBlockView(block: child, baseFontSize: baseFontSize)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func inlineText(_ value: AttributedString, size: CGFloat? = nil, weight: Font.Weight = .regular) -> some View {
        Text(value)
            .font(.system(size: size ?? baseFontSize, weight: weight))
            .tint(DesignTokens.Colors.accentGreen)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var table: some View {
        ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(block.cells.enumerated()), id: \.offset) { rowIndex, row in
                    HStack(alignment: .top, spacing: 0) {
                        ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
                            Text(cell)
                                .font(.system(size: max(12, baseFontSize - 2), weight: rowIndex == 0 ? .semibold : .regular))
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(width: columnWidth(column), alignment: .leading)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 8)
                                .overlay(alignment: .trailing) { Rectangle().fill(DesignTokens.Colors.divider).frame(width: 1) }
                        }
                    }
                    .background(rowIndex == 0 ? DesignTokens.Colors.glassMedium : DesignTokens.Colors.glassLight)
                    .overlay(alignment: .bottom) { Rectangle().fill(DesignTokens.Colors.divider).frame(height: 1) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { tableViewport = $0 }
    }

    private func columnWidth(_ column: Int) -> CGFloat {
        let characters = block.cells.map { $0.indices.contains(column) ? $0[column].characters.count : 0 }.max() ?? 0
        let columns = max(1, block.cells.map(\.count).max() ?? 1)
        let share = tableViewport / CGFloat(columns) - 20
        return min(max(220, baseFontSize * 10), max(80, share, CGFloat(min(characters, 30)) * baseFontSize * 0.6))
    }
}
