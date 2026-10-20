import Foundation

@main
struct DesktopControlsTests {
    struct Failure: Error { let message: String }

    static func main() throws {
        try decodesQuestionSetsAndPreservesLabels()
        try interactionIdentityIncludesSession()
        try permissionDisplayDoesNotGuessUnknownModes()
        try rejectsMalformedSnapshotsInsteadOfEmptyState()
        try oldSessionsStillExposePermission()
        try decodesModelAndActivity()
        try remotePendingApprovalIsMerged()
        print("PASS: Desktop controls 解码、权限文案、交互身份与 pending 标记全部通过")
    }

    static func decodesQuestionSetsAndPreservesLabels() throws {
        let interaction = try require(DesktopInteraction(remote: [
            "kind": "question",
            "requestId": "req-1",
            "sessionId": "managed:desktop:session-1",
            "questions": [
                [
                    "question": "选择要保留的文件",
                    "multiSelect": false,
                    "options": [
                        ["label": "Keep original label", "description": "这是真实说明"],
                        ["label": "删除"],
                    ],
                ],
                [
                    "question": "选择多个目标",
                    "multiSelect": true,
                    "options": [
                        ["label": "Alpha", "description": "第一项"],
                        ["label": "Beta"],
                    ],
                ],
            ],
        ]))
        try expect(interaction.id == "managed:desktop:session-1:req-1", "交互 id 必须由会话和 requestId 组成")
        guard case .question(let request) = interaction.kind else {
            throw Failure(message: "kind=question 应解析为问题")
        }
        try expect(request.questions.count == 2, "保留全部题目")
        try expect(request.questions[0].multiSelect == false, "第一题单选")
        try expect(request.questions[1].multiSelect, "第二题多选")
        try expect(request.questions[0].question == "选择要保留的文件", "保留真实题目")
        let first = request.questions[0].options[0]
        try expect(first.label == "Keep original label", "选项 label 不改写")
        try expect(first.description == "这是真实说明", "选项说明保留")
        try expect(request.questions[0].options[1].description == nil, "缺失说明为 nil")
        try expect(request.questions[1].options.map(\.label) == ["Alpha", "Beta"], "多选选项顺序与真实 label 保持")
    }

    static func interactionIdentityIncludesSession() throws {
        func permission(session: String) -> DesktopInteraction {
            DesktopInteraction(remote: [
                "kind": "permission",
                "requestId": "same-request",
                "sessionId": session,
                "toolName": "shell",
                "reason": "需要执行命令",
            ])!
        }
        let first = permission(session: "managed:desktop:a")
        let second = permission(session: "managed:desktop:b")
        try expect(first.id != second.id, "相同 requestId 在不同会话必须有不同的身份")
        try expect(first.requestId == second.requestId && first.sessionId != second.sessionId, "不能靠 requestId 混淆会话")
        try expect(first.id.hasPrefix("managed:desktop:a:"), "身份必须以真实会话 id 开头")
    }

    static func permissionDisplayDoesNotGuessUnknownModes() throws {
        let unknown = DesktopPermissionState(remote: ["mode": "future-mode", "effectiveMode": "auto"])
        try expect(unknown.mode == nil && unknown.effectiveMode == .auto, "未知模式不强行映射")
        try expect(unknown.displayText == "未知", "未知模式显示未知，不能从有效模式推测")

        let missing = DesktopPermissionState(remote: [:])
        try expect(missing.displayText == "未知", "缺失模式显示未知")

        let inherit = DesktopPermissionState(remote: ["mode": "inherit", "effectiveMode": "accept-edits"])
        try expect(inherit.displayText == "跟随全局·自动接受编辑", "inherit 显示跟随全局与有效模式")
        try expect(DesktopPermissionState(remote: ["mode": "inherit"]).displayText == "跟随全局·未知", "缺失有效模式不推测")

        try expect(DesktopPermissionState(remote: ["mode": "ask", "effectiveMode": "ask"]).displayText == "逐次询问", "ask 文案")
        try expect(DesktopPermissionState(remote: ["mode": "accept-edits", "effectiveMode": "accept-edits"]).displayText == "自动接受编辑", "accept-edits 文案")
        try expect(DesktopPermissionState(remote: ["mode": "auto", "effectiveMode": "auto"]).displayText == "自动审批", "auto 文案")
    }

    static func rejectsMalformedSnapshotsInsteadOfEmptyState() throws {
        func snapshot(_ pending: Any?) -> [String: Any] {
            var remote: [String: Any] = [
                "sessionId": "managed:desktop:s1",
                "permission": ["mode": "ask", "effectiveMode": "ask"],
                "model": NSNull(),
                "interactionsSupported": false,
                "canControl": true,
                "activity": "idle",
            ]
            if let pending { remote["pendingInteractions"] = pending }
            return remote
        }
        let empty = try require(DesktopControlsSnapshot(remote: snapshot([])))
        try expect(empty.pendingInteractions.isEmpty && !empty.interactionsSupported, "flag=false 且空数组是合法旧快照")
        try expect(DesktopControlsSnapshot(remote: snapshot(nil)) == nil, "缺失 pendingInteractions 不能伪造空快照")
        try expect(DesktopControlsSnapshot(remote: snapshot("not-an-array")) == nil, "非数组 pendingInteractions 不能伪造空快照")
        try expect(DesktopControlsSnapshot(remote: snapshot([["kind": "question"]])) == nil, "缺标识的成员必须拒绝整个快照")
        try expect(DesktopInteraction.list("not-an-array") == nil, "列表解码失败返回 nil 而不是空数组")
        try expect(DesktopInteraction.list([]) == [], "真实空数组才是空列表")

        let plainTextQuestion: [String: Any] = [
            "kind": "question", "requestId": "r", "sessionId": "managed:desktop:s1",
            "questions": [["question": "请直接输入", "multiSelect": false, "options": []]],
        ]
        let plainText = try require(DesktopControlsSnapshot(remote: snapshot([plainTextQuestion])))
        let plainTextInteraction = try require(plainText.pendingInteractions.first)
        guard case .question(let plainTextRequest) = plainTextInteraction.kind else {
            throw Failure(message: "纯文本题目应保留为 question")
        }
        try expect(plainTextRequest.questions.first?.options.isEmpty == true, "真实 Desktop 允许纯文本题目使用空选项")

        let emptyQuestions: [String: Any] = [
            "kind": "question", "requestId": "r", "sessionId": "managed:desktop:s1",
            "questions": [],
        ]
        try expect(DesktopControlsSnapshot(remote: snapshot([emptyQuestions])) == nil, "空题目数组必须拒绝")

        let badOption: [String: Any] = [
            "kind": "question", "requestId": "r", "sessionId": "managed:desktop:s1",
            "questions": [["question": "坏选项", "multiSelect": false, "options": [["description": "缺 label"]]]],
        ]
        try expect(DesktopControlsSnapshot(remote: snapshot([badOption])) == nil, "缺 label 的选项不能被忽略")

        let missingMultiSelect: [String: Any] = [
            "kind": "question", "requestId": "r", "sessionId": "managed:desktop:s1",
            "questions": [["question": "缺 multiSelect", "options": [["label": "A"]]]],
        ]
        try expect(DesktopControlsSnapshot(remote: snapshot([missingMultiSelect])) == nil, "缺 multiSelect 的题目必须拒绝")

        let wrongSession: [String: Any] = [
            "kind": "permission", "requestId": "r", "sessionId": "terminal:x",
            "toolName": "shell", "reason": "x",
        ]
        try expect(DesktopControlsSnapshot(remote: snapshot([wrongSession])) == nil, "非 desktop 会话 id 无效")

        let badKind: [String: Any] = [
            "kind": "future", "requestId": "r", "sessionId": "managed:desktop:s1",
        ]
        try expect(DesktopControlsSnapshot(remote: snapshot([badKind])) == nil, "未知 kind 不能解析")

        let crossSession: [String: Any] = [
            "kind": "permission", "requestId": "other-session", "sessionId": "managed:desktop:s2",
            "toolName": "shell", "reason": "x",
        ]
        try expect(DesktopControlsSnapshot(remote: snapshot([crossSession])) == nil,
                   "pending 必须全部属于快照 sessionId")

        let duplicateRequest: [String: Any] = [
            "kind": "permission", "requestId": "duplicate", "sessionId": "managed:desktop:s1",
            "toolName": "shell", "reason": "x",
        ]
        try expect(DesktopControlsSnapshot(remote: snapshot([duplicateRequest, duplicateRequest])) == nil,
                   "同一快照内 requestId 不能重复")
    }

    static func oldSessionsStillExposePermission() throws {
        let snapshot = try require(DesktopControlsSnapshot(remote: [
            "sessionId": "managed:desktop:old",
            "permission": ["mode": "inherit", "effectiveMode": "ask"],
            "model": NSNull(),
            "pendingInteractions": [],
            "interactionsSupported": false,
            "canControl": false,
            "activity": "idle",
        ]))
        try expect(snapshot.permission.displayText == "跟随全局·逐次询问", "旧会话即使不支持交互也必须显示权限")
        try expect(snapshot.pendingInteractions.isEmpty && snapshot.model == nil, "旧快照空 pending 与空 model")
        try expect(!snapshot.interactionsSupported && !snapshot.canControl, "旧快照控制标志原样保留")
    }

    static func decodesModelAndActivity() throws {
        let snapshot = try require(DesktopControlsSnapshot(remote: [
            "sessionId": "managed:desktop:model",
            "permission": ["mode": "auto", "effectiveMode": "auto"],
            "model": ["provider": "openai", "modelId": "gpt-5", "name": "GPT-5"],
            "pendingInteractions": [],
            "interactionsSupported": true,
            "canControl": true,
            "activity": "busy",
        ]))
        try expect(snapshot.model?.provider == "openai" && snapshot.model?.modelId == "gpt-5" && snapshot.model?.name == "GPT-5", "模型原样解析")
        try expect(snapshot.activity == .busy && snapshot.canControl && snapshot.interactionsSupported, "canControl/activity 保留")

        try expect(DesktopControlsSnapshot(remote: [
            "sessionId": "managed:desktop:model",
            "permission": ["mode": "auto", "effectiveMode": "auto"],
            "model": ["provider": ""],
            "pendingInteractions": [],
            "interactionsSupported": true,
            "canControl": true,
            "activity": "idle",
        ]) == nil, "破损模型不能让快照退化为空模型")
    }

    static func remotePendingApprovalIsMerged() throws {
        let remotePending = try require(SessionItem(remote: [
            "sessionId": "managed:desktop:p1", "hasPendingApproval": true,
        ]))
        try expect(remotePending.hasPendingApproval, "远端 pending 标记不能丢")
        try expect(remotePending.status == .approval, "远端 pending 标记参与会话状态")

        let localPending = try require(SessionItem(remote: [
            "sessionId": "managed:desktop:p2", "hasPendingApproval": false,
        ], hasPendingApproval: true))
        try expect(localPending.hasPendingApproval, "本地 pending 与远端标记合并")

        let neither = try require(SessionItem(remote: ["sessionId": "managed:desktop:p3"]))
        try expect(!neither.hasPendingApproval, "缺失远端标记按 false")
    }

    private static func require<T>(_ value: T?) throws -> T {
        guard let value else { throw Failure(message: "Expected a value, got nil") }
        return value
    }

    private static func expect(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(message: message) }
    }
}
