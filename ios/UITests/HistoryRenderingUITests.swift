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
        XCTAssertFalse(app.buttons["resume-history"].exists)
        XCTAssertTrue(app.textFields["conversation-input"].waitForExistence(timeout: 10), "历史页面可直接输入，浏览时不启动恢复")
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

    func testExpandedLongReplyKeepsFullMarkdownInConversation() async throws {
        app.staticTexts["合成实时会话"].tap()
        XCTAssertTrue(app.textFields["继续输入…"].waitForExistence(timeout: 10))
        var request = URLRequest(url: URL(string: "http://127.0.0.1:18790/long-reply")!)
        request.httpMethod = "POST"
        _ = try await URLSession.shared.data(for: request)
        let expand = app.buttons["展开完整正文"]
        XCTAssertTrue(expand.waitForExistence(timeout: 10))
        for _ in 0..<5 where !expand.isHittable { app.scrollViews.firstMatch.swipeUp() }
        expand.tap()
        XCTAssertTrue(app.staticTexts["完整正文最后一行"].waitForExistence(timeout: 10),
                      "必须读取超过 4KB 的尾部，并以 Markdown 正文显示，而不是横向纯文本详情")
        XCTAssertTrue(app.buttons["收起完整正文"].exists)
        attachScreenshot("long-reply-full-markdown")
    }

    func testHistoryModelCanBeSelectedBeforeResume() async throws {
        app.staticTexts["合成历史会话"].tap()
        let menu = app.buttons["history-resume-model"]
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
        XCTAssertTrue(menu.isEnabled, "只读历史不能禁用恢复前的模型选择")
        menu.tap()
        let selected = app.buttons["合成模型 B"]
        XCTAssertTrue(selected.waitForExistence(timeout: 10))
        XCTAssertTrue(selected.isEnabled, "候选模型必须可选，不能全部置灰")
        selected.tap()
        XCTAssertTrue(menu.label.contains("合成模型 B"))
        attachScreenshot("history-model-selected-before-resume")
        let (beforeData, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:18790/state")!)
        let before = try JSONSerialization.jsonObject(with: beforeData) as! [String: Any]
        XCTAssertEqual(before["modelSwitchCalls"] as? Int, 0, "选择时不应修改只读历史")
        XCTAssertFalse(app.buttons["resume-history"].exists)
        let input = app.textFields["conversation-input"]
        input.tap()
        input.typeText("只回复 ok")
        app.buttons["发送消息"].tap()
        let sent = NSPredicate { _, _ in input.exists && input.value as? String == "继续输入…" }
        await fulfillment(of: [expectation(for: sent, evaluatedWith: nil)], timeout: 15)
        let (afterData, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:18790/state")!)
        let after = try JSONSerialization.jsonObject(with: afterData) as! [String: Any]
        XCTAssertEqual(after["resumeCalls"] as? Int, 1)
        XCTAssertEqual(after["modelSwitchCalls"] as? Int, 1)
        XCTAssertEqual((after["activeModel"] as? [String: Any])?["modelId"] as? String, "b")
        XCTAssertEqual(after["controlCalls"] as? Int, 1, "用户点击发送后只投递一次消息")
        attachScreenshot("history-model-confirmed-after-resume")
    }
    func testModelListScrollsBothWaysAndSearchesWithoutSwitching() async throws {
        app.staticTexts["合成历史会话"].tap()
        let menu = app.buttons["history-resume-model"]
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
        menu.tap()
        let list = app.collectionViews["model-selection-list"]
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        let last = app.buttons["滚动验收模型 30"]
        for _ in 0..<12 {
            if last.exists && last.isHittable { break }
            list.swipeUp()
        }
        XCTAssertTrue(last.isHittable, "向上滑必须能到达列表末尾")
        let first = app.buttons["合成模型 A"]
        for _ in 0..<12 {
            if first.exists && first.isHittable { break }
            list.swipeDown()
        }
        XCTAssertTrue(first.isHittable, "向下滑必须能返回列表开头")
        let search = app.searchFields.firstMatch
        search.tap()
        search.typeText("滚动验收模型 30")
        XCTAssertTrue(last.waitForExistence(timeout: 5))
        last.tap()
        XCTAssertTrue(menu.label.contains("滚动验收模型 30"))
        let (data, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:18790/state")!)
        let state = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(state["modelSwitchCalls"] as? Int, 0)
        XCTAssertEqual(state["controlCalls"] as? Int, 0)
        attachScreenshot("model-list-scrolled-and-searched")
    }
    func testEmptyFailedReplyShowsTheRecordedReason() async throws {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:18790/failed-reply")!)
        request.httpMethod = "POST"
        _ = try await URLSession.shared.data(for: request)
        app.staticTexts["合成实时会话"].tap()
        XCTAssertTrue(app.staticTexts["消息执行失败：unknown certificate verification error"].waitForExistence(timeout: 10))
        attachScreenshot("failed-reply-recorded-reason")
    }



    func testHistoryResumeTurnsSnapshotIntoControllableTerminal() async throws {
        app.staticTexts["合成历史会话"].tap()
        XCTAssertFalse(app.buttons["resume-history"].exists, "历史页不再有独立续接按钮")
        let input = app.textFields["conversation-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        XCTAssertTrue(input.isEnabled, "历史打开后直接输入")
        attachScreenshot("history-ready-to-send")
        let (beforeData, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:18790/state")!)
        let before = try JSONSerialization.jsonObject(with: beforeData) as! [String: Any]
        XCTAssertEqual(before["resumeCalls"] as? Int, 0, "只浏览历史不启动进程")
        input.tap()
        input.typeText("只回复 ok")
        app.buttons["发送消息"].tap()
        let sent = NSPredicate { _, _ in input.exists && input.value as? String == "继续输入…" }
        await fulfillment(of: [expectation(for: sent, evaluatedWith: nil)], timeout: 15)
        XCTAssertTrue(app.staticTexts["最后一条合成消息"].exists, "恢复后保留原历史正文")
        let (data, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:18790/state")!)
        let state = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(state["resumeCalls"] as? Int, 1)
        XCTAssertEqual(state["controlCalls"] as? Int, 1, "一次发送对应一次续接和一次投递")
        app.buttons["open-sidebar"].tap()
        let resumedRow = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "合成历史会话")).firstMatch
        XCTAssertTrue(resumedRow.waitForExistence(timeout: 10), "续接后仍能在会话记录找到原对话")
        resumedRow.tap()
        XCTAssertTrue(input.waitForExistence(timeout: 10))
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
        XCTAssertFalse(app.buttons["resume-history"].exists)
        let input = app.textFields["conversation-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        XCTAssertTrue(input.isEnabled)
        let before = try await state()
        XCTAssertEqual(before["instanceCount"] as? Int, 0, "原 OMP 必须已真实退出，不能预先启动 PTY 后复用")
        XCTAssertEqual(before["launchCount"] as? Int, 0)
        input.tap()
        input.typeText("这是 Pi Remote 专用续接验收。不要调用工具，只回复 OFFLINE_RESUME_OK。")
        app.buttons["发送消息"].tap()
        let answer = app.staticTexts["OFFLINE_RESUME_OK"]
        XCTAssertTrue(answer.waitForExistence(timeout: 90), "发送自动恢复原会话并读取真实 OMP 回复")
        XCTAssertTrue(app.staticTexts["最后记录分支"].exists)
        XCTAssertFalse(app.staticTexts["非恢复目标分支"].exists)
        let restored = try await state()
        XCTAssertEqual(restored["launchCount"] as? Int, 1)
        XCTAssertEqual(restored["promptCount"] as? Int, 1)
        XCTAssertEqual(restored["abortCount"] as? Int, 0)
        XCTAssertEqual(restored["approvalCount"] as? Int, 0)
        XCTAssertEqual(restored["originalEntriesPreserved"] as? Bool, true)
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
