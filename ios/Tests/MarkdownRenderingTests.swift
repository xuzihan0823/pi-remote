import Foundation

@main
struct MarkdownRenderingTests {
    struct Failure: Error { let message: String }

    static func main() async throws {
        let text = """
        **粗体** 和 *斜体* 与 `inline`

        7. 第一项
           续行仍在这一项
           - 嵌套子项
             - 第三级
        8. 第二项

        ````swift
        let a = "中文😀"
        ~~~
        ```
        ````

        | 第一列 | 第二列 |
        | --- | --- |
        | a\\|b | 中文 |

        [安全](https://example.com) [危险](javascript:alert(1))
        ![远程图片](https://example.com/image.png)
        """
        let blocks = MarkdownRenderParser.parse(text, messageID: "fixture")
        let ordered = try require(blocks.first { $0.kind == .list && $0.startIndex != nil })
        try expect(ordered.startIndex == 7 && ordered.children.count == 2, "有序列表须保留从 7 开始的序号")
        let first = ordered.children[0]
        try expect(first.children.contains { String($0.inline.characters).contains("续行仍在这一项") }, "续行须留在列表项内")
        let nested = try require(first.children.first { $0.kind == .list })
        try expect(nested.children[0].children.contains { $0.kind == .list }, "三级嵌套列表不能展平")
        let code = try require(blocks.first { $0.kind == .code })
        try expect(code.language == "swift" && code.code.contains("~~~") && code.code.contains("```"), "不同符号／较短围栏不能提前关闭代码块")
        let table = try require(blocks.first { $0.kind == .table })
        try expect(table.cells.count == 2 && table.cells[1].count == 2, "转义管道不能增加表格列")
        try expect(String(table.cells[1][0].characters) == "a|b", "转义管道应显示为普通字符")
        let paragraph = blocks[0].inline
        try expect(paragraph.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true }, "粗体不能回退")
        try expect(paragraph.runs.contains { $0.inlinePresentationIntent?.contains(.emphasized) == true }, "斜体不能回退")
        try expect(paragraph.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true }, "行内代码须保留")
        let links = blocks.flatMap { $0.inline.runs.compactMap(\.link) }
        try expect(links == [URL(string: "https://example.com")!], "仅 HTTP(S) 链接可点击")
        try expect(blocks.contains { String($0.inline.characters).contains("图片未载入") }, "远程图片不可自动加载")
        let unfinished = MarkdownRenderParser.parse("```swift\n未闭合代码 中文😀", messageID: "unfinished")
        try expect(unfinished.first?.kind == .code && unfinished.first?.code.contains("未闭合代码") == true, "流式未闭合代码须可读")
        let html = MarkdownRenderParser.parse("<script>alert(1)</script>", messageID: "html")
        try expect(String(html[0].inline.characters).contains("<script>"), "HTML 只能作为文字显示")
        let cached = await MarkdownRenderCache.shared.blocks(text: text, messageID: "fixture")
        try expect(cached.map(\.id) == blocks.map(\.id), "缓存不得改变稳定块 ID")
        let changed = await MarkdownRenderCache.shared.blocks(text: "内容已更新", messageID: "fixture")
        try expect(String(changed[0].inline.characters) == "内容已更新", "内容变化须重新解析")
        print("PASS: Markdown AST 嵌套／续行／序号／围栏／表格／内联格式与链接安全")
    }

    static func require<T>(_ value: T?) throws -> T {
        guard let value else { throw Failure(message: "缺少预期 AST 节点") }
        return value
    }
    static func expect(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(message: message) }
    }
}
