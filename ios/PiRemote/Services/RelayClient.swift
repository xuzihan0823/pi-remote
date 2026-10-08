import Foundation
import Observation

@MainActor
#if !RELAY_CLIENT_TESTING
@Observable
#endif
public final class RelayClient {
    public static let shared = RelayClient()

    public enum ConnectionState: Equatable {
        case idle
        case connecting
        case connected
        case reconnecting(seconds: Int)
        case failed(String)
    }

    public typealias RequestCompletion = @MainActor (Result<[String: Any], Error>) -> Void

    public private(set) var state: ConnectionState = .idle
    public private(set) var agentConnected = false
    public private(set) var agentName: String?
    public private(set) var sessions: [SessionItem] = []
    public private(set) var activeSessionId: String?

    // State of the subscribed session, driven entirely by session_event frames.
    public private(set) var lastUserMessage: String?
    public private(set) var streamingText = ""
    public private(set) var isThinking = false
    public private(set) var thinkingStartedAt: Date?
    public private(set) var turnStartedAt: Date?
    public private(set) var turnFinishedAt: Date?
    public private(set) var steps: [ExecutionStep] = []
    public private(set) var modifiedFiles: [String] = []
    public private(set) var pendingApproval: ApprovalRequest?
    public private(set) var sessionSettled = false
    public private(set) var lastNotice: String?
    public private(set) var lastError: String?
    public private(set) var turnActive = false
    public private(set) var terminal = TerminalSessionState()
    public private(set) var activeSessionSource: SessionSource = .managed
    public private(set) var supportsTimeline = false
    public static let historyCacheReset = Notification.Name("PiRemoteHistoryCacheReset")
    public private(set) var supportsArchive = false
    public private(set) var supportsHistoryResume = false
    public private(set) var isResumingHistory = false
    public private(set) var supportsHistoryRecoveryOperations = false
    public private(set) var supportsModelSelection = false
    public private(set) var supportsModelCatalog = false
    /// 新建会话前按项目读取的模型目录
    public private(set) var catalogModels: [RemoteModel] = []
    public private(set) var isLoadingModels = false
    /// 当前会话的模型与可选列表
    public private(set) var activeModel: RemoteModel?
    public private(set) var activeModels: [RemoteModel] = []
    public private(set) var isSwitchingModel = false
    public private(set) var isSendingPrompt = false
    private var modelRequestOrdinal = 0
    private var modelSwitchId: UUID?
    private var modelStateUnconfirmed = false
    private var promptOperationId: UUID?
    /// 模型切换失败时保留的草稿，会话页出现时取回
    public var pendingDraft: String?
    private var catalogRequestOrdinal = 0
    public private(set) var historyRecoveryPhase: String?
    public private(set) var historyRecoveryMessage: String?
    public var historyResumeButtonTitle: String {
        if isResumingHistory { return historyRecoveryStageTitle }
        guard let id = activeSessionId, let operation = historyRecoveryOperations[id] else { return "继续对话" }
        return operation.canRetry ? "重试恢复" : "查询恢复状态"
    }
    public var historyRecoveryStageTitle: String {
        switch historyRecoveryPhase {
        case "validating": return "正在校验历史…"
        case "opening": return "正在启动 Mac 终端…"
        case "waiting_bridge": return "正在等待 OMP 桥接…"
        case "verifying", "reconciling": return "正在验证运行实例…"
        default: return "正在查询恢复状态…"
        }
    }
    public private(set) var historyIndexState = "ready"
    public private(set) var historyWarnings: [String] = []
    public private(set) var sessionsCursor: String?
    public private(set) var isLoadingEarlier = false
    public private(set) var branches: [TimelineBranch] = []
    public private(set) var toolDetails: [String: ToolDetailPage] = [:]
    public private(set) var loadingDetails: Set<String> = []
    public var isActiveArchive: Bool {
        activeSessionId?.hasPrefix("history:") == true ||
            sessions.first { $0.id == activeSessionId }?.isArchived == true
    }
    public var activeCanControl: Bool {
        !isActiveArchive && (sessions.first { $0.id == activeSessionId }?.canControl ?? true) &&
            (!isActiveTerminal || terminal.canControl)
    }

    public var config: ConnectionConfig { connectionConfig }
    public var isConnected: Bool { state == .connected }
    public var isActiveTerminal: Bool { activeSessionSource == .terminal }
    public var isCreatingSession: Bool { sessionCreationId != nil }
    public var canSendPrompt: Bool {
        isConnected && agentConnected && activeSessionId != nil && activeCanControl &&
            !isSwitchingModel && !modelStateUnconfirmed && !isSendingPrompt &&
            (!isActiveTerminal || (terminal.activity == .idle && !terminal.isOffline))
    }
    public var canAbortSession: Bool { isConnected && agentConnected && activeCanControl && isSessionRunning }

    /// 当前会话的项目目录：terminal 来自 session.list 的 cwd，managed 来自本机 session.start 指定的 cwd。
    public var activeProject: String? {
        activeSessionId.flatMap { projectName(for: $0) }
    }

    public func projectName(for sessionId: String) -> String? {
        if let project = sessions.first(where: { $0.id == sessionId })?.project { return project }
        let cwd = sessions.first { $0.id == sessionId }?.cwd ?? sessionProjects[sessionId]
        guard let cwd else { return nil }
        let name = (cwd as NSString).lastPathComponent
        return name.isEmpty ? cwd : name
    }

    public var activeSessionActivity: SessionActivity {
        guard let id = activeSessionId else { return .unknown }
        if isActiveTerminal { return terminal.activity }
        return sessions.first { $0.id == id }?.activity ?? .unknown
    }

    /// managed 由事件流驱动；terminal 只由 session.get 的 activity 驱动。
    public var isSessionRunning: Bool {
        if isActiveTerminal { return terminal.isBusy }
        return turnActive || steps.contains { $0.isRunning }
    }

    public var isConnecting: Bool {
        switch state {
        case .connecting, .reconnecting:
            return true
        default:
            return false
        }
    }

    public var connectionError: String? {
        if case .failed(let message) = state { return message }
        return nil
    }

    public var reconnectSeconds: Int? {
        if case .reconnecting(let seconds) = state { return seconds }
        return nil
    }

    private struct PendingRequest {
        let completion: RequestCompletion
        let timeoutTask: Task<Void, Never>
    }

    private var connectionConfig: ConnectionConfig = .load()
    private var webSocketTask: URLSessionWebSocketTask?
    private let urlSession: URLSession
    private var pendingRequests: [String: PendingRequest] = [:]
    private var wantsConnection = false
    private var reconnectAttempt = 0
    private var reconnectTask: Task<Void, Never>?
    private var sessionTitles: [String: String] = [:]
    private var sessionProjects: [String: String] = [:]
    private var toolArguments: [String: [String: Any]] = [:]
    private var connectionEpoch = 0
    private var selectedBranchId: String?
    private var sessionsRequestOrdinal = 0
    private var branchStates: [String: TerminalSessionState] = [:]
    private var sessionsRefreshTask: Task<Void, Never>?
    private var terminalPollTask: Task<Void, Never>?
    private var terminalGeneration = 0
    private var sessionCreationId: UUID?
    private struct HistoryRecoveryOperation {
        var id: String
        var canRetry = false
        var needsStartConfirmation = false
    }
    private var historyRecoveryOperations: [String: HistoryRecoveryOperation] = [:]
    private var historyRecoveryPollTask: Task<Void, Never>?
    private var historyPageVisible = false

#if RELAY_CLIENT_TESTING
    private var testFrameSink: (([String: Any]) -> Void)?
#endif

    private static let requestTimeout: Duration = .seconds(30)
    private static let maxReconnectDelay = 30.0
    private static let sessionsRefreshInterval: Duration = .seconds(4)
    private static let terminalPollInterval: Duration = .seconds(2)

    private init() {
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        self.urlSession = URLSession(configuration: configuration)
    }

    // MARK: - Connection lifecycle

    public func connect(config: ConnectionConfig) {
        if connectionConfig.serverUrl != config.serverUrl || connectionConfig.token != config.token {
            historyRecoveryOperations = [:]
        }
        self.connectionConfig = config
        config.save()
        lastError = nil
        wantsConnection = true
        reconnectAttempt = 0
        stopSessionsRefresh()
        stopTerminalPolling()
        openSocket()
    }

    public func disconnect() {
        wantsConnection = false
        connectionEpoch += 1
        invalidateActiveModelRequests()
        cancelSessionCreation()
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectAttempt = 0
        stopSessionsRefresh()
        stopTerminalPolling()
        NotificationCenter.default.post(name: Self.historyCacheReset, object: nil)
        closeSocket()
        failPendingRequests(message: "连接已断开")
        agentConnected = false
        sessions = []
        activeSessionId = nil
        activeSessionSource = .managed
        sessionTitles.removeAll()
        sessionProjects.removeAll()
        terminal.reset()
        supportsTimeline = false
        supportsArchive = false
        supportsHistoryResume = false
        supportsHistoryRecoveryOperations = false
        supportsModelSelection = false
        supportsModelCatalog = false
        catalogModels = []
        activeModel = nil
        activeModels = []
        sessionsCursor = nil
        branches = []
        toolDetails = [:]
        loadingDetails = []
        branchStates = [:]
        resetSessionState()
        state = .idle
    }

    private func openSocket() {
        connectionEpoch += 1
        invalidateActiveModelRequests()
        let wasHistoryVisible = historyPageVisible
        NotificationCenter.default.post(name: Self.historyCacheReset, object: nil)
        selectedBranchId = nil
        supportsTimeline = false
        supportsArchive = false
        supportsHistoryResume = false
        supportsHistoryRecoveryOperations = false
        branchStates = [:]
        cancelSessionCreation()
        historyPageVisible = wasHistoryVisible
        if isActiveArchive, let id = activeSessionId, historyRecoveryOperations[id] != nil {
            historyRecoveryPhase = "outcome_unknown"
        }
        closeSocket()
        guard let url = URL(string: connectionConfig.serverUrl),
              let scheme = url.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss" else {
            state = .failed("服务器地址无效")
            return
        }

        var request = URLRequest(url: url)
        if !connectionConfig.token.isEmpty {
            request.setValue("Bearer \(connectionConfig.token)", forHTTPHeaderField: "Authorization")
        }

        state = .connecting
        reconnectTask?.cancel()
        reconnectTask = nil
        let task = urlSession.webSocketTask(with: request)
        webSocketTask = task
        task.resume()
        listenForMessages(on: task)
        sendHello()
    }

    private func closeSocket() {
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
    }

    private func handleSocketClosed(message: String) {
        guard webSocketTask != nil || isConnecting else { return }
        let wasHistoryVisible = historyPageVisible
        connectionEpoch += 1
        invalidateActiveModelRequests()
        cancelSessionCreation()
        historyPageVisible = wasHistoryVisible
        if isActiveArchive, let id = activeSessionId, historyRecoveryOperations[id] != nil {
            historyRecoveryPhase = "outcome_unknown"
        }
        stopSessionsRefresh()
        stopTerminalPolling()
        closeSocket()
        failPendingRequests(message: "连接已断开")
        agentConnected = false
        terminal.reset()
        toolDetails = [:]
        loadingDetails = []
        branchStates = [:]
        lastError = message
        guard wantsConnection else {
            state = .idle
            return
        }
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard wantsConnection else { return }
        let delay = min(Self.maxReconnectDelay, pow(2, Double(reconnectAttempt)))
        reconnectAttempt += 1
        state = .reconnecting(seconds: Int(delay))
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self, self.wantsConnection, self.webSocketTask == nil else { return }
            self.openSocket()
        }
    }

    private func listenForMessages(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.webSocketTask === task else { return }
                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text):
                        self.handleFrameText(text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) {
                            self.handleFrameText(text)
                        }
                    @unknown default:
                        break
                    }
                    self.listenForMessages(on: task)
                case .failure(let error):
                    self.handleSocketClosed(message: error.localizedDescription)
                }
            }
        }
    }

    private func sendHello() {
        sendFrame([
            "version": 1,
            "type": "hello",
            "deviceId": connectionConfig.deviceName,
            "payload": [
                "role": "ios",
                "label": connectionConfig.deviceName,
                "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0"
            ]
        ])
    }

    // MARK: - Requests

    @discardableResult
    public func sendRequest(
        method: String,
        sessionId: String? = nil,
        params: [String: Any]? = nil,
        completion: RequestCompletion? = nil
    ) -> String {
        let requestId = UUID().uuidString
        var frame: [String: Any] = [
            "version": 1,
            "type": "request",
            "requestId": requestId,
            "payload": [
                "method": method,
                "params": params ?? [:]
            ]
        ]
        if let sessionId {
            frame["sessionId"] = sessionId
        }

        if let completion {
            let timeout = Task { @MainActor [weak self] in
                try? await Task.sleep(for: Self.requestTimeout)
                guard !Task.isCancelled, let self,
                      let pending = self.pendingRequests.removeValue(forKey: requestId) else { return }
                pending.completion(.failure(Self.error("请求 \(method) 超时")))
            }
            pendingRequests[requestId] = PendingRequest(completion: completion, timeoutTask: timeout)
        }

        sendFrame(frame)
        return requestId
    }

    private func failPendingRequests(message: String) {
        let pending = pendingRequests
        pendingRequests.removeAll()
        for (_, request) in pending {
            request.timeoutTask.cancel()
            request.completion(.failure(Self.error(message)))
        }
    }

    private static func error(_ message: String, relayCode: String? = nil) -> NSError {
        var info: [String: Any] = [NSLocalizedDescriptionKey: message]
        if let relayCode { info["relayCode"] = relayCode }
        return NSError(domain: "RelayClient", code: -1, userInfo: info)
    }

    // MARK: - Session commands

    public func refreshSessions() {
        guard isConnected else { return }
        sessionsRequestOrdinal += 1
        let ordinal = sessionsRequestOrdinal
        let epoch = connectionEpoch
        let params: [String: Any] = supportsArchive ? ["viewVersion": 2, "includeArchived": true, "limit": 30] : [:]
        sendRequest(method: "session.list", params: params) { [weak self] result in
            guard let self, self.connectionEpoch == epoch, self.sessionsRequestOrdinal == ordinal else { return }
            switch result {
            case .success(let data):
                let capabilities = data["capabilities"] as? [String: Any] ?? [:]
                let hadArchive = self.supportsArchive
                let hadModelSelection = self.supportsModelSelection
                self.supportsTimeline = capabilities["timelineV2"] as? Bool ?? false
                self.supportsArchive = capabilities["ompArchiveRead"] as? Bool ?? false
                self.supportsHistoryResume = capabilities["historyResume"] as? Bool ?? false
                self.supportsHistoryRecoveryOperations = capabilities["historyRecoveryOperations"] as? Bool ?? false
                self.supportsModelSelection = capabilities["modelSelection"] as? Bool ?? false
                self.supportsModelCatalog = capabilities["modelCatalog"] as? Bool ?? false
                if !self.supportsModelSelection { self.modelStateUnconfirmed = false }
                if !hadModelSelection || self.modelStateUnconfirmed { self.refreshActiveModels() }
                guard let list = data["sessions"] as? [[String: Any]] else { return }
                let incoming = list.compactMap { self.makeSession(from: $0) }
                if params["includeArchived"] as? Bool == true {
                    let ids = Set(incoming.map(\.id))
                    let hasMore = data["nextCursor"] as? String != nil
                    let older = hasMore ? self.sessions.filter { $0.isArchived && !ids.contains($0.id) } : []
                    self.sessions = incoming + older
                    self.sessionsCursor = data["nextCursor"] as? String
                    self.historyIndexState = data["indexState"] as? String ?? "ready"
                    self.historyWarnings = data["warnings"] as? [String] ?? []
                } else {
                    self.sessions = incoming
                }
                self.sessions.sort { ($0.startedAt ?? .distantPast) > ($1.startedAt ?? .distantPast) }
                if self.supportsArchive && !hadArchive { self.refreshSessions() } else { self.loadRemainingSessions() }
                if self.isActiveArchive && self.supportsArchive && !hadArchive { self.refreshHistory() }
                if self.supportsHistoryRecoveryOperations, self.historyPageVisible, self.isActiveArchive,
                   let id = self.activeSessionId, self.historyRecoveryOperations[id] != nil,
                   self.historyRecoveryPhase == "outcome_unknown", !self.isCreatingSession {
                    self.beginHistoryRecovery(historyId: id, queryOnly: true)
                }
            case .failure(let error):
                self.lastError = error.localizedDescription
            }
        }
    }

    private func loadRemainingSessions() {
        guard isConnected, supportsArchive, let cursor = sessionsCursor else { return }
        let epoch = connectionEpoch
        sendRequest(method: "session.list", params: ["viewVersion": 2, "includeArchived": true, "limit": 30, "cursor": cursor]) { [weak self] result in
            guard let self, self.connectionEpoch == epoch, self.sessionsCursor == cursor else { return }
            switch result {
            case .success(let data):
                let known = Set(self.sessions.map(\.id))
                let incoming = (data["sessions"] as? [[String: Any]] ?? []).compactMap { self.makeSession(from: $0) }
                self.sessions += incoming.filter { !known.contains($0.id) }
                self.sessions.sort { ($0.startedAt ?? .distantPast) > ($1.startedAt ?? .distantPast) }
                self.sessionsCursor = data["nextCursor"] as? String
                self.loadRemainingSessions()
            case .failure(let error):
                self.lastError = error.localizedDescription
            }
        }
    }

    private func startSessionsRefresh() {
        guard isConnected else { return }
        stopSessionsRefresh()
        sessionsRefreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.sessionsRefreshInterval)
                guard !Task.isCancelled, self?.isConnected == true else { return }
                self?.refreshSessions()
            }
        }
    }

    private func stopSessionsRefresh() {
        sessionsRefreshTask?.cancel()
        sessionsRefreshTask = nil
    }

    public func openSession(id: String, title: String? = nil, source: SessionSource = .managed) {
        if let title { sessionTitles[id] = title }
        if activeSessionId != id || activeSessionSource != source {
            invalidateActiveModelRequests()
            cancelSessionCreation()
            stopTerminalPolling()
            resetSessionState()
            terminal.reset()
            selectedBranchId = nil
            branchStates = [:]
            historyRecoveryMessage = nil
            historyRecoveryPhase = historyRecoveryOperations[id] == nil ? nil : "outcome_unknown"
            branches = []
            toolDetails = [:]
            loadingDetails = []
            isLoadingEarlier = false
            activeModel = nil
            activeModels = []
        }
        activeSessionId = id
        activeSessionSource = source
        historyPageVisible = source == .terminal && isActiveArchive
        if source == .terminal {
            if isActiveArchive {
                terminalGeneration += 1
                let generation = terminalGeneration
                Task { await refreshTerminalSnapshot(generation: generation) }
                loadBranches()
            } else {
                startTerminalPolling()
            }
        } else {
            stopTerminalPolling()
            sendRequest(method: "subscribe", sessionId: id) { _ in }
        }
        if !isActiveArchive { refreshActiveModels() }
    }

    public func openSession(_ session: SessionItem) {
        openSession(id: session.id, title: session.title, source: session.source)
    }

    public func cancelSessionCreation() {
        sessionCreationId = nil
        isResumingHistory = false
        historyRecoveryPollTask?.cancel()
        historyRecoveryPollTask = nil
        historyPageVisible = false
    }

    public func startNewSession(
        prompt: String,
        cwd: String? = nil,
        mode: SessionStartMode = .terminal,
        model: RemoteModel? = nil,
        onStarted: ((String) -> Void)? = nil
    ) {
        guard !isCreatingSession else { return }
        guard isConnected, agentConnected else {
            lastError = "请先连接 Mac，再新建会话。"
            return
        }
        guard !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        lastError = nil
        let creationId = UUID()
        let epoch = connectionEpoch
        sessionCreationId = creationId
        var params: [String: Any] = ["mode": mode.rawValue]
        if let cwd = cwd?.trimmingCharacters(in: .whitespacesAndNewlines), !cwd.isEmpty {
            params["cwd"] = cwd
        }
        if let model, supportsModelSelection {
            params["model"] = model.selection
        }
        sendRequest(method: "session.start", params: params) { [weak self] result in
            guard let self, self.connectionEpoch == epoch, self.sessionCreationId == creationId else { return }
            self.sessionCreationId = nil
            switch result {
            case .success(let data):
                guard let sessionId = data["sessionId"] as? String, !sessionId.isEmpty else {
                    self.lastError = "服务器未返回会话 ID"
                    return
                }
                let hasTerminalId = sessionId.hasPrefix("terminal:") && sessionId.count > "terminal:".count &&
                    sessionId.rangeOfCharacter(from: .whitespacesAndNewlines) == nil
                let source = SessionSource(rawValue: data["source"] as? String ?? (hasTerminalId ? "terminal" : "managed"))
                guard let source, source == (mode == .terminal ? .terminal : .managed),
                      hasTerminalId == (source == .terminal) else {
                    self.lastError = "Mac 返回的会话类型不匹配，请升级 Mac 助手后重试。"
                    return
                }
                if let cwd = params["cwd"] as? String {
                    self.sessionProjects[sessionId] = cwd
                }
                self.openSession(id: sessionId, title: prompt, source: source)
                // 模型没切成功就不发第一条消息，避免用错模型执行；草稿交给会话页保留
                if let selection = data["modelSelection"] as? [String: Any], selection["applied"] as? Bool != true {
                    let message = (selection["error"] as? [String: Any])?["message"] as? String
                    self.pendingDraft = prompt
                    self.lastError = "会话已创建，但模型切换失败：\(message ?? "请重新选择模型")"
                } else {
                    self.sendPrompt(prompt, to: sessionId, source: source)
                }
                self.refreshSessions()
                onStarted?(sessionId)
            case .failure(let error):
                self.lastError = error.localizedDescription
            }
        }
    }

    // MARK: - Model selection

    /// 新建前读取模型目录；cwd 为空时使用 Mac 的默认工作区。
    public func loadModelCatalog(cwd: String?, mode: SessionStartMode) {
        guard isConnected, agentConnected, supportsModelCatalog else {
            catalogModels = []
            return
        }
        catalogRequestOrdinal += 1
        let ordinal = catalogRequestOrdinal
        let epoch = connectionEpoch
        var params: [String: Any] = ["mode": mode.rawValue]
        if let cwd, !cwd.isEmpty { params["cwd"] = cwd }
        isLoadingModels = true
        sendRequest(method: "model.list", params: params) { [weak self] result in
            guard let self, self.connectionEpoch == epoch, self.catalogRequestOrdinal == ordinal else { return }
            self.isLoadingModels = false
            switch result {
            case .success(let data):
                self.catalogModels = RemoteModel.list(data["models"])
            case .failure(let error):
                self.catalogModels = []
                self.lastError = error.localizedDescription
            }
        }
    }

    private func invalidateActiveModelRequests() {
        modelRequestOrdinal += 1
        modelSwitchId = nil
        isSwitchingModel = false
        modelStateUnconfirmed = supportsModelSelection
        promptOperationId = nil
        isSendingPrompt = false
    }

    public func refreshActiveModels() {
        guard isConnected, supportsModelSelection, let sessionId = activeSessionId,
              !isActiveArchive, !isSwitchingModel else { return }
        modelRequestOrdinal += 1
        let ordinal = modelRequestOrdinal
        let epoch = connectionEpoch
        sendRequest(method: "model.list", sessionId: sessionId) { [weak self] result in
            guard let self, self.connectionEpoch == epoch, self.activeSessionId == sessionId,
                  self.modelRequestOrdinal == ordinal, !self.isSwitchingModel else { return }
            switch result {
            case .success(let data):
                self.activeModels = RemoteModel.list(data["models"])
                self.activeModel = RemoteModel(remote: data["model"])
                self.modelStateUnconfirmed = false
            case .failure(let error):
                self.lastError = error.localizedDescription
            }
        }
    }

    public func setActiveModel(_ model: RemoteModel) {
        guard isConnected, supportsModelSelection, let sessionId = activeSessionId,
              activeCanControl, !isSwitchingModel, !isSendingPrompt,
              modelStateUnconfirmed || model.id != activeModel?.id else { return }
        modelRequestOrdinal += 1
        let ordinal = modelRequestOrdinal
        let epoch = connectionEpoch
        let operationId = UUID()
        modelSwitchId = operationId
        isSwitchingModel = true
        modelStateUnconfirmed = true
        sendRequest(method: "session.set_model", sessionId: sessionId, params: ["model": model.selection]) { [weak self] result in
            guard let self, self.connectionEpoch == epoch, self.activeSessionId == sessionId,
                  self.modelRequestOrdinal == ordinal, self.modelSwitchId == operationId else { return }
            self.modelSwitchId = nil
            self.isSwitchingModel = false
            switch result {
            case .success(let data):
                if let confirmed = RemoteModel(remote: data["model"]), confirmed.id == model.id {
                    self.activeModel = confirmed
                    self.modelStateUnconfirmed = false
                    self.lastError = nil
                } else {
                    self.activeModel = nil
                    self.lastError = "模型切换结果尚未确认，正在重新读取 Mac 上的实际模型。"
                    self.refreshActiveModels()
                }
            case .failure(let error):
                self.activeModel = nil
                self.lastError = error.localizedDescription
                self.refreshActiveModels()
            }
        }
    }

    public func resumeActiveHistory() {
        guard isConnected, agentConnected, supportsHistoryResume, isActiveArchive,
              let historyId = activeSessionId, !isCreatingSession else { return }
        historyPageVisible = true
        if supportsHistoryRecoveryOperations {
            beginHistoryRecovery(historyId: historyId)
            return
        }
        let creationId = UUID()
        let epoch = connectionEpoch
        let title = sessions.first { $0.id == historyId }?.title
        sessionCreationId = creationId
        isResumingHistory = true
        lastError = nil
        sendRequest(method: "session.start", params: ["mode": "terminal", "historySessionId": historyId]) { [weak self] result in
            guard let self, self.connectionEpoch == epoch, self.sessionCreationId == creationId,
                  self.activeSessionId == historyId else { return }
            self.cancelSessionCreation()
            switch result {
            case .success(let data):
                guard let id = data["sessionId"] as? String, id.hasPrefix("terminal:"),
                      id.count > "terminal:".count, id.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
                      data["source"] as? String == "terminal",
                      let status = data["status"] as? [String: Any],
                      let resumed = SessionItem(remote: status, localTitle: title), resumed.id == id,
                      !resumed.isArchived, resumed.canControl else {
                    self.lastError = "Mac 未返回可控制的恢复会话，请刷新后重试。"
                    return
                }
                self.sessionsRequestOrdinal += 1
                self.sessions.removeAll { $0.id == historyId || $0.id == id }
                self.sessions.insert(resumed, at: 0)
                self.openSession(resumed)
                if let selection = data["modelSelection"] as? [String: Any], selection["applied"] as? Bool != true {
                    let message = (selection["error"] as? [String: Any])?["message"] as? String
                    self.lastError = "会话已恢复，但模型尚未确认：\(message ?? "请读取当前模型后重新选择")"
                }
                self.refreshSessions()
            case .failure(let error):
                self.lastError = error.localizedDescription
            }
        }
    }

    private func beginHistoryRecovery(historyId: String, queryOnly: Bool = false) {
        let creationId = UUID()
        sessionCreationId = creationId
        isResumingHistory = true
        lastError = nil
        historyRecoveryMessage = nil
        let previous = historyRecoveryOperations[historyId]
        let operation = queryOnly || previous?.canRetry == false ? previous! : HistoryRecoveryOperation(id: UUID().uuidString.lowercased(), needsStartConfirmation: true)
        historyRecoveryOperations[historyId] = operation
        historyRecoveryPhase = operation.needsStartConfirmation ? "validating" : "reconciling"
        requestHistoryRecovery(historyId: historyId, creationId: creationId, retry: !queryOnly && previous?.canRetry == true)
    }

    private func requestHistoryRecovery(historyId: String, creationId: UUID, retry: Bool = false) {
        guard let operation = historyRecoveryOperations[historyId] else { return }
        let epoch = connectionEpoch
        var params: [String: Any] = ["mode": "terminal", "recoveryVersion": 1, "operationId": operation.id]
        if operation.needsStartConfirmation { params["historySessionId"] = historyId }
        if retry { params["retry"] = true }
        // Once sent, an absent response means query this operation, even if Mac restarts and aliases change.
        historyRecoveryOperations[historyId]?.needsStartConfirmation = false
        sendRequest(method: "session.start", params: params) { [weak self] result in
            guard let self, self.connectionEpoch == epoch, self.sessionCreationId == creationId,
                  self.activeSessionId == historyId, self.historyPageVisible else { return }
            switch result {
            case .success(let data):
                guard let operationId = data["operationId"] as? String, UUID(uuidString: operationId) != nil,
                      let recoveryState = data["recoveryState"] as? String else {
                    self.cancelSessionCreation()
                    self.historyRecoveryPhase = "outcome_unknown"
                    self.historyRecoveryMessage = "Mac 未返回有效恢复状态，请查询状态，不要重复启动。"
                    return
                }
                self.historyRecoveryOperations[historyId] = HistoryRecoveryOperation(id: operationId, canRetry: data["canRetry"] as? Bool ?? false)
                self.historyRecoveryPhase = data["phase"] as? String
                self.historyRecoveryMessage = data["message"] as? String
                switch recoveryState {
                case "ready":
                    let title = self.sessions.first { $0.id == historyId }?.title
                    guard let id = data["sessionId"] as? String, id.hasPrefix("terminal:"),
                          id.count > "terminal:".count, id.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
                          data["source"] as? String == "terminal",
                          let status = data["status"] as? [String: Any],
                          let resumed = SessionItem(remote: status, localTitle: title), resumed.id == id,
                          !resumed.isArchived, resumed.canControl else {
                        self.cancelSessionCreation()
                        self.historyRecoveryPhase = "outcome_unknown"
                        self.historyRecoveryMessage = "运行实例尚未验证，请查询恢复状态。"
                        return
                    }
                    self.cancelSessionCreation()
                    self.historyRecoveryOperations.removeValue(forKey: historyId)
                    self.sessionsRequestOrdinal += 1
                    self.sessions.removeAll { $0.id == historyId || $0.id == id }
                    self.sessions.insert(resumed, at: 0)
                    self.openSession(resumed)
                    if let selection = data["modelSelection"] as? [String: Any], selection["applied"] as? Bool != true {
                        let message = (selection["error"] as? [String: Any])?["message"] as? String
                        self.lastError = "会话已恢复，但模型尚未确认：\(message ?? "请读取当前模型后重新选择")"
                    }
                    self.refreshSessions()
                case "pending":
                    self.historyRecoveryPollTask?.cancel()
                    self.historyRecoveryPollTask = Task { @MainActor [weak self] in
                        try? await Task.sleep(for: .seconds(1))
                        guard !Task.isCancelled, let self, self.connectionEpoch == epoch,
                              self.sessionCreationId == creationId, self.activeSessionId == historyId,
                              self.historyPageVisible, self.isConnected else { return }
                        self.requestHistoryRecovery(historyId: historyId, creationId: creationId)
                    }
                case "blocked", "failed", "unknown":
                    self.cancelSessionCreation()
                    self.historyPageVisible = true
                default:
                    self.cancelSessionCreation()
                    self.historyRecoveryPhase = "outcome_unknown"
                    self.historyRecoveryMessage = "恢复结果尚未确认，请查询状态。"
                }
            case .failure(let error):
                self.cancelSessionCreation()
                self.historyPageVisible = true
                if let code = (error as NSError).userInfo["relayCode"] as? String,
                   ["invalid_frame", "not_implemented", "unknown_session", "session_busy"].contains(code) {
                    self.historyRecoveryPhase = "blocked"
                    self.historyRecoveryMessage = ["invalid_frame", "unknown_session"].contains(code)
                        ? "\(error.localizedDescription) 请返回会话列表，刷新后重新选择此历史。"
                        : error.localizedDescription
                    if code != "session_busy" { self.historyRecoveryOperations.removeValue(forKey: historyId) }
                } else {
                    self.historyRecoveryPhase = "outcome_unknown"
                    self.historyRecoveryMessage = "连接或等待已中断；Mac 上的恢复不会因此停止。重连后查询同一次恢复。"
                }
            }
        }
    }

    public func sendPrompt(_ message: String, completion: RequestCompletion? = nil) {
        guard let sessionId = activeSessionId else {
            lastError = "尚未选择会话"
            completion?(.failure(Self.error("尚未选择会话")))
            return
        }
        guard canSendPrompt else {
            completion?(.failure(Self.error("请等待会话及模型确认后再发送")))
            return
        }
        sendPrompt(message, to: sessionId, source: activeSessionSource, completion: completion)
    }

    private func sendPrompt(_ message: String, to sessionId: String, source: SessionSource, completion: RequestCompletion? = nil) {
        let epoch = connectionEpoch
        let operationId = UUID()
        let generation = terminalGeneration
        promptOperationId = operationId
        isSendingPrompt = true
        if source != .terminal {
            lastUserMessage = message
            if sessionSettled { resetTurnOutput() }
        }
        sendRequest(method: "session.prompt", sessionId: sessionId, params: ["message": message]) { [weak self] result in
            guard let self, self.connectionEpoch == epoch, self.activeSessionId == sessionId,
                  self.activeSessionSource == source, self.promptOperationId == operationId,
                  source != .terminal || !self.isStaleTerminalCompletion(sessionId: sessionId, generation: generation) else { return }
            self.promptOperationId = nil
            self.isSendingPrompt = false
            switch result {
            case .success:
                if source == .terminal {
                    Task { await self.refreshTerminalNow(sessionId: sessionId, generation: generation) }
                }
            case .failure(let error):
                if (error as NSError).userInfo["relayCode"] == nil {
                    self.lastError = "发送结果尚未确认，草稿已保留。请核对会话记录后再决定是否重发。"
                } else {
                    self.lastError = error.localizedDescription
                }
                if source == .terminal, (error as NSError).userInfo["relayCode"] == nil {
                    self.terminal.fail(error.localizedDescription)
                }
                if self.lastUserMessage == message { self.lastUserMessage = nil }
            }
            completion?(result)
        }
    }

    public func abortActiveSession() {
        guard let sessionId = activeSessionId, canAbortSession else { return }
        if isActiveTerminal {
            let generation = terminalGeneration
            sendRequest(method: "session.abort", sessionId: sessionId) { [weak self] result in
                guard let self, !self.isStaleTerminalCompletion(sessionId: sessionId, generation: generation) else { return }
                switch result {
                case .success:
                    Task { await self.refreshTerminalNow(sessionId: sessionId, generation: generation) }
                case .failure(let error):
                    self.terminal.fail(error.localizedDescription)
                }
            }
            return
        }
        isThinking = false
        turnActive = false
        for index in steps.indices where steps[index].isRunning {
            steps[index].isRunning = false
        }
        sendRequest(method: "session.abort", sessionId: sessionId) { [weak self] result in
            guard let self else { return }
            if case .failure(let error) = result {
                self.lastError = error.localizedDescription
            }
        }
    }

    public func respondToUiRequest(_ request: ApprovalRequest, approved: Bool) {
        guard activeCanControl else { return }
        guard let sessionId = activeSessionId else {
            lastError = "尚未选择会话，无法回应确认请求"
            return
        }
        let response: [String: Any] = approved ? ["confirmed": true] : ["confirmed": false, "cancelled": true]
        sendUiResponse(requestId: request.id, sessionId: sessionId, response: response)
    }

    public func respondToUiRequest(_ request: ApprovalRequest, choice: String) {
        guard activeCanControl else { return }
        guard let sessionId = activeSessionId else {
            lastError = "尚未选择会话，无法回应确认请求"
            return
        }
        sendUiResponse(requestId: request.id, sessionId: sessionId, response: ["value": choice, "confirmed": true])
    }

    public func cancelUiRequest(_ request: ApprovalRequest) {
        guard activeCanControl else { return }
        guard let sessionId = activeSessionId else {
            lastError = "尚未选择会话，无法回应确认请求"
            return
        }
        sendUiResponse(requestId: request.id, sessionId: sessionId, response: ["cancelled": true])
    }

    private func sendUiResponse(requestId: String, sessionId: String, response: [String: Any]) {
        guard activeCanControl else { return }
        pendingApproval = nil
        sendRequest(
            method: "ui.response",
            sessionId: sessionId,
            params: ["requestId": requestId, "response": response]
        ) { [weak self] result in
            guard let self else { return }
            if case .failure(let error) = result {
                self.lastError = error.localizedDescription
            }
        }
    }

    private func resetTurnOutput() {
        streamingText = ""
        steps = []
        modifiedFiles = []
        toolArguments.removeAll()
        sessionSettled = false
        turnActive = false
        turnStartedAt = nil
        turnFinishedAt = nil
        lastNotice = nil
    }

    public func resetSessionState() {
        lastUserMessage = nil
        isThinking = false
        thinkingStartedAt = nil
        pendingApproval = nil
        resetTurnOutput()
    }

    // MARK: - Incoming frames

    private func sendFrame(_ dict: [String: Any]) {
#if RELAY_CLIENT_TESTING
        if let testFrameSink {
            testFrameSink(dict)
            return
        }
#endif
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let string = String(data: data, encoding: .utf8) else { return }
        webSocketTask?.send(.string(string)) { _ in }
    }

    private func handleFrameText(_ text: String) {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return }

        switch type {
        case "hello_ack":
            reconnectAttempt = 0
            reconnectTask = nil
            state = .connected
            lastError = nil
            if let payload = object["payload"] as? [String: Any] {
                agentConnected = payload["agentConnected"] as? Bool ?? false
            }
            refreshSessions()
            startSessionsRefresh()
            if isActiveTerminal, activeSessionId != nil {
                startTerminalPolling()
            }
            refreshAgentName()

        case "response":
            guard let requestId = object["requestId"] as? String,
                  let pending = pendingRequests.removeValue(forKey: requestId) else { return }
            pending.timeoutTask.cancel()
            let payload = object["payload"] as? [String: Any] ?? [:]
            if payload["ok"] as? Bool == true {
                pending.completion(.success(payload["data"] as? [String: Any] ?? [:]))
            } else {
                let error = payload["error"] as? [String: Any]
                pending.completion(.failure(Self.error(Self.failureMessage(from: error), relayCode: error?["code"] as? String)))
            }

        case "session_event":
            handleSessionEvent(object)

        case "error":
            let payload = object["payload"] as? [String: Any]
            let relayError = (payload?["error"] as? [String: Any]) ?? payload
            let message = Self.failureMessage(from: (payload?["error"] as? [String: Any]) ?? payload)
            if let requestId = object["requestId"] as? String {
                guard let pending = pendingRequests.removeValue(forKey: requestId) else { return }
                pending.timeoutTask.cancel()
                pending.completion(.failure(Self.error(message, relayCode: relayError?["code"] as? String)))
            } else {
                lastError = message
            }

        case "ping":
            sendFrame(["version": 1, "type": "pong", "payload": [:]])

        default:
            break
        }
    }

    private func makeSession(from dict: [String: Any]) -> SessionItem? {
        guard let id = dict["sessionId"] as? String else { return nil }
        return SessionItem(
            remote: dict,
            localTitle: sessionTitles[id],
            hasPendingApproval: pendingApproval != nil && activeSessionId == id
        )
    }

    private func handleSessionEvent(_ frame: [String: Any]) {
        guard !isActiveTerminal else { return }
        guard !isActiveArchive else { return }
        guard let sessionId = frame["sessionId"] as? String,
              let payload = frame["payload"] as? [String: Any],
              let event = payload["event"] as? [String: Any],
              let eventType = event["type"] as? String else { return }
        if let activeSessionId, sessionId != activeSessionId { return }

        switch eventType {
        case "agent_start":
            isThinking = true
            turnActive = true
            thinkingStartedAt = Date()
            turnStartedAt = turnStartedAt ?? Date()
            turnFinishedAt = nil
            sessionSettled = false

        case "agent_settled":
            isThinking = false
            turnActive = false
            sessionSettled = true
            turnFinishedAt = Date()
            finishRunningSteps()
            refreshSessions()

        case "turn_start":
            turnActive = true
            turnStartedAt = Date()
            turnFinishedAt = nil

        case "turn_end":
            turnActive = false
            break

        case "text_delta":
            if let text = event["text"] as? String {
                streamingText += text
            }
            isThinking = false

        case "text_end":
            if let text = event["text"] as? String, streamingText.isEmpty, !text.isEmpty {
                streamingText = text
            }
            isThinking = false

        case "tool_start":
            let toolCallId = event["toolCallId"] as? String ?? UUID().uuidString
            let toolName = event["toolName"] as? String ?? "tool"
            if let arguments = event["args"] as? [String: Any] {
                toolArguments[toolCallId] = arguments
            }
            steps.append(ExecutionStep(id: toolCallId, title: stepTitle(toolName: toolName, arguments: toolArguments[toolCallId]), isRunning: true))

        case "tool_end":
            let toolCallId = event["toolCallId"] as? String ?? ""
            let isError = event["isError"] as? Bool ?? false
            if let index = steps.firstIndex(where: { $0.id == toolCallId }) {
                steps[index].isRunning = false
                steps[index].isError = isError
            }
            if !isError, let path = filePath(from: toolArguments[toolCallId]), isFileMutating(toolName: event["toolName"] as? String) {
                if !modifiedFiles.contains(path) { modifiedFiles.append(path) }
            }
            toolArguments[toolCallId] = nil

        case "bash_output":
            if let text = event["text"] as? String, !text.isEmpty {
                lastNotice = text.trimmingCharacters(in: .whitespacesAndNewlines).suffix(160).description
            }

        case "notice":
            lastNotice = event["text"] as? String

        case "stderr", "protocol_error":
            lastNotice = (event["text"] as? String) ?? (event["message"] as? String)

        case "process_error", "extension_error":
            lastNotice = (event["message"] as? String) ?? (event["error"] as? String)

        case "process_exit":
            isThinking = false
            turnActive = false
            sessionSettled = true
            turnFinishedAt = Date()
            finishRunningSteps()
            if let code = event["code"] as? Int, code != 0 {
                lastNotice = "进程退出，退出码 \(code)"
            }
            refreshSessions()

        case "compaction_start":
            lastNotice = "正在压缩上下文"

        case "compaction_end":
            lastNotice = event["aborted"] as? Bool == true ? "上下文压缩已中止" : "上下文压缩完成"

        case "retry_start":
            let attempt = event["attempt"] as? Int
            let maxAttempts = event["maxAttempts"] as? Int
            if let attempt, let maxAttempts {
                lastNotice = "重试中（\(attempt)/\(maxAttempts)）"
            }
            isThinking = true
            turnActive = true

        case "retry_end":
            isThinking = false
            turnActive = false

        case "ui_request":
            // setStatus/setWidget 等 ui_request 只是界面通知（expectsResponse=false），不能当弹框处理。
            guard event["expectsResponse"] as? Bool == true,
                  let method = event["method"] as? String,
                  Self.dialogMethods.contains(method),
                  let requestId = event["requestId"] as? String else { return }
            let dialogPayload = event["payload"] as? [String: Any] ?? [:]
            pendingApproval = ApprovalRequest(
                id: requestId,
                method: method,
                title: dialogPayload["title"] as? String ?? "需要你的确认",
                message: (dialogPayload["message"] as? String) ?? "",
                command: dialogPayload["command"] as? String,
                options: Self.optionLabels(from: dialogPayload["options"])
            )
            refreshSessions()

        default:
            break
        }
    }

    private static let dialogMethods: Set<String> = ["select", "confirm", "input", "editor"]

    /// hello_ack 不携带 agent 设备名，只能走 /api/health 这条公开接口取回。
    private func refreshAgentName() {
        guard var components = URLComponents(string: connectionConfig.serverUrl) else { return }
        components.scheme = components.scheme?.lowercased() == "wss" ? "https" : "http"
        components.path = "/api/health"
        components.query = nil
        guard let url = components.url else { return }

        var request = URLRequest(url: url)
        if !connectionConfig.token.isEmpty {
            request.setValue("Bearer \(connectionConfig.token)", forHTTPHeaderField: "Authorization")
        }
        urlSession.dataTask(with: request) { [weak self] data, _, _ in
            guard let data,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            let name = object["agentDeviceId"] as? String
            Task { @MainActor in self?.agentName = name }
        }.resume()
    }

    /// pi 的 select 选项可能是字符串，也可能是 { label/value/... } 对象。
    private static func optionLabels(from value: Any?) -> [String] {
        if let strings = value as? [String] { return strings }
        guard let list = value as? [Any] else { return [] }
        return list.compactMap { item in
            if let text = item as? String { return text }
            if let dict = item as? [String: Any] {
                return (dict["label"] as? String) ?? (dict["value"] as? String)
            }
            return nil
        }
    }

    private func finishRunningSteps() {
        for index in steps.indices {
            steps[index].isRunning = false
        }
    }

    private func stepTitle(toolName: String, arguments: [String: Any]?) -> String {
        guard let arguments, !arguments.isEmpty else { return toolName }
        if let path = filePath(from: arguments) {
            return "\(toolName) · \(path)"
        }
        if let command = arguments["command"] as? String {
            return "\(toolName) · \(command.prefix(60))"
        }
        return toolName
    }

    private func filePath(from arguments: [String: Any]?) -> String? {
        guard let arguments else { return nil }
        for key in ["path", "file_path", "filePath", "file", "target"] {
            if let value = arguments[key] as? String, !value.isEmpty { return value }
        }
        return nil
    }

    private func isFileMutating(toolName: String?) -> Bool {
        guard let toolName = toolName?.lowercased() else { return false }
        return ["edit", "write", "multi_edit", "multiedit", "patch", "apply_patch", "create"].contains(toolName)
    }

    // MARK: - Terminal sessions

    /// 终端只轮询 session.get 快照，不订阅 managed 事件；切换/断开时取消并作废在途回调。
    public func startTerminalPolling() {
        guard isConnected, isActiveTerminal, !isActiveArchive, activeSessionId != nil, terminalPollTask == nil else { return }
        terminalGeneration += 1
        let generation = terminalGeneration
        terminalPollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard self?.isConnected == true, self?.isActiveTerminal == true else { return }
                await self?.refreshTerminalSnapshot(generation: generation)
                try? await Task.sleep(for: Self.terminalPollInterval)
            }
        }
    }

    public func stopTerminalPolling() {
        terminalGeneration += 1
        if isActiveTerminal {
            promptOperationId = nil
            isSendingPrompt = false
        }
        terminalPollTask?.cancel()
        terminalPollTask = nil
    }

    /// 过期回调判定：请求发出时记录的会话与轮询代次，必须与回调到达时一致。
    /// 切换会话、断开或重连都会让代次递增，此时旧回调不得再作用当前会话。
    nonisolated static func isStaleTerminalCompletion(
        requestSessionId: String,
        requestGeneration: Int,
        currentSessionId: String?,
        currentGeneration: Int
    ) -> Bool {
        requestSessionId != currentSessionId || requestGeneration != currentGeneration
    }

    private func isStaleTerminalCompletion(sessionId: String, generation: Int) -> Bool {
        Self.isStaleTerminalCompletion(
            requestSessionId: sessionId,
            requestGeneration: generation,
            currentSessionId: activeSessionId,
            currentGeneration: terminalGeneration
        )
    }

    private func refreshTerminalNow(sessionId: String, generation: Int) async {
        guard isConnected, isActiveTerminal, terminalPollTask != nil,
              !isStaleTerminalCompletion(sessionId: sessionId, generation: generation) else { return }
        await refreshTerminalSnapshot(generation: generation)
    }

    private func refreshTerminalSnapshot(generation: Int) async {
        guard let sessionId = activeSessionId, isActiveTerminal else { return }
        var params: [String: Any] = supportsTimeline ? ["viewVersion": 2, "view": "timeline", "limit": 50] : [:]
        if let selectedBranchId { params["branchId"] = selectedBranchId }
        let result = await performRequest(method: "session.get", sessionId: sessionId, params: params)
        guard generation == terminalGeneration, activeSessionId == sessionId else { return }
        switch result {
        case .success(let data):
            let previousItems = terminal.items
            let previousBranch = terminal.branchId
            if let branch = data["branchId"] as? String, let cached = branchStates[branch],
               cached.revision == data["revision"] as? String {
                terminal = cached
            }
            terminal.apply(data)
            if previousBranch != terminal.branchId {
                toolDetails = [:]
                loadingDetails = []
            } else {
                for item in terminal.items {
                    if let previous = previousItems.first(where: { $0.id == item.id }),
                       previous.status != item.status || previous.preview != item.preview || previous.text != item.text {
                        for field in ["arguments", "result", "error"] { toolDetails["\(item.id):\(field)"] = nil }
                    }
                }
            }
            syncActiveTerminalActivity()
        case .failure(let error):
            terminal.fail(error.localizedDescription)
        }
    }

    public func refreshHistory() {
        guard isActiveArchive else { return }
        stopTerminalPolling()
        selectedBranchId = nil
        terminal.reset()
        toolDetails = [:]
        let generation = terminalGeneration
        Task { await refreshTerminalSnapshot(generation: generation) }
        loadBranches()
    }

    public func loadEarlier(onLoaded: @escaping (Bool) -> Void = { _ in }) {
        guard isConnected, let sessionId = activeSessionId, let before = terminal.before,
              !isLoadingEarlier, supportsTimeline else { return }
        isLoadingEarlier = true
        let generation = terminalGeneration
        var params: [String: Any] = ["viewVersion": 2, "view": "timeline", "before": before, "limit": 50]
        if isActiveArchive, let branch = terminal.branchId { params["branchId"] = branch }
        Task {
            let result = await performRequest(method: "session.get", sessionId: sessionId, params: params)
            guard !isStaleTerminalCompletion(sessionId: sessionId, generation: generation) else { return }
            isLoadingEarlier = false
            switch result {
            case .success(let data):
                let previousCount = terminal.items.count
                terminal.apply(data, prepend: true)
                onLoaded(terminal.error == nil && terminal.items.count > previousCount)
            case .failure(let error):
                lastNotice = error.localizedDescription
                onLoaded(false)
            }
        }
    }

    public func loadBranches() {
        guard isConnected, isActiveArchive, let sessionId = activeSessionId else { return }
        let generation = terminalGeneration
        sendRequest(method: "session.get", sessionId: sessionId, params: ["viewVersion": 2, "view": "branches"]) { [weak self] result in
            guard let self, !self.isStaleTerminalCompletion(sessionId: sessionId, generation: generation) else { return }
            if case .success(let data) = result {
                self.branches = (data["branches"] as? [[String: Any]] ?? []).compactMap(TimelineBranch.init(remote:))
            }
        }
    }

    public func selectBranch(_ branch: TimelineBranch) {
        guard isActiveArchive, !branch.damaged else { return }
        stopTerminalPolling()
        if let id = terminal.branchId {
            if branchStates.count >= 8 { branchStates.removeAll() }
            branchStates[id] = terminal
        }
        selectedBranchId = branch.id
        terminal.reset()
        toolDetails = [:]
        loadingDetails = []
        isLoadingEarlier = false
        let generation = terminalGeneration
        Task { await refreshTerminalSnapshot(generation: generation) }
    }

    public func loadToolDetail(_ item: TimelineItem, field: String, more: Bool = false) {
        guard isConnected, let sessionId = activeSessionId, let detailId = item.detailId,
              let revision = terminal.revision, let branch = terminal.branchId else { return }
        let key = "\(item.id):\(field)"
        guard !loadingDetails.contains(key) else { return }
        if !more, toolDetails[key] != nil { return }
        var params: [String: Any] = ["viewVersion": 2, "view": "tool", "detailId": detailId, "revision": revision, "field": field]
        if isActiveArchive { params["branchId"] = branch }
        if more {
            guard let cursor = toolDetails[key]?.nextCursor else { return }
            params["cursor"] = cursor
        }
        loadingDetails.insert(key)
        let generation = terminalGeneration
        sendRequest(method: "session.get", sessionId: sessionId, params: params) { [weak self] result in
            guard let self, !self.isStaleTerminalCompletion(sessionId: sessionId, generation: generation) else { return }
            self.loadingDetails.remove(key)
            guard self.terminal.revision == revision, self.terminal.branchId == branch else { return }
            switch result {
            case .success(let data):
                var page = ToolDetailPage(remote: data)
                if more { page.text = (self.toolDetails[key]?.text ?? "") + page.text }
                self.toolDetails[key] = page
            case .failure(let error):
                var page = self.toolDetails[key] ?? ToolDetailPage(remote: [:])
                page.error = error.localizedDescription
                self.toolDetails[key] = page
            }
        }
    }

    private func syncActiveTerminalActivity() {
        guard let id = activeSessionId, let index = sessions.firstIndex(where: { $0.id == id }) else { return }
        sessions[index].activity = terminal.activity
    }

    private func performRequest(method: String, sessionId: String?, params: [String: Any]? = nil) async -> Result<[String: Any], Error> {
        await withCheckedContinuation { continuation in
            sendRequest(method: method, sessionId: sessionId, params: params) { result in
                continuation.resume(returning: result)
            }
        }
    }

    public func fetchProjects() async throws -> MacProjectList {
        let data = try await projectRequest(["projectView": "recent"])
        guard let projects = data["projects"] as? [[String: Any]],
              let home = data["home"] as? String,
              let defaultDirectory = data["defaultDirectory"] as? String else {
            throw Self.error("请更新 Mac 助手以选择本机项目")
        }
        return MacProjectList(projects: projects.compactMap(MacProject.init(remote:)),
                              home: home, defaultDirectory: defaultDirectory)
    }

    public func fetchProjectDirectory(path: String, offset: Int = 0) async throws -> MacDirectoryPage {
        let data = try await projectRequest(["projectView": "directory", "path": path, "offset": offset])
        guard let canonical = data["path"] as? String,
              let directories = data["directories"] as? [[String: Any]] else {
            throw Self.error("请更新 Mac 助手以浏览本机目录")
        }
        return MacDirectoryPage(path: canonical, parent: data["parent"] as? String,
                                directories: directories.compactMap(MacProject.init(remote:)),
                                nextOffset: data["nextOffset"] as? Int)
    }

    private func projectRequest(_ params: [String: Any]) async throws -> [String: Any] {
        guard isConnected, agentConnected else { throw Self.error("请先连接 Mac 再选择项目") }
        let epoch = connectionEpoch
        let result = await performRequest(method: "session.list", sessionId: nil, params: params)
        try Task.checkCancellation()
        guard connectionEpoch == epoch, isConnected, agentConnected else {
            throw Self.error("Mac 连接已变化，请重新选择项目")
        }
        return try result.get()
    }

    private static func failureMessage(from error: [String: Any]?) -> String {
        let fallback = error?["message"] as? String ?? "请求失败"
        switch error?["code"] as? String {
        case "not_implemented":
            return "这台 Mac 上的 pi 暂不支持读取终端会话，请更新扩展。"
        case "unknown_session":
            return "此会话已关闭或已在 Mac 上切换，请返回会话列表选择新的会话。"
        default:
            return fallback
        }
    }
}

#if RELAY_CLIENT_TESTING
extension RelayClient {
    convenience init(testFrameSink: @escaping ([String: Any]) -> Void) {
        self.init()
        self.connectionConfig = ConnectionConfig(serverUrl: "invalid", token: "", deviceName: "test")
        self.testFrameSink = testFrameSink
    }

    func reconnectForTesting() {
        openSocket()
    }

    func expireRequestForTesting(_ requestId: String) {
        guard let pending = pendingRequests.removeValue(forKey: requestId) else { return }
        pending.timeoutTask.cancel()
        pending.completion(.failure(Self.error("请求超时")))
    }

    func receiveTestFrame(_ frame: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: frame)
        handleFrameText(String(decoding: data, as: UTF8.self))
    }
}
#endif

#if DEBUG
extension RelayClient {
    /// Seeds the client with design-sample content for previews and screenshot checks.
    /// Never called outside DEBUG, and only when the DEMO_DATA environment variable is set.
    public func seedDemoData(state demoState: SessionStatus, connected: Bool) {
        state = connected ? .connected : .idle
        agentConnected = connected
        let now = Date()
        sessions = [
            SessionItem(id: "sess-1", title: "修复登录后的跳转", state: .running, startedAt: now, hasPendingApproval: demoState == .approval, activity: .busy),
            SessionItem(id: "sess-2", title: "为设置页增加深色模式", state: .running, startedAt: now.addingTimeInterval(-720), activity: .busy),
            SessionItem(id: "sess-3", title: "整理 API 错误提示", state: .exited, startedAt: now.addingTimeInterval(-720), activity: .idle)
        ]
        activeSessionId = "sess-1"
        sessionTitles["sess-1"] = "修复登录后的跳转"
        lastUserMessage = "修复登录成功后没有跳转的问题，并补一个回归测试。"
        lastNotice = nil
        lastError = nil
        toolArguments.removeAll()

        switch demoState {
        case .running:
            isThinking = false
            thinkingStartedAt = now.addingTimeInterval(-8)
            turnStartedAt = now.addingTimeInterval(-8)
            turnFinishedAt = nil
            streamingText = "我会先检查登录回调和路由守卫，确认原因后修复，并验证跳转行为。\n\n已找到原因：登录状态尚未写入，路由守卫就开始校验。我正在调整顺序，并补充测试。"
            steps = [
                ExecutionStep(id: "1", title: "读取登录回调与路由配置"),
                ExecutionStep(id: "2", title: "定位到状态更新顺序问题"),
                ExecutionStep(id: "3", title: "正在更新 auth/callback.ts", isRunning: true)
            ]
            modifiedFiles = ["auth/callback.ts", "auth/callback.test.ts"]
            sessionSettled = false
            pendingApproval = nil

        case .approval:
            isThinking = false
            thinkingStartedAt = now.addingTimeInterval(-8)
            turnStartedAt = now.addingTimeInterval(-8)
            streamingText = "我会先检查登录回调和路由守卫，确认原因后修复，并验证跳转行为。\n\n已找到原因：登录状态尚未写入，路由守卫就开始校验。我正在调整顺序，并补充测试。"
            steps = [
                ExecutionStep(id: "1", title: "读取登录回调与路由配置"),
                ExecutionStep(id: "2", title: "定位到状态更新顺序问题"),
                ExecutionStep(id: "3", title: "正在更新 auth/callback.ts", isRunning: true)
            ]
            modifiedFiles = ["auth/callback.ts", "auth/callback.test.ts"]
            pendingApproval = ApprovalRequest(
                id: "ui-demo-1",
                method: "confirm",
                title: "运行项目测试",
                message: "验证登录回调的修改是否正确，\n将在 Mac 的 pi-remote 项目中执行。",
                command: "npm test -- auth/callback"
            )

        case .done:
            isThinking = false
            thinkingStartedAt = now.addingTimeInterval(-84)
            turnStartedAt = now.addingTimeInterval(-84)
            turnFinishedAt = now
            streamingText = "登录跳转已修复。现在先写入登录状态，再进行页面跳转。新增回归测试已通过。"
            steps = [
                ExecutionStep(id: "1", title: "读取登录回调与路由配置"),
                ExecutionStep(id: "2", title: "定位到状态更新顺序问题"),
                ExecutionStep(id: "3", title: "更新 auth/callback.ts")
            ]
            modifiedFiles = ["auth/callback.ts", "auth/callback.test.ts"]
            pendingApproval = nil
            sessionSettled = true
        }
    }
}
#endif
