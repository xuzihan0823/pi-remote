import Foundation
import Markdown

struct MarkdownRenderBlock: Identifiable, Sendable {
    enum Kind: Sendable { case paragraph, heading, quote, list, listItem, code, table, divider }
    let id: String
    var kind: Kind
    var inline = AttributedString()
    var children: [MarkdownRenderBlock] = []
    var level = 0
    var startIndex: Int?
    var language: String?
    var code = ""
    var cells: [[AttributedString]] = []
}

enum MarkdownRenderParser {
    static func parse(_ text: String, messageID: String) -> [MarkdownRenderBlock] {
        let document = Document(parsing: text, options: [.parseBlockDirectives])
        return document.children.enumerated().map { block($0.element, id: "\(messageID):\($0.offset)") }
    }

    private static func block(_ markup: Markup, id: String) -> MarkdownRenderBlock {
        var result = MarkdownRenderBlock(id: id, kind: .paragraph)
        switch markup {
        case let heading as Heading:
            result.kind = .heading; result.level = heading.level; result.inline = inline(markup)
        case is BlockQuote:
            result.kind = .quote
        case let list as OrderedList:
            result.kind = .list; result.startIndex = Int(list.startIndex)
        case is UnorderedList:
            result.kind = .list
        case is ListItem:
            result.kind = .listItem
        case let code as CodeBlock:
            result.kind = .code; result.language = code.language; result.code = code.code
        case let table as Table:
            result.kind = .table
            result.cells = [table.head.children.map(inline)] + table.body.children.map { row in row.children.map(inline) }
        case is ThematicBreak:
            result.kind = .divider
        case let html as HTMLBlock:
            result.inline = AttributedString(html.rawHTML)
        default:
            result.inline = inline(markup)
        }
        if [.quote, .list, .listItem].contains(result.kind) {
            result.children = markup.children.enumerated().map { block($0.element, id: "\(id):\($0.offset)") }
        }
        return result
    }

    private static func inline(_ markup: Markup) -> AttributedString {
        if let text = markup as? Markdown.Text { return AttributedString(text.string) }
        if let code = markup as? InlineCode {
            var value = AttributedString(code.code)
            value.inlinePresentationIntent = .code
            return value
        }
        if markup is SoftBreak { return AttributedString(" ") }
        if markup is LineBreak { return AttributedString("\n") }
        if let html = markup as? InlineHTML { return AttributedString(html.rawHTML) }
        if markup is Image { return AttributedString("[图片未载入]") }
        var value = markup.children.reduce(into: AttributedString()) { $0 += inline($1) }
        if markup is Strong {
            for run in value.runs { value[run.range].inlinePresentationIntent = (run.inlinePresentationIntent ?? []).union(.stronglyEmphasized) }
        } else if markup is Emphasis {
            for run in value.runs { value[run.range].inlinePresentationIntent = (run.inlinePresentationIntent ?? []).union(.emphasized) }
        } else if markup is Strikethrough {
            for run in value.runs { value[run.range].inlinePresentationIntent = (run.inlinePresentationIntent ?? []).union(.strikethrough) }
        } else if let link = markup as? Markdown.Link, let destination = link.destination,
                  let url = URL(string: destination), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            value.link = url
        }
        return value
    }
}

actor MarkdownRenderCache {
    static let shared = MarkdownRenderCache()
    private struct Entry { let text: String; let blocks: [MarkdownRenderBlock] }
    private var entries: [String: Entry] = [:]
    private var order: [String] = []
    private var bytes = 0
    private var generation = 0

    func blocks(text: String, messageID: String) async -> [MarkdownRenderBlock] {
        if let entry = entries[messageID], entry.text == text { return entry.blocks }
        let requestGeneration = generation
        let blocks = await Task.detached(priority: .userInitiated) {
            MarkdownRenderParser.parse(text, messageID: messageID)
        }.value
        guard requestGeneration == generation else { return blocks }
        if let old = entries.removeValue(forKey: messageID) { bytes -= old.text.utf8.count }
        order.removeAll { $0 == messageID }
        entries[messageID] = Entry(text: text, blocks: blocks)
        order.append(messageID)
        bytes += text.utf8.count
        while order.count > 128 || bytes > 2 * 1024 * 1024 {
            guard !order.isEmpty else { break }
            let id = order.removeFirst()
            if let entry = entries.removeValue(forKey: id) { bytes -= entry.text.utf8.count }
        }
        return blocks
    }

    func clear() { generation += 1; entries = [:]; order = []; bytes = 0 }
}
