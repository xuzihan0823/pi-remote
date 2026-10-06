import XCTest

@MainActor
final class HistoryRenderingUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUpWithError() throws {
        continueAfterFailure = false
        app.launchEnvironment = [
            "AUTO_CONNECT": "1", "INITIAL_ROUTE": "sessions",
            "RELAY_URL": "ws://127.0.0.1:18789/ws/ios",
            "RELAY_TOKEN": "test-token-0123456789abcdef0123456789abcdef",
            "RELAY_DEVICE": "synthetic-ui-phone"
        ]
        app.launch()
        XCTAssertTrue(app.staticTexts["合成实时会话"].waitForExistence(timeout: 15), "先运行 tests/helpers/history-ui-server.ts")
    }

    func testOldReadingDoesNotFollowNewOutput() async throws {
        app.staticTexts["合成实时会话"].tap()
        let scroll = app.scrollViews.firstMatch
        XCTAssertTrue(scroll.waitForExistence(timeout: 5))
        let start = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        let end = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
        start.press(forDuration: 0.1, thenDragTo: end)
        XCTAssertTrue(app.buttons["back-to-bottom"].waitForExistence(timeout: 5))
        let anchor = try visibleMessage(in: scroll)
        let label = anchor.label
        let y = anchor.frame.minY
        var request = URLRequest(url: URL(string: "http://127.0.0.1:18790/append")!)
        request.httpMethod = "POST"
        _ = try await URLSession.shared.data(for: request)
        let notice = app.buttons["back-to-bottom"]
        let arrived = NSPredicate { _, _ in notice.label.contains("有新消息") }
        let arrivedExpectation = expectation(for: arrived, evaluatedWith: nil)
        await fulfillment(of: [arrivedExpectation], timeout: 8)
        let preserved = app.staticTexts[label]
        XCTAssertTrue(preserved.isHittable)
        XCTAssertEqual(preserved.frame.minY, y, accuracy: 3, "旧消息阅读位置不得被新输出抢走")
        app.buttons["back-to-bottom"].tap()
        let latest = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "新到达合成消息")).firstMatch
        XCTAssertTrue(latest.waitForExistence(timeout: 5))
        XCTAssertTrue(latest.isHittable)
        attachScreenshot("live-following-restored")
    }

    func testArchiveMarkdownToolDetailsAndPaginationAnchor() async throws {
        XCTAssertTrue(app.staticTexts["合成历史会话"].waitForExistence(timeout: 15))
        app.staticTexts["合成历史会话"].tap()
        XCTAssertTrue(app.staticTexts["历史快照 · 只读；不会恢复或运行工具"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.textFields.firstMatch.exists, "历史页面不能显示可执行输入框")
        let scroll = app.scrollViews.firstMatch
        let tableCell = app.staticTexts["a|b"]
        XCTAssertTrue(tableCell.waitForExistence(timeout: 10), "转义管道表格须显示为单元格文字")
        XCTAssertTrue(app.staticTexts["7."].exists, "列表须保留起始序号 7")
        XCTAssertGreaterThanOrEqual(app.staticTexts["合成 Markdown 验收"].frame.minX, scroll.frame.minX + 16,
                                    "首次滚底必须保留正文水平边距")
        attachScreenshot("archive-markdown")
        let tool = app.buttons["tool-tool:block-0"]
        for _ in 0..<5 where !tool.isHittable { scroll.swipeDown() }
        XCTAssertTrue(tool.isHittable)
        tool.tap()
        XCTAssertTrue(app.staticTexts["参数"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "synthetic.txt")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "synthetic-hidden-key")).firstMatch.exists)
        tool.tap()
        let earlier = app.buttons["load-earlier"]
        for _ in 0..<15 where !earlier.isHittable { scroll.swipeDown() }
        XCTAssertTrue(earlier.isHittable)
        let anchor = try visibleMessage(in: scroll)
        let label = anchor.label
        let y = anchor.frame.minY
        attachScreenshot("archive-before-pagination")
        earlier.tap()
        let preserved = app.staticTexts[label]
        let restored = NSPredicate { _, _ in preserved.isHittable && abs(preserved.frame.minY - y) <= 3 }
        let restoredExpectation = expectation(for: restored, evaluatedWith: nil)
        await fulfillment(of: [restoredExpectation], timeout: 10)
        print("Pagination anchor \(label): before=\(y), after=\(preserved.frame.minY)")
        XCTAssertEqual(preserved.frame.minY, y, accuracy: 3, "顶部分页须保留像素阅读锚点")
        attachScreenshot("archive-pagination-anchor")
        let (data, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:18790/state")!)
        let state = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(state["controlCalls"] as? Int, 0, "历史浏览不能执行或停止工具")
    }

    func testKeyboardPreservesOldReadingAnchor() async throws {
        app.staticTexts["合成实时会话"].tap()
        let scroll = app.scrollViews.firstMatch
        XCTAssertTrue(scroll.waitForExistence(timeout: 5))
        scroll.swipeDown()
        XCTAssertTrue(app.buttons["back-to-bottom"].waitForExistence(timeout: 5))
        let anchor = try visibleMessage(in: scroll)
        let label = anchor.label
        let y = anchor.frame.minY
        let input = app.textFields["继续输入…"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let preserved = app.staticTexts[label]
        let restored = NSPredicate { _, _ in preserved.isHittable && abs(preserved.frame.minY - y) <= 3 }
        await fulfillment(of: [expectation(for: restored, evaluatedWith: nil)], timeout: 8)
        attachScreenshot("keyboard-reading-anchor")
    }

    func testToolExpansionAndBranchReturnPreserveReading() async throws {
        app.staticTexts["合成历史会话"].tap()
        let scroll = app.scrollViews.firstMatch
        let tool = app.buttons["tool-tool:block-0"]
        XCTAssertTrue(tool.waitForExistence(timeout: 10))
        scroll.swipeDown()
        XCTAssertTrue(tool.isHittable)
        let toolAnchor = try visibleMessage(in: scroll)
        let toolLabel = toolAnchor.label
        let toolY = toolAnchor.frame.minY
        tool.tap()
        XCTAssertTrue(app.staticTexts["参数"].waitForExistence(timeout: 5))
        let toolPreserved = app.staticTexts[toolLabel]
        let toolRestored = NSPredicate { _, _ in toolPreserved.isHittable && abs(toolPreserved.frame.minY - toolY) <= 3 }
        await fulfillment(of: [expectation(for: toolRestored, evaluatedWith: nil)], timeout: 8)
        tool.tap()
        let branches = app.buttons["分支"]
        for _ in 0..<15 where !branches.isHittable { scroll.swipeDown() }
        XCTAssertTrue(branches.isHittable)
        let anchor = try visibleMessage(in: scroll)
        let label = anchor.label
        let y = anchor.frame.minY
        branches.tap()
        app.buttons["分支 1"].tap()
        let sibling = app.staticTexts["合成兄弟分支，仅在选择该分支后可见。"]
        XCTAssertTrue(sibling.waitForExistence(timeout: 8))
        XCTAssertFalse(app.staticTexts["a|b"].exists, "不能混入另一分支的正文")
        for _ in 0..<15 where !branches.isHittable { scroll.swipeDown() }
        branches.tap()
        app.buttons["最后记录分支"].tap()
        let preserved = app.staticTexts[label]
        let restored = NSPredicate { _, _ in preserved.isHittable && abs(preserved.frame.minY - y) <= 3 }
        await fulfillment(of: [expectation(for: restored, evaluatedWith: nil)], timeout: 8)
        attachScreenshot("branch-reading-anchor")
    }

    private func visibleMessage(in scroll: XCUIElement) throws -> XCUIElement {
        let messages = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "合成消息 ")).allElementsBoundByIndex
        guard let message = messages.first(where: { $0.isHittable && $0.frame.minY >= scroll.frame.minY + 10 && $0.frame.maxY < scroll.frame.maxY - 70 }) else {
            throw NSError(domain: "HistoryUI", code: 1, userInfo: [NSLocalizedDescriptionKey: "没有可量测的可见消息锚点"])
        }
        return message
    }

    private func attachScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
    }
}
