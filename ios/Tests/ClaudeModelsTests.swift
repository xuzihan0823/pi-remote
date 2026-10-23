import Foundation

/// Claude 后端客户端纯逻辑回归：配对码、深链、WS 帧解码、流式草稿合并、转录分页/定位、搜索结果映射。
///
///     xcrun swiftc -swift-version 5 \
///       ios/PiRemote/Models/TransportSecurity.swift ios/PiRemote/Models/ClaudeModels.swift \
///       ios/Tests/ClaudeModelsTests.swift -o /tmp/pi-remote-claude-tests && /tmp/pi-remote-claude-tests
@main
struct ClaudeModelsTests {
    struct Failure: Error, CustomStringConvertible {
        let message: String
        var description: String { message }
    }

    static let token = String(repeating: "t", count: 64)
    static let sessionId = "0f8fad5b-d9cb-469f-a165-70867728950e"

    static func main() throws {
        try pairing()
        try deepLinks()
        try endpoints()
        try frames()
        try streamDrafts()
        try transcript()
        try search()
        try interactions()
        try responses()
        print("ALL PASS: ClaudeModelsTests")
    }

    // MARK: - Pairing

    static func pairingLink(token: String = token, bases: [String], version: String? = "1") -> String {
        let encodedBases = bases.map { $0.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? $0 }.joined(separator: ",")
        let encodedToken = token.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? token
        let versionPart = version.map { "v=\($0)&" } ?? ""
        return "claude-remote://setup?\(versionPart)token=\(encodedToken)&bases=\(encodedBases)"
    }

    static func pairing() throws {
        let code = try ClaudePairing.parse(pairingLink(bases: ["http://100.101.102.103:8788", "http://192.168.1.20:8788", "http://my-mac.local:8788"]))
        try expect(code.token == token, "token preserved")
        try expect(code.bases.map(\.absoluteString) == ["http://100.101.102.103:8788", "http://192.168.1.20:8788", "http://my-mac.local:8788"],
                   "bases keep daemon priority order: \(code.bases)")

        // 无版本号（旧 daemon）也接受；https 公网地址接受；重复去重
        let https = try ClaudePairing.parse(pairingLink(bases: ["https://claude.example.com/", "https://claude.example.com"], version: nil))
        try expect(https.bases.map(\.absoluteString) == ["https://claude.example.com"], "https bases normalized and deduplicated")

        // 公网明文地址被过滤；只剩安全地址时仍可用
        let mixed = try ClaudePairing.parse(pairingLink(bases: ["http://8.8.8.8:8788", "http://10.0.0.2:8788"]))
        try expect(mixed.bases.map(\.absoluteString) == ["http://10.0.0.2:8788"], "public plaintext base dropped")
        print("PASS: valid pairing codes keep token and private/TLS bases in order")

        try expectPairingError(pairingLink(bases: ["http://8.8.8.8:8788", "http://relay.example.com"]), .insecureServer)
        try expectPairingError(pairingLink(bases: []), .invalidServer)
        try expectPairingError(pairingLink(bases: ["ftp://10.0.0.2", "http://user:pw@10.0.0.2:8788", "http://10.0.0.2:8788/?x=1"]), .invalidServer)
        try expectPairingError(pairingLink(bases: ["http://10.0.0.2:8788"], version: "2"), .unsupportedVersion)
        try expectPairingError(pairingLink(token: "short", bases: ["http://10.0.0.2:8788"]), .invalidToken)
        try expectPairingError(pairingLink(token: token + " x", bases: ["http://10.0.0.2:8788"]), .invalidToken)
        for invalid in ["", "{}", "https://example.com/setup", "claude-remote://approval/abc", "claude-remote://setupx?token=a",
                        String(repeating: "x", count: 5000)] {
            try expectPairingError(invalid, .invalidCode)
        }
        print("PASS: malformed, insecure, unsupported and bad-token pairing codes are rejected")

        // 手动输入地址：缺 scheme 自动补 http，去尾斜杠
        guard case .success(let manual) = ClaudePairing.normalizeBase("192.168.1.20:8788/") else { throw Failure(message: "manual base") }
        try expect(manual.absoluteString == "http://192.168.1.20:8788", "manual base gets http:// and loses trailing slash")
        guard case .failure(.insecureServer) = ClaudePairing.normalizeBase("http://claude.example.com") else { throw Failure(message: "public http") }
        guard case .success = ClaudePairing.normalizeBase("http://mac.tail1234.ts.net:8788") else { throw Failure(message: "ts.net") }
        guard case .failure(.invalidServer) = ClaudePairing.normalizeBase("ws://10.0.0.1") else { throw Failure(message: "ws scheme") }
        print("PASS: manual server addresses are normalized and follow the transport rule")
    }

    static func expectPairingError(_ raw: String, _ expected: ClaudePairing.ParseError) throws {
        do {
            _ = try ClaudePairing.parse(raw)
        } catch let error as ClaudePairing.ParseError {
            try expect(error == expected, "expected \(expected), got \(error) for \(raw.prefix(80))")
            return
        }
        throw Failure(message: "accepted invalid pairing code \(raw.prefix(80)); expected \(expected)")
    }

    // MARK: - Deep links

    static func deepLinks() throws {
        try expect(ClaudeDeepLink.parse("claude-remote://approval/abc-123?session=\(sessionId)") ==
                   .approval(interactionId: "abc-123", sessionId: sessionId), "approval link with session")
        try expect(ClaudeDeepLink.parse("claude-remote://approval/abc-123") == .approval(interactionId: "abc-123", sessionId: nil),
                   "approval link without session")
        try expect(ClaudeDeepLink.parse("claude-remote://approval/abc?session=../../etc") == .approval(interactionId: "abc", sessionId: nil),
                   "bad session id in approval link dropped")
        try expect(ClaudeDeepLink.parse("claude-remote://session/\(sessionId)") == .session(sessionId: sessionId), "session link")
        try expect(ClaudeDeepLink.parse("claude-remote://session/not-a-uuid") == nil, "non-uuid session rejected")
        try expect(ClaudeDeepLink.parse("claude-remote://approval/a%2Fb") == nil, "encoded slash in interaction id rejected")
        try expect(ClaudeDeepLink.parse("https://example.com/session/\(sessionId)") == nil, "other schemes ignored")
        if case .setup(let code)? = ClaudeDeepLink.parse(pairingLink(bases: ["http://10.0.0.2:8788"])) {
            try expect(code.token == token, "setup link carries pairing code")
        } else {
            throw Failure(message: "setup deep link not parsed")
        }
        print("PASS: approval, session and setup deep links parse; unsafe ids rejected")
    }

    // MARK: - Endpoints

    static func endpoints() throws {
        let base = URL(string: "http://10.0.0.2:8788")!
        try expect(ClaudeEndpoints.websocket(base, token: "a+b/c=")?.absoluteString == "ws://10.0.0.2:8788/ws?token=a%2Bb/c%3D" ||
                   ClaudeEndpoints.websocket(base, token: "a+b/c=")?.absoluteString == "ws://10.0.0.2:8788/ws?token=a%2Bb/c=",
                   "ws endpoint encodes + in token: \(ClaudeEndpoints.websocket(base, token: "a+b/c=")?.absoluteString ?? "nil")")
        try expect(ClaudeEndpoints.websocket(URL(string: "https://claude.example.com")!, token: "x")?.absoluteString == "wss://claude.example.com/ws?token=x",
                   "https base upgrades to wss")
        try expect(ClaudeEndpoints.websocket(URL(string: "http://claude.example.com")!, token: "x") == nil, "public http refuses ws")
        try expect(ClaudeEndpoints.messages(base, sessionId: sessionId, limit: 100, beforeSeq: 42)?.absoluteString ==
                   "http://10.0.0.2:8788/api/sessions/\(sessionId)/messages?limit=100&beforeSeq=42", "messages paging url")
        try expect(ClaudeEndpoints.sessions(base, limit: 50, offset: 0, filter: .unclassified)?.absoluteString ==
                   "http://10.0.0.2:8788/api/sessions?limit=50&offset=0&projectId=", "unclassified filter sends empty projectId")
        let search = ClaudeEndpoints.search(base, query: "a+b c", full: true)?.absoluteString ?? ""
        try expect(search == "http://10.0.0.2:8788/api/sessions/search?q=a%2Bb%20c&limit=30&full=1", "search url encodes query: \(search)")
        try expect(ClaudeEndpoints.decision(base, interactionId: "x/y")?.absoluteString == "http://10.0.0.2:8788/api/interactions/x%2Fy/decision",
                   "interaction id is path-encoded")
        print("PASS: REST and WS endpoints are built with encoded ids, queries and secure schemes")
    }

    // MARK: - Frames

    static func frames() throws {
        let message = """
        {"type":"message","sessionId":"\(sessionId)","message":{"seq":12,"blockIndex":1,"uuid":"u1","parentUuid":null,"role":"assistant","kind":"tool_use","toolName":"Bash","toolInput":{"command":"ls"},"toolUseId":"t1"}}
        """
        guard case .message(let sid, let decoded)? = ClaudeFrame.decode(message) else { throw Failure(message: "message frame") }
        try expect(sid == sessionId && decoded.id == "12:1" && decoded.kind == .toolUse && decoded.toolName == "Bash", "message fields")
        try expect(decoded.toolInputPreview?.contains("\"command\" : \"ls\"") == true, "tool input preview: \(decoded.toolInputPreview ?? "nil")")

        try expect(ClaudeFrame.decode(#"{"type":"stream","sessionId":"s","key":"m:0","offset":3,"text":"lo","done":true}"#) ==
                   .stream(ClaudeStreamFrame(sessionId: "s", key: "m:0", offset: 3, text: "lo", done: true)), "stream delta frame")
        try expect(ClaudeFrame.decode(#"{"type":"stream","sessionId":"s","clear":true}"#) == .stream(ClaudeStreamFrame(sessionId: "s", clear: true)),
                   "stream clear frame")
        try expect(ClaudeFrame.decode(#"{"type":"status","sessionId":"s","status":"terminal-driving"}"#) == .status(sessionId: "s", .terminalDriving),
                   "status frame")
        try expect(ClaudeFrame.decode(#"{"type":"run","sessionId":"s","runId":"r","state":"error","error":"model unavailable"}"#) ==
                   .run(sessionId: "s", ClaudeRunEvent(runId: "r", state: .error, error: "model unavailable", permissionMode: nil)), "run error frame")
        try expect(ClaudeFrame.decode(#"{"type":"resync","sessionId":"s"}"#) == .resync(sessionId: "s"), "resync frame")
        try expect(ClaudeFrame.decode(#"{"type":"approval.resolved","interactionId":"i","status":"expired"}"#) ==
                   .approvalResolved(interactionId: "i", status: "expired"), "approval.resolved frame")
        let approval = #"{"type":"approval","interaction":{"interactionId":"i1","sessionId":"s","kind":"approval","toolName":"Edit","input":{"file":"a"},"prompt":"Edit a","expiresAt":1893456000000}}"#
        guard case .approval(let card)? = ClaudeFrame.decode(approval) else { throw Failure(message: "approval frame") }
        try expect(card.id == "i1" && card.kind == .approval && card.toolName == "Edit" &&
                   card.expiresAt == Date(timeIntervalSince1970: 1_893_456_000), "approval card fields")

        for invalid in ["", "nope", "[]", #"{"type":"message","sessionId":"s","message":{"seq":"1","role":"assistant"}}"#,
                        #"{"type":"message","sessionId":"s","message":{"seq":true,"role":"assistant","kind":"text"}}"#,
                        #"{"type":"run","sessionId":"s","state":"weird"}"#, #"{"type":"stream","key":"k","text":"x"}"#,
                        #"{"type":"future_frame","sessionId":"s"}"#] {
            try expect(ClaudeFrame.decode(invalid) == nil, "invalid frame ignored: \(invalid)")
        }
        try expect(ClaudeFrame.subscribe("*").contains("\"type\":\"subscribe\""), "subscribe control frame")
        print("PASS: message/stream/status/run/resync/approval frames decode; malformed and unknown frames are ignored")
    }

    // MARK: - Stream drafts

    static func streamDrafts() throws {
        var drafts: [ClaudeDraft] = []
        drafts = ClaudeStreamDrafts.apply(drafts, ClaudeStreamFrame(sessionId: "s", key: "m:0", offset: 2, text: "lo"))
        try expect(drafts.isEmpty, "mid-stream frame without a start waits for the snapshot")
        drafts = ClaudeStreamDrafts.apply(drafts, ClaudeStreamFrame(sessionId: "s", key: "m:0", offset: 0, text: "Hel"))
        drafts = ClaudeStreamDrafts.apply(drafts, ClaudeStreamFrame(sessionId: "s", key: "m:0", offset: 3, text: "lo 世界"))
        try expect(drafts == [ClaudeDraft(key: "m:0", text: "Hello 世界", done: false)], "deltas append at offset: \(drafts)")
        let gap = ClaudeStreamDrafts.apply(drafts, ClaudeStreamFrame(sessionId: "s", key: "m:0", offset: 99, text: "x"))
        try expect(gap == drafts, "gap frame dropped")
        drafts = ClaudeStreamDrafts.apply(drafts, ClaudeStreamFrame(sessionId: "s", key: "m:0", offset: 5, text: "!", done: true))
        try expect(drafts.first?.text == "Hello!" && drafts.first?.done == true, "overlapping offset rewrites tail and marks done")
        drafts = ClaudeStreamDrafts.apply(drafts, ClaudeStreamFrame(sessionId: "s", key: "m:1", offset: 0, text: "Second"))
        // 订阅快照（offset 0）整段替换
        drafts = ClaudeStreamDrafts.apply(drafts, ClaudeStreamFrame(sessionId: "s", key: "m:1", offset: 0, text: "Second block", done: false))
        try expect(drafts.map(\.text) == ["Hello!", "Second block"], "snapshot replaces whole draft")

        // 落盘消息替换草稿：完全一致（忽略空白差异）或已完成草稿的前缀匹配
        let persisted = ClaudeMessage(seq: 5, role: "assistant", kind: .text, text: "Hello!\n")
        drafts = ClaudeStreamDrafts.reconcile(drafts, with: persisted)
        try expect(drafts.map(\.key) == ["m:1"], "persisted assistant text removes matching draft")
        let userEcho = ClaudeMessage(seq: 6, role: "user", kind: .text, text: "Second block")
        try expect(ClaudeStreamDrafts.reconcile(drafts, with: userEcho) == drafts, "user messages never remove drafts")
        let unfinishedPrefix = ClaudeMessage(seq: 7, role: "assistant", kind: .text, text: "Second block and more")
        try expect(ClaudeStreamDrafts.reconcile(drafts, with: unfinishedPrefix) == drafts, "prefix match requires a finished draft")
        drafts[0].done = true
        try expect(ClaudeStreamDrafts.reconcile(drafts, with: unfinishedPrefix).isEmpty, "finished draft matched by prefix")
        try expect(ClaudeStreamDrafts.apply([ClaudeDraft(key: "a", text: "x", done: false)], ClaudeStreamFrame(sessionId: "s", clear: true)).isEmpty,
                   "clear frame drops all drafts")
        print("PASS: stream drafts merge by offset, ignore gaps, and are replaced by persisted messages")
    }

    // MARK: - Transcript

    static func transcript() throws {
        func msg(_ seq: Int, _ block: Int = 0, _ text: String = "") -> ClaudeMessage {
            ClaudeMessage(seq: seq, blockIndex: block, role: seq.isMultiple(of: 2) ? "assistant" : "user", kind: .text, text: text)
        }
        var transcript = ClaudeTranscript()
        transcript.applyTail(ClaudeMessagePage(messages: [msg(101), msg(102), msg(102, 1), msg(103)], firstSeq: 101, hasMore: true))
        try expect(transcript.messages.map(\.id) == ["101:0", "102:0", "102:1", "103:0"], "tail page sorted")
        try expect(transcript.add([msg(103), msg(104)]), "live message appended")
        try expect(!transcript.add([msg(104)]), "duplicate live message ignored")
        transcript.applyOlder(ClaudeMessagePage(messages: [msg(60), msg(99, 2), msg(99, 0)], firstSeq: 55, hasMore: true))
        try expect(transcript.messages.first?.id == "60:0" && transcript.messages[1].id == "99:0" && transcript.firstSeq == 55,
                   "older page merged in order")
        try expect(transcript.needsOlderPages(toReach: 20), "focus target before loaded range needs more pages")
        try expect(!transcript.needsOlderPages(toReach: 70), "focus target inside loaded range")
        try expect(transcript.focusIndex(for: 99) == 1, "focus exact seq")
        try expect(transcript.focusIndex(for: 100) == 3, "focus falls through to next rendered message (101)")
        try expect(transcript.focusIndex(for: 500) == nil, "focus beyond end")
        try expect(transcript.overlaps(ClaudeMessagePage(messages: [msg(104), msg(105)], firstSeq: 104, hasMore: true)), "reconnect overlap")
        try expect(!transcript.overlaps(ClaudeMessagePage(messages: [msg(200)], firstSeq: 200, hasMore: true)), "reconnect gap detected")
        transcript.reset()
        try expect(transcript.isEmpty && transcript.firstSeq == nil, "reset (resync) clears transcript")

        let page = ClaudeMessagePage(json: ["messages": [["seq": 3, "role": "user", "kind": "text", "text": "hi"],
                                                         ["seq": 0, "role": "user", "kind": "text"],
                                                         ["seq": 4, "role": "system", "kind": "text"]],
                                            "firstSeq": 3, "hasMore": false])
        try expect(page.messages.count == 1 && page.firstSeq == 3 && !page.hasMore, "message page drops invalid rows")
        print("PASS: transcript dedupes, orders, pages older history and locates search hits")
    }

    // MARK: - Search

    static func search() throws {
        func row(_ id: String, field: String, seq: Int? = nil) -> [String: Any] {
            var match: [String: Any] = ["field": field, "snippet": "…\(field)…"]
            if let seq { match["seq"] = seq }
            return ["sessionId": id, "cwd": "/Users/me/app", "projectDirName": "-Users-me-app", "title": "T \(id)",
                    "lastPreview": "", "lastActiveAt": 1_700_000_000_000, "sizeBytes": 10, "status": "idle", "match": match]
        }
        let meta = ClaudeSearchResponse(json: ["results": [row("a", field: "title"), row("b", field: "cwd")], "truncated": false])
        let full = ClaudeSearchResponse(json: ["results": [row("b", field: "content", seq: 9), row("c", field: "content", seq: 42),
                                                           ["match": ["field": "content"]]], "truncated": true])
        try expect(full.truncated && full.results.count == 2, "rows without sessionId dropped")
        let merged = ClaudeSearchResponse.merge(meta.results, full.results)
        try expect(merged.map(\.id) == ["a", "b", "c"], "meta results win, full results appended without duplicates")
        try expect(merged[1].field == .cwd, "meta match kept for duplicate session")
        try expect(merged[2].target == ClaudeSessionTarget(sessionId: "c", focusSeq: 42), "content hit jumps to seq")
        try expect(merged[0].target == ClaudeSessionTarget(sessionId: "a", focusSeq: nil), "title hit opens session without focus")
        try expect(merged[2].field.label == "正文" && merged[0].session.status == .idle, "labels and status mapped")
        try expect(merged[0].session.lastActiveAt == Date(timeIntervalSince1970: 1_700_000_000), "lastActiveAt is epoch ms")
        print("PASS: search results map to sessions, merge meta+full, and carry jump targets")
    }

    // MARK: - Interactions

    static func interactions() throws {
        let pending = ClaudeInteraction.pendingList(json: ["interactions": [
            ["interactionId": "late", "sessionId": "s", "kind": "approval", "toolName": "Bash", "input": ["command": "rm -rf build"],
             "prompt": "Run", "expiresAt": 2_000],
            ["interactionId": "soon", "sessionId": "s", "kind": "question", "toolName": "AskUserQuestion", "input": [:], "prompt": "",
             "expiresAt": 1_000, "questions": [["question": "Which?", "header": "Pick", "multiSelect": true,
                                                "options": [["label": "A", "description": "a"], ["label": "B", "description": "b"]]]]],
            ["interactionId": "", "sessionId": "s", "kind": "approval"],
        ]])
        try expect(pending.map(\.id) == ["soon", "late"], "pending sorted by expiry, invalid dropped")
        try expect(pending[0].questions.first?.options.map(\.label) == ["A", "B"] && pending[0].questions.first?.multiSelect == true,
                   "question options decoded")

        let questions = pending[0].questions
        try expect(ClaudeDecision.answers(for: questions, selections: [:], freeText: [:]) == nil, "unanswered question blocks submit")
        try expect(ClaudeDecision.answers(for: questions, selections: ["Which?": ["A", "B"]], freeText: [:]) == ["Which?": "A, B"], "multi-select joined")
        try expect(ClaudeDecision.answers(for: questions, selections: ["Which?": ["A"]], freeText: ["Which?": " custom "]) == ["Which?": "custom"],
                   "free text wins")
        try expect(ClaudeDecision.allowOnce.jsonObject["type"] as? String == "allow_once", "allow_once body")
        try expect(ClaudeDecision.deny(message: "  ").jsonObject["message"] == nil, "blank deny message omitted")
        try expect((ClaudeDecision.answer(["q": "a"]).jsonObject["answers"] as? [String: String]) == ["q": "a"], "answer body")
        print("PASS: approvals/questions decode, sort by expiry and build decision bodies")
    }

    // MARK: - Other responses

    static func responses() throws {
        try expect(ClaudeAbortStatus(json: ["runId": NSNull(), "status": "released"]) == .released, "abort released (terminal driving)")
        try expect(ClaudeAbortStatus(json: ["runId": "r", "status": "aborted"]) == .aborted, "abort aborted")
        try expect(ClaudeAbortStatus(json: [:]) == .idle, "abort default idle")

        let catalog = ClaudeProjectCatalog(json: [
            "projects": [["id": "/Users/me/a/app", "name": "app", "cwd": "", "cwds": ["/Users/me/a/app", "/Users/me/a/app/web"], "sessionCount": 3, "lastActiveAt": 5],
                         ["id": "/Users/me/b/app", "cwd": "/Users/me/b/app", "cwds": [], "sessionCount": 1]],
            "totalSessions": 6, "unclassifiedCount": 2, "homeCwd": "/Users/me",
        ])
        try expect(catalog.projects.count == 2 && catalog.projects[0].cwd == "/Users/me/a/app", "empty cwd falls back to first cwd")
        try expect(catalog.projects[1].name == "app" && catalog.projects[1].cwds == ["/Users/me/b/app"], "missing name uses path tail; cwd added to cwds")
        try expect(catalog.title(for: catalog.projects[0]) == "app · a" && catalog.title(for: catalog.projects[1]) == "app · b", "duplicate names disambiguated")
        try expect(catalog.project(forCwd: "/Users/me/a/app/web")?.id == "/Users/me/a/app", "project for sub-cwd")
        try expect(catalog.selectableCwds == ["/Users/me/a/app", "/Users/me/a/app/web", "/Users/me/b/app", "/Users/me"], "selectable cwds include home")
        try expect(ClaudeProjectCatalog.shortPath("/Users/me/a/app") == "~/a/app" && ClaudeProjectCatalog.shortPath("/opt/x") == "/opt/x", "short path")

        let sessions = ClaudeSessionPage(json: ["sessions": [["sessionId": "x", "title": "", "status": "daemon-driving"], ["title": "no id"]], "total": 9])
        try expect(sessions.sessions.count == 1 && sessions.total == 9 && sessions.sessions[0].title == "(空会话)" &&
                   sessions.sessions[0].status == .daemonDriving, "session page decode")
        let merged = ClaudeSessionSummary.merge([ClaudeSessionSummary(id: "x", status: .idle), ClaudeSessionSummary(id: "y")],
                                                [ClaudeSessionSummary(id: "x", status: .terminalDriving), ClaudeSessionSummary(id: "z")])
        try expect(merged.map(\.id) == ["x", "y", "z"] && merged[0].status == .terminalDriving, "session pages merge in place")

        try expect(ClaudeAPIError.from(status: 401, body: nil) == .unauthorized, "401 → unauthorized")
        try expect(ClaudeAPIError.from(status: 409, body: ["error": "not_idle"]) == .http(status: 409, code: "not_idle"), "error code from body")
        print("PASS: abort status, project catalog, session pages and API errors map correctly")
    }

    static func expect(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(message: message) }
    }
}
