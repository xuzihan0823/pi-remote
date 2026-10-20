import XCTest

@MainActor
final class DesktopControlsUITests: XCTestCase {
    private let app = XCUIApplication()
    private let sessionTitle = "手机控制测试会话"
    private let relayToken = "test-token-0123456789abcdef0123456789abcdef"

    override func setUp() async throws {
        continueAfterFailure = false
        _ = try await post("/reset")
        app.launchEnvironment = [
            "AUTO_CONNECT": "1",
            "INITIAL_ROUTE": "sessions",
            "RELAY_URL": "ws://127.0.0.1:18791/ws/ios",
            "RELAY_TOKEN": relayToken,
            "RELAY_DEVICE": "synthetic-desktop-controls-phone",
        ]
        if ProcessInfo.processInfo.environment["DESKTOP_CONTROLS_LARGE_TEXT"] == "1" {
            app.launchArguments += [
                "-UIPreferredContentSizeCategoryName",
                "UICTContentSizeCategoryAccessibilityXXXL",
            ]
        }
        if ProcessInfo.processInfo.environment["DESKTOP_CONTROLS_DARK"] == "1" {
            app.launchArguments += ["-AppleInterfaceStyle", "Dark"]
        }
        app.launch()
        XCTAssertTrue(
            app.staticTexts[sessionTitle].waitForExistence(timeout: 20),
            "先运行 tests/helpers/desktop-controls-ui-server.ts"
        )
    }

    func testModelMenuSwitchesDesktopModelAndPermissionIsReadOnly() async throws {
        try await openSession()
        await waitForPermission("权限：逐次询问")
        XCTAssertFalse(app.buttons["desktop-allow-once"].exists, "未打开交互面板时不应出现可写的权限操作")

        let menu = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "选择模型，当前")).firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 15))
        await fulfillment(
            of: [expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: menu)],
            timeout: 15
        )
        menu.tap()

        let optionB = app.buttons["测试模型 B"]
        XCTAssertTrue(optionB.waitForExistence(timeout: 10))
        optionB.tap()

        await fulfillment(
            of: [expectation(for: NSPredicate(format: "label CONTAINS[c] %@", "b"), evaluatedWith: menu)],
            timeout: 15
        )

        let state = try await controlState()
        XCTAssertEqual(state["activeProviderId"] as? String, "fake")
        XCTAssertEqual(state["activeModelId"] as? String, "b")
        XCTAssertEqual(state["modelSwitchCalls"] as? Int, 1)
        XCTAssertGreaterThanOrEqual(state["calls"] as? Int ?? 0, 1)
        attachScreenshot("desktop-model-switched")
    }

    func testPermissionRemainsActionableWhenTimelineFails() async throws {
        _ = try await post("/timeline-error")
        _ = try await post("/permission")
        try await openSession()
        await waitForPermission("权限：逐次询问")

        XCTAssertTrue(
            app.staticTexts["合成的正文读取失败"].waitForExistence(timeout: 15),
            "时间线读取必须失败，以验证控制能力独立可用"
        )
        let pending = app.buttons["desktop-pending-interactions"]
        XCTAssertTrue(pending.waitForExistence(timeout: 15))
        attachScreenshot("desktop-permission-timeline-error")
        pending.tap()

        let sheet = app.descendants(matching: .any)["desktop-interaction-sheet"]
        XCTAssertTrue(sheet.waitForExistence(timeout: 10))
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "npm test -- fixture"))
                .firstMatch.waitForExistence(timeout: 10)
        )

        XCTAssertTrue(app.buttons["desktop-deny"].exists)
        let allow = app.buttons["desktop-allow-once"]
        XCTAssertTrue(allow.waitForExistence(timeout: 10))
        XCTAssertTrue(allow.isHittable)
        allow.tap()
        await fulfillment(
            of: [expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: allow)],
            timeout: 15
        )

        let state = try await controlState()
        let decisions = try XCTUnwrap(state["decisions"] as? [[String: Any]])
        XCTAssertEqual(decisions.count, 1)
        XCTAssertEqual(decisions.first?["requestId"] as? String, "perm-fixture")
        XCTAssertEqual(decisions.first?["decision"] as? String, "allow-once")
        XCTAssertEqual(state["pendingPermissionCount"] as? Int, 0)
        attachScreenshot("desktop-permission-allowed")
    }

    func testQuestionAnswersAndFailedSubmissionPreserveDraft() async throws {
        _ = try await post("/question")
        try await openSession()
        await waitForPermission("权限：逐次询问")

        let pending = app.buttons["desktop-pending-interactions"]
        XCTAssertTrue(pending.waitForExistence(timeout: 15))
        pending.tap()

        let sheet = app.descendants(matching: .any)["desktop-interaction-sheet"]
        XCTAssertTrue(sheet.waitForExistence(timeout: 10))
        attachScreenshot("desktop-question-sheet-opened")

        tapInSheet(app.buttons["desktop-question-0-option-1"])
        tapInSheet(app.buttons["desktop-question-1-option-0"])
        tapInSheet(app.buttons["desktop-question-1-option-1"])
        let otherIdentifier = "desktop-question-1-other"
        tapInSheet(app.descendants(matching: .any).matching(identifier: otherIdentifier).firstMatch)
        let other = app.descendants(matching: .any).matching(identifier: otherIdentifier).firstMatch
        XCTAssertTrue(other.waitForExistence(timeout: 5))
        other.typeText("free-text")

        _ = try await post("/fail-next-response")
        let submit = app.buttons["desktop-submit-answers"]
        XCTAssertTrue(submit.waitForExistence(timeout: 5))
        submit.tap()

        let failure = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "无法确认")).firstMatch
        XCTAssertTrue(failure.waitForExistence(timeout: 15))
        XCTAssertTrue(submit.exists, "提交失败后交互面板必须保留作答内容")
        attachScreenshot("desktop-question-submit-failed")
        let failedState = try await controlState()
        XCTAssertEqual(failedState["resolverFailures"] as? Int, 1)
        XCTAssertEqual(failedState["pendingQuestionCount"] as? Int, 1)
        XCTAssertEqual((failedState["answers"] as? [[String: Any]])?.count, 0)

        submit.tap()
        await fulfillment(
            of: [expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: submit)],
            timeout: 15
        )

        let state = try await controlState()
        let answers = try XCTUnwrap(state["answers"] as? [[String: Any]])
        XCTAssertEqual(answers.count, 1)
        XCTAssertEqual(answers.first?["requestId"] as? String, "ask-fixture")
        let submitted = try XCTUnwrap(answers.first?["answers"] as? [Any])
        XCTAssertEqual(submitted.count, 2)
        XCTAssertEqual(try XCTUnwrap(submitted[0] as? [String]), ["B"])
        XCTAssertEqual(try XCTUnwrap(submitted[1] as? [String]), ["X", "Y", "free-text"])
        XCTAssertEqual(state["pendingQuestionCount"] as? Int, 0)
        attachScreenshot("desktop-question-answers")
    }

    private func openSession() async throws {
        let row = app.staticTexts[sessionTitle]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(app.staticTexts["desktop-permission-state"].waitForExistence(timeout: 15))
    }

    private func waitForPermission(_ expected: String) async {
        let permission = app.staticTexts["desktop-permission-state"]
        await fulfillment(
            of: [expectation(for: NSPredicate(format: "label == %@", expected), evaluatedWith: permission)],
            timeout: 15
        )
    }

    private func tapInSheet(_ element: XCUIElement, attempts: Int = 8) {
        XCTAssertTrue(element.waitForExistence(timeout: 10))
        for _ in 0..<attempts where !element.isHittable {
            dragSheetUp()
        }
        XCTAssertTrue(element.isHittable, "控件不可点击：\(element)")
        element.tap()
    }

    private func dragSheetUp() {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.78))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.38))
        start.press(forDuration: 0.05, thenDragTo: end)
    }

    private func post(_ path: String) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:18792\(path)")!)
        request.httpMethod = "POST"
        let (data, _) = try await URLSession.shared.data(for: request)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func controlState() async throws -> [String: Any] {
        let (data, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:18792/state")!)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func attachScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
