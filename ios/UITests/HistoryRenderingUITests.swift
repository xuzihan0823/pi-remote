import XCTest

@MainActor
final class HistoryRenderingUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
        var reset = URLRequest(url: URL(string: "http://127.0.0.1:18790/reset")!)
        reset.httpMethod = "POST"
        _ = try await URLSession.shared.data(for: reset)
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
        XCTAssertTrue(app.buttons["resume-history"].waitForExistence(timeout: 10))
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

    func testHistoryResumeTurnsSnapshotIntoControllableTerminal() async throws {
        app.staticTexts["合成历史会话"].tap()
        let resume = app.buttons["resume-history"]
        XCTAssertTrue(resume.waitForExistence(timeout: 10))
        XCTAssertTrue(resume.isEnabled)
        XCTAssertFalse(app.textFields.firstMatch.exists)
        attachScreenshot("history-ready-to-resume")
        resume.tap()
        let input = app.textFields["继续输入…"]
        XCTAssertTrue(input.waitForExistence(timeout: 15), "恢复成功后必须出现可交互输入框")
        XCTAssertTrue(input.isEnabled)
        XCTAssertFalse(resume.exists, "不得仍停留在只读历史页")
        XCTAssertTrue(app.staticTexts["最后一条合成消息"].exists, "恢复后保留原历史正文")
        let (data, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:18790/state")!)
        let state = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(state["resumeCalls"] as? Int, 1)
        XCTAssertEqual(state["controlCalls"] as? Int, 0, "恢复本身不得自动发送或停止任务")
        attachScreenshot("history-resumed-input")
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

@MainActor
final class OfflineHistoryRecoveryUITests: XCTestCase {
    func testRealOfflineHistoryResumeAndControl() async throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        let host = ProcessInfo.processInfo.environment["PI_REMOTE_UI_HOST"]
            ?? (Bundle(for: OfflineHistoryRecoveryUITests.self).object(forInfoDictionaryKey: "PiRemoteOfflineVerificationHost") as? String)
            ?? "127.0.0.1"
        print("Real offline verification host: \(host)")
        let reachable = try await state()
        XCTAssertEqual(reachable["instanceCount"] as? Int, 0)
        app.launchEnvironment = [
            "AUTO_CONNECT": "1", "INITIAL_ROUTE": "sessions",
            "RELAY_URL": "ws://\(host):18849/ws/ios",
            "RELAY_TOKEN": "test-token-0123456789abcdef0123456789abcdef",
            "RELAY_DEVICE": "real-offline-ui-phone",
        ]
        app.launch()
        let history = app.staticTexts["离线续接真实验收"]
        XCTAssertTrue(history.waitForExistence(timeout: 20), "必须先启动真实离线 UI 验收服务")
        history.tap()
        let resume = app.buttons["resume-history"]
        XCTAssertTrue(resume.waitForExistence(timeout: 10))
        XCTAssertFalse(app.textFields["继续输入…"].exists)
        let before = try await state()
        XCTAssertEqual(before["instanceCount"] as? Int, 0, "原 OMP 必须已真实退出，不能预先启动 PTY 后复用")
        XCTAssertEqual(before["launchCount"] as? Int, 0)
        resume.tap()
        let input = app.textFields["继续输入…"]
        XCTAssertTrue(input.waitForExistence(timeout: 40), "真实 open/脚本/OMP/桥接就绪后才允许输入")
        XCTAssertTrue(input.isEnabled)
        XCTAssertTrue(app.staticTexts["最后记录分支"].exists)
        XCTAssertFalse(app.staticTexts["非恢复目标分支"].exists)
        let restored = try await state()
        XCTAssertEqual(restored["launchCount"] as? Int, 1)
        XCTAssertEqual(restored["promptCount"] as? Int, 0)
        XCTAssertEqual(restored["abortCount"] as? Int, 0)
        XCTAssertEqual(restored["approvalCount"] as? Int, 0)
        XCTAssertEqual(restored["originalEntriesPreserved"] as? Bool, true)
        XCTAssertEqual(restored["noNewUserMessages"] as? Bool, true, "OMP 可标记上次未完成回合，恢复器不得投递新提示词")
        XCTAssertEqual(restored["uniqueExactInstance"] as? Bool, true)
        attach(app, name: "real-offline-restored")
        let tool = app.buttons["tool-tool-call:block-0"]
        let scroll = app.scrollViews.firstMatch
        for _ in 0..<5 where !tool.isHittable { scroll.swipeDown() }
        XCTAssertTrue(tool.waitForExistence(timeout: 10))
        tool.tap()
        XCTAssertTrue(app.staticTexts["参数"].waitForExistence(timeout: 10))
        attach(app, name: "real-offline-tool-detail")
        tool.tap()
        let earlier = app.buttons["load-earlier"]
        for _ in 0..<4 {
            for _ in 0..<12 {
                if !earlier.exists { break }
                if earlier.frame.intersects(scroll.frame) && !earlier.frame.isEmpty { break }
                scroll.swipeDown()
            }
            guard earlier.exists, earlier.frame.intersects(scroll.frame), !earlier.frame.isEmpty else { break }
            earlier.tap()
            let loaded = NSPredicate { _, _ in !earlier.exists || !earlier.label.contains("正在加载") }
            await fulfillment(of: [expectation(for: loaded, evaluatedWith: nil)], timeout: 10)
        }
        for _ in 0..<15 {
            if app.staticTexts["离线验收合成记录 0"].exists { break }
            scroll.swipeDown()
        }
        XCTAssertTrue(app.staticTexts["离线验收合成记录 0"].waitForExistence(timeout: 10), "恢复后仍能分页查看早期原记录")
        if app.buttons["back-to-bottom"].exists { app.buttons["back-to-bottom"].tap() }
        input.tap()
        input.typeText("这是 Pi Remote 专用续接验收。不要调用工具，只回复 OFFLINE_RESUME_OK。")
        app.buttons["发送消息"].tap()
        let answer = app.staticTexts["OFFLINE_RESUME_OK"]
        XCTAssertTrue(answer.waitForExistence(timeout: 90), "必须读取真实 OMP 输出，而非模拟回复")
        let send = app.buttons["发送消息"]
        XCTAssertTrue(send.waitForExistence(timeout: 30))
        input.tap()
        input.typeText("OFFLINE_ABORT_CHECK：请详细输出一千条递增数字，每条一行，不要调用工具。")
        send.tap()
        let stop = app.buttons["停止任务"]
        XCTAssertTrue(stop.waitForExistence(timeout: 20))
        stop.tap()
        XCTAssertTrue(send.waitForExistence(timeout: 30), "停止后运行会话应回到空闲")
        let after = try await state()
        XCTAssertEqual(after["launchCount"] as? Int, 1)
        XCTAssertEqual(after["promptCount"] as? Int, 2)
        XCTAssertEqual(after["abortCount"] as? Int, 1)
        XCTAssertEqual(after["approvalCount"] as? Int, 0)
        XCTAssertEqual(after["samePersistedId"] as? Bool, true)
        XCTAssertEqual(after["uniqueExactInstance"] as? Bool, true)
        XCTAssertEqual(after["noHistoryCopies"] as? Bool, true)
        XCTAssertEqual(after["promptPersisted"] as? Bool, true)
        XCTAssertEqual(after["abortPromptPersisted"] as? Bool, true)
        attach(app, name: "real-offline-prompt-and-abort")
    }

    private func state() async throws -> [String: Any] {
        let host = ProcessInfo.processInfo.environment["PI_REMOTE_UI_HOST"]
            ?? (Bundle(for: OfflineHistoryRecoveryUITests.self).object(forInfoDictionaryKey: "PiRemoteOfflineVerificationHost") as? String)
            ?? "127.0.0.1"
        let (data, _) = try await URLSession.shared.data(from: URL(string: "http://\(host):18850/state")!)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
