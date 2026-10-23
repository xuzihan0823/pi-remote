import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Observation

/// 一条待审批卡片及其本地状态（乐观决议后打戳，稍后移除）。
public struct ClaudeInteractionItem: Identifiable, Equatable {
    public var interaction: ClaudeInteraction
    /// allowed / denied / answered / expired；nil = 未决。
    public var resolved: String?
    public var id: String { interaction.id }
}

public struct ClaudeSearchState: Equatable {
    public var query = ""
    public var results: [ClaudeSearchResult] = []
    public var loading = false
    public var fullLoading = false
    public var truncated = false
    public var error: String?
}

/// 搜索命中定位：会话页滚到这条消息并高亮；nonce 让同一条命中可重复触发。
public struct ClaudeFocus: Equatable {
    public var messageId: String
    public var nonce: Int
}

/// 直连 Mac 上 Claude 后端（backend/claude）的客户端：Bearer HTTP + `/ws?token=` WebSocket。
/// 行为对齐 claude-remote App：订阅快照、流式草稿、重连补缺口、审批补拉、搜索跳转、停止/解除占用。
@MainActor
#if !CLAUDE_CLIENT_TESTING
@Observable
#endif
public final class ClaudeClient {
    public static let shared = ClaudeClient()

    public enum Phase: Equatable {
        case idle
        case connecting
        case connected
        case reconnecting(seconds: Int)
        case failed(String)
    }

    static let sessionPage = 50
    static let messagePage = 100

    // MARK: Connection

    public private(set) var phase: Phase = .idle
    public private(set) var connection: ClaudeConnection?
    public private(set) var hostname: String?
    public var isConnected: Bool { phase == .connected }
    public var hasSavedConnection: Bool { connection != nil }

    // MARK: Sessions & projects

    public private(set) var sessions: [ClaudeSessionSummary] = []
    public private(set) var sessionsTotal = 0
    public private(set) var isLoadingSessions = false
    public private(set) var isLoadingMoreSessions = false
    public private(set) var sessionsError: String?
    public private(set) var filter: ClaudeProjectFilter = .all
    public private(set) var catalog = ClaudeProjectCatalog.empty
    public var hasMoreSessions: Bool { sessions.count < sessionsTotal }

    // MARK: Active conversation

    public private(set) var activeSessionId: String?
    public private(set) var transcript = ClaudeTranscript()
    public private(set) var drafts: [ClaudeDraft] = []
    public private(set) var activeStatus: ClaudeSessionStatus = .unknown
    public private(set) var runActive = false
    public private(set) var activeRunId: String?
    /// 最近一次 run 以 error 结束（含 CLI 的 is_error 结果）时的错误信息。
    public private(set) var runError: String?
    public private(set) var isLoadingTranscript = false
    public private(set) var isLoadingOlder = false
    public private(set) var transcriptError: String?
    public private(set) var pendingUserText: String?
    public private(set) var isSending = false
    public private(set) var isStopping = false
    public private(set) var focus: ClaudeFocus?
    /// 一次性提示（停止结果、审批冲突等），视图展示后清掉。
    public var notice: String?

    public var activeSession: ClaudeSessionSummary? { sessions.first { $0.id == activeSessionId } }
    public var isRunning: Bool { runActive || activeStatus == .daemonDriving }
    /// 终端里的 claude 正在驱动该会话、daemon 没有 run：只能「解除占用」，不能发送。
    public var isTerminalDriving: Bool { activeStatus == .terminalDriving && !runActive }
    public var canSend: Bool { isConnected && activeSessionId != nil && !isRunning && !isTerminalDriving && !isSending }

    // MARK: Approvals

    public private(set) var interactions: [ClaudeInteractionItem] = []
    public var unresolvedInteractions: [ClaudeInteractionItem] { interactions.filter { $0.resolved == nil } }
    /// 深链或新审批到达时请求展示审批面板。
    public var approvalSheetRequested = false

    // MARK: Search

    public private(set) var search = ClaudeSearchState()

    // MARK: Private state

    private let session: URLSession
    private var socket: URLSessionWebSocketTask?
    private var socketGeneration = 0
    private var connectionGeneration = 0
    private var reconnectAttempt = 0
    private var reconnectTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var stopped = true
    private var subscriptions: Set<String> = ["*"]
    private var openGeneration = 0
    private var draftClearTask: Task<Void, Never>?
    private var removalTasks: [String: Task<Void, Never>] = [:]
    private var searchGeneration = 0
    private var searchTask: Task<Void, Never>?
    private var sessionsGeneration = 0
    private var focusNonce = 0
    private var pendingDeepLink: ClaudeDeepLink?

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.default
            configuration.timeoutIntervalForRequest = 20
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(configuration: configuration)
        }
        connection = ClaudeConnectionStore.load()
    }

    // MARK: - Connect / disconnect

    /// 配对：依次探测候选地址，第一个通过 /api/health 鉴权的地址生效，凭据写入 Keychain。
    public func pair(with code: ClaudePairingCode) async -> Bool {
        await connect(candidates: code.bases, token: code.token)
    }

    /// 手动输入地址与 Token。
    public func connect(manualBase: String, token: String) async -> Bool {
        switch ClaudePairing.normalizeBase(manualBase) {
        case .failure(let error):
            phase = .failed(error == .insecureServer ? ClaudeAPIError.insecureTransport.localizedDescription : "服务器地址无效")
            return false
        case .success(let url):
            let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
            guard ClaudePairing.isValidToken(trimmed) else {
                phase = .failed("Token 至少 32 个字符，且不能包含空白")
                return false
            }
            return await connect(candidates: [url], token: trimmed)
        }
    }

    /// App 启动或切回 Claude 后端时，用保存的连接恢复。
    public func resumeSavedConnection() {
        guard stopped, let connection else { return }
        start(connection)
    }

    private func connect(candidates: [URL], token: String) async -> Bool {
        stopSocket()
        connectionGeneration += 1
        let generation = connectionGeneration
        phase = .connecting
        do {
            let (base, health) = try await probe(candidates, token: token)
            guard generation == connectionGeneration else { return false }
            let connection = ClaudeConnection(baseURL: base, candidates: candidates, token: token)
            ClaudeConnectionStore.save(connection)
            if self.connection?.token != token || self.connection?.baseURL != base { resetData() }
            self.connection = connection
            hostname = health["hostname"] as? String
            start(connection)
            return true
        } catch {
            guard generation == connectionGeneration else { return false }
            phase = .failed((error as? LocalizedError)?.errorDescription ?? "无法连接 Claude 后端")
            return false
        }
    }

    public func disconnect(forget: Bool = false) {
        stopSocket()
        connectionGeneration += 1
        phase = .idle
        if forget {
            ClaudeConnectionStore.clear()
            connection = nil
            hostname = nil
            resetData()
        }
    }

    /// 回到前台等场景：连接不在时立即重连（不等退避）。
    public func reconnectNow() {
        guard let connection else { return }
        if case .connected = phase { return }
        stopSocket()
        start(connection)
    }

    private func start(_ connection: ClaudeConnection) {
        stopped = false
        reconnectAttempt = 0
        openSocket(connection)
    }

    private func stopSocket() {
        stopped = true
        reconnectTask?.cancel()
        reconnectTask = nil
        heartbeatTask?.cancel()
        heartbeatTask = nil
        socketGeneration += 1
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    private func resetData() {
        sessions = []
        sessionsTotal = 0
        catalog = .empty
        interactions = []
        search = ClaudeSearchState()
        resetConversation(keepSession: false)
    }

    private func probe(_ candidates: [URL], token: String) async throws -> (URL, [String: Any]) {
        var lastError: Error = ClaudeAPIError.network
        for base in candidates {
            guard TransportSecurity.allows(scheme: base.scheme ?? "", host: base.host ?? "") else {
                lastError = ClaudeAPIError.insecureTransport
                continue
            }
            do {
                let health = try await send(ClaudeEndpoints.url(base, "/api/health"), token: token, timeout: 6)
                return (base, health)
            } catch ClaudeAPIError.unauthorized {
                throw ClaudeAPIError.unauthorized
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    // MARK: - WebSocket

    private func openSocket(_ connection: ClaudeConnection) {
        guard !stopped, let url = ClaudeEndpoints.websocket(connection.baseURL, token: connection.token) else {
            phase = .failed(ClaudeAPIError.insecureTransport.localizedDescription)
            return
        }
        if phase != .connected { phase = reconnectAttempt == 0 ? .connecting : phase }
        socketGeneration += 1
        let generation = socketGeneration
        let task = session.webSocketTask(with: url)
        socket = task
        task.resume()
        receive(on: task, generation: generation)
        // 首个 ping 成功即视为已连上：重新订阅、补拉审批、补缺口。
        task.sendPing { [weak self] error in
            Task { @MainActor [weak self] in
                guard let self, generation == self.socketGeneration else { return }
                if error != nil { self.socketFailed(generation: generation) } else { self.socketOpened(generation: generation) }
            }
        }
    }

    private func receive(on task: URLSessionWebSocketTask, generation: Int) {
        task.receive { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self, generation == self.socketGeneration else { return }
                switch result {
                case .failure:
                    self.socketFailed(generation: generation)
                case .success(let message):
                    switch message {
                    case .string(let text):
                        if let frame = ClaudeFrame.decode(text) { self.handle(frame) }
                    case .data(let data):
                        if let frame = ClaudeFrame.decode(String(decoding: data, as: UTF8.self)) { self.handle(frame) }
                    @unknown default:
                        break
                    }
                    self.receive(on: task, generation: generation)
                }
            }
        }
    }

    private func socketOpened(generation: Int) {
        guard generation == socketGeneration, let task = socket else { return }
        reconnectAttempt = 0
        phase = .connected
        for id in subscriptions { sendControl(ClaudeFrame.subscribe(id), on: task) }
        startHeartbeat(generation: generation)
        Task { [weak self] in
            guard let self else { return }
            await self.syncPending()
            await self.refreshSessions()
            await self.refreshCatalog()
            await self.fillGapAfterReconnect()
            await self.applyPendingDeepLink()
        }
    }

    private func socketFailed(generation: Int) {
        guard generation == socketGeneration, !stopped else { return }
        socketGeneration += 1
        heartbeatTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard !stopped, let connection else { return }
        let delay = min(30.0, pow(2.0, Double(reconnectAttempt)))
        reconnectAttempt += 1
        phase = .reconnecting(seconds: Int(delay.rounded(.up)))
        reconnectTask?.cancel()
        let generation = connectionGeneration
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self, !Task.isCancelled, !self.stopped, generation == self.connectionGeneration else { return }
            // 网络可能在 Tailscale / 局域网之间切换：重新探测候选地址再连 WS。
            do {
                let (base, _) = try await self.probe(connection.probeOrder, token: connection.token)
                guard !Task.isCancelled, !self.stopped, generation == self.connectionGeneration else { return }
                if base != connection.baseURL {
                    let updated = ClaudeConnection(baseURL: base, candidates: connection.candidates, token: connection.token)
                    ClaudeConnectionStore.save(updated)
                    self.connection = updated
                }
                self.openSocket(self.connection ?? connection)
            } catch ClaudeAPIError.unauthorized {
                self.stopSocket()
                self.phase = .failed(ClaudeAPIError.unauthorized.localizedDescription)
            } catch {
                self.scheduleReconnect()
            }
        }
    }

    private func startHeartbeat(generation: Int) {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 25_000_000_000)
                guard let self, !Task.isCancelled, generation == self.socketGeneration, let task = self.socket else { return }
                // 半开连接（Wi-Fi 切换、Mac 睡眠）收不到 close：ping 失败就主动重连。
                task.sendPing { [weak self] error in
                    guard error != nil else { return }
                    Task { @MainActor [weak self] in self?.socketFailed(generation: generation) }
                }
            }
        }
    }

    private func sendControl(_ text: String, on task: URLSessionWebSocketTask? = nil) {
        guard let task = task ?? socket else { return }
        task.send(.string(text)) { _ in }
    }

    private func subscribe(_ id: String) {
        subscriptions.insert(id)
        if isConnected { sendControl(ClaudeFrame.subscribe(id)) }
    }

    private func unsubscribe(_ id: String) {
        guard id != "*" else { return }
        subscriptions.remove(id)
        if isConnected { sendControl(ClaudeFrame.unsubscribe(id)) }
    }

    // MARK: - Frames

    func handle(_ frame: ClaudeFrame) {
        switch frame {
        case .message(let sessionId, let message):
            guard sessionId == activeSessionId else { return }
            if message.isUser, message.kind == .text, let pending = pendingUserText,
               message.text?.trimmingCharacters(in: .whitespacesAndNewlines) == pending.trimmingCharacters(in: .whitespacesAndNewlines) {
                pendingUserText = nil
            }
            if message.isAssistantText { drafts = ClaudeStreamDrafts.reconcile(drafts, with: message) }
            transcript.add([message])

        case .stream(let stream):
            guard stream.sessionId == activeSessionId else { return }
            draftClearTask?.cancel()
            if stream.clear {
                // run 结束：落盘消息通常紧跟着到，留一点时间让它先替换，再清残留草稿
                draftClearTask = Task { [weak self] in
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    guard !Task.isCancelled else { return }
                    self?.drafts = []
                }
            } else {
                drafts = ClaudeStreamDrafts.apply(drafts, stream)
            }

        case .status(let sessionId, let status):
            if let index = sessions.firstIndex(where: { $0.id == sessionId }) { sessions[index].status = status }
            if sessionId == activeSessionId { activeStatus = status }

        case .run(let sessionId, let run):
            guard sessionId == activeSessionId else { return }
            switch run.state {
            case .started:
                runActive = true
                activeRunId = run.runId.isEmpty ? nil : run.runId
                runError = nil
            case .done, .error:
                runActive = false
                activeRunId = nil
                pendingUserText = nil
                if run.state == .error {
                    let message = run.error ?? "未知错误"
                    if message == "aborted" { notice = "已停止当前运行" } else { runError = message }
                }
            }

        case .resync(let sessionId):
            guard sessionId == activeSessionId else { return }
            transcript.reset()
            Task { [weak self] in await self?.reloadTail(sessionId: sessionId) }

        case .approval(let interaction):
            if !interactions.contains(where: { $0.id == interaction.id }) {
                interactions.append(ClaudeInteractionItem(interaction: interaction))
                approvalSheetRequested = true
            }

        case .approvalResolved(let interactionId, let status):
            guard let index = interactions.firstIndex(where: { $0.id == interactionId }) else { return }
            interactions[index].resolved = status.isEmpty ? "resolved" : status
            scheduleRemoval(interactionId)
        }
    }

    // MARK: - HTTP

    private func send(_ url: URL?, method: String = "GET", body: [String: Any]? = nil,
                      token explicitToken: String? = nil, timeout: TimeInterval = 20) async throws -> [String: Any] {
        guard let url, let scheme = url.scheme, TransportSecurity.allows(scheme: scheme, host: url.host ?? "") else {
            throw ClaudeAPIError.insecureTransport
        }
        guard let token = explicitToken ?? connection?.token else { throw ClaudeAPIError.unauthorized }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError where error.code == .timedOut {
            throw ClaudeAPIError.timeout
        } catch {
            throw ClaudeAPIError.network
        }
        guard let http = response as? HTTPURLResponse else { throw ClaudeAPIError.invalidResponse }
        let json = ClaudeJSON.object(data)
        guard (200..<300).contains(http.statusCode) else {
            let error = ClaudeAPIError.from(status: http.statusCode, body: json)
            if error == .unauthorized, explicitToken == nil {
                stopSocket()
                phase = .failed(error.localizedDescription)
            }
            throw error
        }
        guard let json else { throw ClaudeAPIError.invalidResponse }
        return json
    }

    private func api(_ build: (URL) -> URL?, method: String = "GET", body: [String: Any]? = nil,
                     timeout: TimeInterval = 20) async throws -> [String: Any] {
        guard let connection else { throw ClaudeAPIError.unauthorized }
        let generation = connectionGeneration
        let result = try await send(build(connection.baseURL), method: method, body: body, timeout: timeout)
        guard generation == connectionGeneration else { throw ClaudeAPIError.connectionChanged }
        return result
    }

    private static func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }

    // MARK: - Sessions & projects

    public func setFilter(_ filter: ClaudeProjectFilter) {
        guard filter != self.filter else { return }
        self.filter = filter
        sessions = []
        sessionsTotal = 0
        Task { await refreshSessions() }
    }

    public func refreshSessions() async {
        sessionsGeneration += 1
        let generation = sessionsGeneration
        let wanted = min(500, max(Self.sessionPage, sessions.count))
        let filter = self.filter
        isLoadingSessions = true
        defer { if generation == sessionsGeneration { isLoadingSessions = false } }
        do {
            let json = try await api { ClaudeEndpoints.sessions($0, limit: wanted, offset: 0, filter: filter) }
            guard generation == sessionsGeneration else { return }
            let page = ClaudeSessionPage(json: json)
            sessions = page.sessions
            sessionsTotal = page.total
            sessionsError = nil
            if let id = activeSessionId, let status = sessions.first(where: { $0.id == id })?.status, !runActive {
                activeStatus = status
            }
        } catch ClaudeAPIError.connectionChanged {
        } catch {
            guard generation == sessionsGeneration else { return }
            sessionsError = Self.message(for: error)
        }
    }

    public func loadMoreSessions() async {
        guard !isLoadingSessions, !isLoadingMoreSessions, hasMoreSessions else { return }
        let generation = sessionsGeneration
        let offset = sessions.count
        let filter = self.filter
        isLoadingMoreSessions = true
        defer { isLoadingMoreSessions = false }
        do {
            let json = try await api { ClaudeEndpoints.sessions($0, limit: Self.sessionPage, offset: offset, filter: filter) }
            guard generation == sessionsGeneration else { return }
            let page = ClaudeSessionPage(json: json)
            sessions = ClaudeSessionSummary.merge(sessions, page.sessions)
            sessionsTotal = page.sessions.isEmpty ? sessions.count : page.total
        } catch {
            if generation == sessionsGeneration { notice = "加载更多失败：\(Self.message(for: error))" }
        }
    }

    public func refreshCatalog() async {
        do {
            catalog = ClaudeProjectCatalog(json: try await api { ClaudeEndpoints.url($0, "/api/projects") })
        } catch {
            // 项目目录拿不到时保留旧值；新建会话页会提示
        }
    }

    // MARK: - Conversation

    private func resetConversation(keepSession: Bool) {
        if !keepSession { activeSessionId = nil }
        transcript.reset()
        drafts = []
        draftClearTask?.cancel()
        activeStatus = .unknown
        runActive = false
        activeRunId = nil
        runError = nil
        transcriptError = nil
        pendingUserText = nil
        isSending = false
        isStopping = false
        focus = nil
    }

    /// 打开会话：订阅（daemon 会补发正在输出的草稿快照）、拉尾页；focusSeq 来自搜索命中。
    public func open(sessionId: String, focusSeq: Int? = nil) {
        if sessionId != activeSessionId {
            if let previous = activeSessionId { unsubscribe(previous) }
            resetConversation(keepSession: false)
            activeSessionId = sessionId
            activeStatus = sessions.first { $0.id == sessionId }?.status ?? .unknown
            runActive = activeStatus == .daemonDriving
            subscribe(sessionId)
            openGeneration += 1
            let generation = openGeneration
            Task { [weak self] in
                guard let self else { return }
                await self.loadInitial(sessionId: sessionId, generation: generation)
                if let focusSeq, generation == self.openGeneration { await self.focus(on: focusSeq) }
            }
        } else if let focusSeq {
            Task { [weak self] in await self?.focus(on: focusSeq) }
        }
    }

    public func closeActiveSession() {
        if let id = activeSessionId { unsubscribe(id) }
        openGeneration += 1
        resetConversation(keepSession: false)
    }

    private func loadInitial(sessionId: String, generation: Int) async {
        isLoadingTranscript = true
        defer { if generation == openGeneration { isLoadingTranscript = false } }
        // 新会话刚创建时 JSONL 可能还没落盘：session_not_found 重试几次
        for attempt in 0..<8 {
            do {
                let json = try await api { ClaudeEndpoints.messages($0, sessionId: sessionId, limit: Self.messagePage) }
                guard generation == openGeneration else { return }
                transcript.applyTail(ClaudeMessagePage(json: json))
                transcriptError = nil
                break
            } catch ClaudeAPIError.http(404, _) where attempt < 7 {
                try? await Task.sleep(nanoseconds: 250_000_000)
                guard generation == openGeneration else { return }
            } catch {
                guard generation == openGeneration else { return }
                transcriptError = Self.message(for: error)
                break
            }
        }
        if !sessions.contains(where: { $0.id == sessionId }) { await refreshSessions() }
        if generation == openGeneration, !runActive, let status = sessions.first(where: { $0.id == sessionId })?.status {
            activeStatus = status
            runActive = status == .daemonDriving
        }
    }

    private func reloadTail(sessionId: String) async {
        do {
            let json = try await api { ClaudeEndpoints.messages($0, sessionId: sessionId, limit: Self.messagePage) }
            guard sessionId == activeSessionId else { return }
            transcript.applyTail(ClaudeMessagePage(json: json))
            transcriptError = nil
        } catch {
            // 拉取失败：等下次重连补缺口或用户翻页
        }
    }

    /// 重连补缺口：拉尾页，无重叠则向前翻直到接上（最多 3 页）。
    private func fillGapAfterReconnect() async {
        guard let sessionId = activeSessionId else { return }
        guard !transcript.isEmpty else {
            await reloadTail(sessionId: sessionId)
            return
        }
        do {
            var page = ClaudeMessagePage(json: try await api { ClaudeEndpoints.messages($0, sessionId: sessionId, limit: Self.messagePage) })
            var collected = page.messages
            var guardCount = 0
            while !transcript.overlaps(page), page.hasMore, let cursor = page.firstSeq, guardCount < 3 {
                guardCount += 1
                page = ClaudeMessagePage(json: try await api {
                    ClaudeEndpoints.messages($0, sessionId: sessionId, limit: Self.messagePage, beforeSeq: cursor)
                })
                collected += page.messages
            }
            guard sessionId == activeSessionId else { return }
            transcript.add(collected)
        } catch {
            // 断线补拉失败，等下次重连
        }
    }

    public func loadOlder() async {
        guard let sessionId = activeSessionId, !isLoadingOlder, transcript.hasMore, let cursor = transcript.firstSeq else { return }
        isLoadingOlder = true
        defer { isLoadingOlder = false }
        do {
            let json = try await api { ClaudeEndpoints.messages($0, sessionId: sessionId, limit: Self.messagePage, beforeSeq: cursor) }
            guard sessionId == activeSessionId else { return }
            transcript.applyOlder(ClaudeMessagePage(json: json))
        } catch {
            notice = "历史加载失败：\(Self.message(for: error))"
        }
    }

    /// 搜索结果定位：向前翻页直到覆盖命中的 seq（最多 40 页），再交给视图滚动高亮。
    public func focus(on seq: Int) async {
        guard let sessionId = activeSessionId else { return }
        var pages = 0
        while transcript.needsOlderPages(toReach: seq), let cursor = transcript.firstSeq, pages < 40 {
            pages += 1
            do {
                let json = try await api { ClaudeEndpoints.messages($0, sessionId: sessionId, limit: Self.messagePage, beforeSeq: cursor) }
                guard sessionId == activeSessionId else { return }
                transcript.applyOlder(ClaudeMessagePage(json: json))
            } catch {
                notice = "定位失败：\(Self.message(for: error))"
                return
            }
        }
        guard let index = transcript.focusIndex(for: seq) else {
            notice = "没有找到命中的消息"
            return
        }
        focusNonce += 1
        focus = ClaudeFocus(messageId: transcript.messages[index].id, nonce: focusNonce)
    }

    @discardableResult
    public func sendMessage(_ raw: String) async -> Bool {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let sessionId = activeSessionId, !text.isEmpty, canSend else { return false }
        isSending = true
        pendingUserText = text
        runError = nil
        defer { isSending = false }
        do {
            let json = try await api({ ClaudeEndpoints.url($0, "/api/sessions/\(ClaudeEndpoints.segment(sessionId))/messages") },
                                     method: "POST", body: ["text": text])
            guard sessionId == activeSessionId else { return true }
            runActive = true
            activeRunId = json["runId"] as? String
            return true
        } catch {
            if sessionId == activeSessionId { pendingUserText = nil }
            notice = "发送失败：\(Self.message(for: error))"
            if case .http(409, _)? = error as? ClaudeAPIError { await refreshSessions() }
            return false
        }
    }

    /// 新建会话：daemon 只接受已知工作目录（项目 cwd 或 home）。返回新会话 id。
    public func createSession(cwd: String, text raw: String) async -> String? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let directory = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !directory.isEmpty else { return nil }
        isSending = true
        defer { isSending = false }
        do {
            let json = try await api({ ClaudeEndpoints.url($0, "/api/sessions") }, method: "POST", body: ["cwd": directory, "text": text])
            guard let sessionId = json["sessionId"] as? String, !sessionId.isEmpty else { throw ClaudeAPIError.invalidResponse }
            open(sessionId: sessionId)
            pendingUserText = text
            runActive = true
            activeRunId = json["runId"] as? String
            Task { [weak self] in
                await self?.refreshSessions()
                await self?.refreshCatalog()
            }
            return sessionId
        } catch {
            notice = "新建失败：\(Self.message(for: error))"
            return nil
        }
    }

    /// 停止 / 解除占用：有 daemon run 时中止；没有 run 但被判为终端驾驶时，daemon 返回 released。
    public func stopOrRelease() async {
        guard let sessionId = activeSessionId, !isStopping else { return }
        isStopping = true
        defer { isStopping = false }
        do {
            let json = try await api({ ClaudeEndpoints.abort($0, sessionId: sessionId) }, method: "POST", body: [:])
            guard sessionId == activeSessionId else { return }
            let status = ClaudeAbortStatus(json: json)
            switch status {
            case .aborted:
                runActive = false
                activeRunId = nil
            case .released, .idle:
                runActive = false
                if activeStatus == .terminalDriving { activeStatus = .idle }
            }
            notice = status.message
        } catch {
            notice = "停止失败：\(Self.message(for: error))"
        }
    }

    public func dismissRunError() { runError = nil }

    // MARK: - Approvals

    /// 与服务端对账：补上漏掉的，去掉已不存在的未决项。每次（重）连上都会调用。
    @discardableResult
    public func syncPending() async -> Set<String>? {
        let list: [ClaudeInteraction]
        do {
            list = ClaudeInteraction.pendingList(json: try await api { ClaudeEndpoints.url($0, "/api/interactions/pending") })
        } catch {
            return nil // 断线 / 旧 daemon 无此端点：保持现状，等下次连上
        }
        let ids = Set(list.map(\.id))
        let kept = interactions.filter { $0.resolved != nil || ids.contains($0.id) }
        let known = Set(kept.map(\.id))
        let fresh = list.filter { !known.contains($0.id) }.map { ClaudeInteractionItem(interaction: $0) }
        if !fresh.isEmpty { approvalSheetRequested = true }
        interactions = kept + fresh
        return ids
    }

    public func decide(_ item: ClaudeInteractionItem, _ decision: ClaudeDecision) async {
        let id = item.id
        mark(id, resolved: decision.optimisticStatus)
        do {
            let json = try await api({ ClaudeEndpoints.decision($0, interactionId: id) }, method: "POST", body: decision.jsonObject)
            if let status = json["status"] as? String { mark(id, resolved: status) }
            scheduleRemoval(id)
        } catch ClaudeAPIError.http(409, _) {
            notice = "该审批已在别处处理"
            scheduleRemoval(id)
        } catch ClaudeAPIError.http(404, _) {
            notice = "审批已不存在或已超时"
            scheduleRemoval(id)
        } catch {
            mark(id, resolved: nil)
            notice = "提交失败：\(Self.message(for: error))"
        }
    }

    /// 深链：把指定审批顶到最前；本地没有就先补拉，仍没有则提示已处理。
    public func focusApproval(_ interactionId: String) async {
        if !interactions.contains(where: { $0.id == interactionId }) {
            guard let ids = await syncPending() else { return }
            guard ids.contains(interactionId) else {
                notice = "这条审批已处理或已超时"
                return
            }
        }
        if let index = interactions.firstIndex(where: { $0.id == interactionId }), index > 0 {
            let item = interactions.remove(at: index)
            interactions.insert(item, at: 0)
        }
        approvalSheetRequested = true
    }

    private func mark(_ id: String, resolved: String?) {
        guard let index = interactions.firstIndex(where: { $0.id == id }) else { return }
        interactions[index].resolved = resolved
        if resolved == nil { removalTasks[id]?.cancel() }
    }

    private func scheduleRemoval(_ id: String) {
        removalTasks[id]?.cancel()
        removalTasks[id] = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled, let self else { return }
            self.interactions.removeAll { $0.id == id && $0.resolved != nil }
            self.removalTasks[id] = nil
        }
    }

    // MARK: - Deep links

    /// 处理 approval / session 深链；未连接时先记下，连上后再执行。setup 由界面确认后调用 pair。
    public func handle(_ link: ClaudeDeepLink) {
        guard isConnected else {
            pendingDeepLink = link
            resumeSavedConnection()
            return
        }
        pendingDeepLink = link
        Task { await applyPendingDeepLink() }
    }

    private func applyPendingDeepLink() async {
        guard let link = pendingDeepLink else { return }
        pendingDeepLink = nil
        switch link {
        case .setup:
            break
        case .approval(let interactionId, let sessionId):
            if let sessionId { open(sessionId: sessionId) }
            await focusApproval(interactionId)
        case .session(let sessionId):
            open(sessionId: sessionId)
        }
    }

    // MARK: - Search

    /// 防抖后分两步：先 meta（标题/路径/最近预览）立即出结果，再 full（扫 JSONL 全文）把正文命中追加在后面。
    public func setSearchQuery(_ raw: String) {
        searchGeneration += 1
        let generation = searchGeneration
        searchTask?.cancel()
        let query = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            search = ClaudeSearchState(query: raw)
            return
        }
        search.query = raw
        search.loading = true
        search.fullLoading = false
        search.truncated = false
        search.error = nil
        searchTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled, let self, generation == self.searchGeneration else { return }
            do {
                let meta = ClaudeSearchResponse(json: try await self.api { ClaudeEndpoints.search($0, query: query, full: false) })
                guard generation == self.searchGeneration else { return }
                self.search.results = meta.results
                self.search.loading = false
                self.search.fullLoading = true
                let full = ClaudeSearchResponse(json: try await self.api({ ClaudeEndpoints.search($0, query: query, full: true) }, timeout: 30))
                guard generation == self.searchGeneration else { return }
                self.search.results = ClaudeSearchResponse.merge(self.search.results, full.results)
                self.search.fullLoading = false
                self.search.truncated = full.truncated
            } catch ClaudeAPIError.connectionChanged {
            } catch {
                guard generation == self.searchGeneration else { return }
                self.search.loading = false
                self.search.fullLoading = false
                self.search.error = "搜索失败：\(Self.message(for: error))"
            }
        }
    }

    public func retrySearch() { setSearchQuery(search.query) }
}
