import Combine
import Foundation
import PiRemoteCore

/// Rejects HTTP redirects at the task level: a credentialed health request must never be replayed
/// against an attacker-controlled `Location`.
final class ClaudeRedirectRejector: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

@MainActor
final class ClaudeServiceController: ObservableObject {
    enum State: Equatable {
        case idle, starting, running, stopping, failed(String)
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var configuration = ClaudeServiceConfiguration()
    @Published private(set) var logs: [String] = []
    /// The verified `https://*.trycloudflare.com` address for the Claude daemon. Published only
    /// after the daemon is locally healthy and the public endpoint passed an authenticated health
    /// check, and cleared on stop/failure/old generation.
    @Published private(set) var publicURL: URL?

    private let store: ClaudeConfigStore
    private let runtimeProvider: () throws -> ClaudeRuntimePaths
    private let tokenProvider: @MainActor () throws -> String
    private let localSession: URLSession
    private let publicSession: URLSession
    private let ownsPublicSession: Bool
    private let redirectRejector = ClaudeRedirectRejector()
    private let readinessTimeout: TimeInterval
    private let tunnelURLTimeout: TimeInterval
    private let publicHealthTimeout: TimeInterval
    private var process: SupervisorProcess?
    private var tunnelProcess: SupervisorProcess?
    private var monitor: Task<Void, Never>?
    private var generation = 0
    private var activeToken: String?
    private var discoveredPublicURL: URL?
    private var isShuttingDown = false
    private var instanceId: String?

    init(
        store: ClaudeConfigStore = ClaudeConfigStore(),
        runtimeProvider: @escaping () throws -> ClaudeRuntimePaths = { try RuntimeLocator.locateClaude() },
        tokenProvider: @escaping @MainActor () throws -> String = ClaudeServiceController.storedToken,
        session: URLSession? = nil,
        readinessTimeout: TimeInterval = 30,
        tunnelURLTimeout: TimeInterval = 90,
        publicHealthTimeout: TimeInterval = 60
    ) {
        self.store = store
        self.runtimeProvider = runtimeProvider
        self.tokenProvider = tokenProvider
        self.readinessTimeout = readinessTimeout
        self.tunnelURLTimeout = tunnelURLTimeout
        self.publicHealthTimeout = publicHealthTimeout
        self.localSession = ClaudeServiceController.makeEphemeralSession()
        if let session {
            self.publicSession = session
            self.ownsPublicSession = false
        } else {
            self.publicSession = ClaudeServiceController.makeEphemeralSession()
            self.ownsPublicSession = true
        }
        do { configuration = try store.load() }
        catch { state = .failed(error.localizedDescription) }
    }

    deinit {
        localSession.invalidateAndCancel()
        if ownsPublicSession { publicSession.invalidateAndCancel() }
    }

    func start(configuration requested: ClaudeServiceConfiguration? = nil) async throws {
        guard !isShuttingDown else { throw ValidationError("应用正在退出，不能启动 Claude 服务") }
        guard process == nil, tunnelProcess == nil, state != .starting, state != .stopping else {
            throw ValidationError("Claude 服务仍在运行或切换状态")
        }
        generation += 1
        let current = generation
        state = .starting
        publicURL = nil
        discoveredPublicURL = nil
        do {
            let config = try (requested ?? configuration).validated()
            guard FileManager.default.isExecutableFile(atPath: config.executablePath) else {
                throw ValidationError("找不到可执行的 Claude CLI，请检查路径")
            }
            guard PortProbe.isAvailable(port: config.port) else {
                throw ValidationError("Claude 服务端口 \(config.port) 已被占用；不会停止占用端口的进程")
            }
            let runtime = try runtimeProvider()
            // Cloudflare prerequisites are checked before any process is spawned.
            var cloudflaredPath: String?
            if config.mode == .cloudflare {
                guard let cloudflared = runtime.cloudflared,
                      FileManager.default.isExecutableFile(atPath: cloudflared.path) else {
                    throw ValidationError("应用内缺少可执行的 cloudflared，无法为 Claude 服务建立隧道")
                }
                cloudflaredPath = cloudflared.path
            }
            let token = try startToken(for: config.mode)
            let identifier = UUID().uuidString
            let job = try JobBuilder.claudeJob(
                nodePath: runtime.node.path,
                runtimeDirectory: runtime.runtimeDirectory.path,
                configuration: config,
                token: token,
                instanceId: identifier,
                baseEnvironment: ProcessInfo.processInfo.environment
            )
            try FileManager.default.createDirectory(atPath: config.dataDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try store.save(config)
            configuration = config
            activeToken = token
            instanceId = identifier
            let child = SupervisorProcess(job: job, node: runtime.node, supervisor: runtime.supervisor)
            process = child
            child.onOutput = { [weak self] line in
                Task { @MainActor in
                    guard let self, self.generation == current else { return }
                    self.appendLog(line, token: token)
                }
            }
            child.onExit = { [weak self] status in
                Task { @MainActor in
                    self?.handleProcessExit(tag: job.tag, status: status, generation: current)
                }
            }
            try child.start()

            let deadline = Date().addingTimeInterval(readinessTimeout)
            var ready = false
            while Date() < deadline {
                try Task.checkCancellation()
                guard generation == current, child.isRunning else { throw CancellationError() }
                if try await checkHealth(config: config, token: token, identifier: identifier) { ready = true; break }
                try await Task.sleep(nanoseconds: 250_000_000)
            }
            guard ready else { throw ValidationError("等待 Claude 后端启动超时") }
            guard generation == current, child.isRunning else { throw CancellationError() }
            appendLog("Claude 后端已就绪", token: token)

            if config.mode == .cloudflare, let cloudflaredPath {
                try await startCloudflareTunnel(
                    config: config,
                    cloudflaredPath: cloudflaredPath,
                    runtime: runtime,
                    token: token,
                    identifier: identifier,
                    generation: current
                )
            } else {
                state = .running
            }
            guard generation == current else { throw CancellationError() }
            beginMonitoring(config: config, token: token, identifier: identifier, generation: current)
        } catch {
            if generation == current {
                let message = DiagnosticRedactor.redact(error.localizedDescription, secrets: [activeToken ?? ""])
                await stopWithFailure(message, generation: current)
            }
            throw error
        }
    }

    func stop() async {
        generation += 1
        let current = generation
        monitor?.cancel()
        monitor = nil
        activeToken = nil
        instanceId = nil
        discoveredPublicURL = nil
        publicURL = nil
        let children = [process, tunnelProcess].compactMap { $0 }
        guard !children.isEmpty else {
            process = nil
            tunnelProcess = nil
            state = .idle
            return
        }
        state = .stopping
        for child in children { child.stop() }
        // Each supervisor owns its own grace period; stop them concurrently so the wait does not
        // grow with the number of children.
        await Task.detached {
            await withTaskGroup(of: Void.self) { group in
                for child in children {
                    group.addTask {
                        if !child.waitUntilExit(deadline: Date().addingTimeInterval(11)) {
                            child.forceTerminate()
                            _ = child.waitUntilExit(deadline: Date().addingTimeInterval(2))
                        }
                    }
                }
                await group.waitForAll()
            }
        }.value
        guard generation == current else { return }
        process = nil
        tunnelProcess = nil
        state = .idle
    }

    func restart(configuration: ClaudeServiceConfiguration? = nil) async throws {
        let stoppedGeneration = generation + 1
        await stop()
        guard generation == stoppedGeneration else { throw CancellationError() }
        try await start(configuration: configuration)
    }

    func shutdown() async {
        isShuttingDown = true
        await stop()
    }

    func readPairInfo() async throws -> ClaudePairInfo {
        guard state == .running, let token = activeToken, let identifier = instanceId else {
            throw ValidationError("Claude 服务尚未就绪，不能读取配对信息")
        }
        let current = generation
        let config = configuration
        guard try await checkHealth(config: config, token: token, identifier: identifier) else {
            throw ValidationError("Claude 服务连接已失效")
        }
        let (data, response) = try await localSession.data(
            for: request(config: config, path: "api/pair-info", token: nil),
            delegate: redirectRejector
        )
        guard generation == current, state == .running,
              (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw ValidationError("Claude 配对信息不可用")
        }
        let info = try JSONDecoder().decode(ClaudePairInfo.self, from: data)
        guard info.token == token, !info.bases.isEmpty else { throw ValidationError("Claude 配对信息与本服务不匹配") }
        if config.mode == .cloudflare {
            guard let url = publicURL, ClaudeTunnelURL.validated(url) != nil else {
                throw ValidationError("Claude 公网地址尚未就绪")
            }
            return ClaudePairInfo(bases: [url.absoluteString], token: token)
        }
        return info
    }

    // MARK: - Cloudflare tunnel

    private func startCloudflareTunnel(
        config: ClaudeServiceConfiguration,
        cloudflaredPath: String,
        runtime: ClaudeRuntimePaths,
        token: String,
        identifier: String,
        generation current: Int
    ) async throws {
        let emptyConfig = try ensureEmptyTunnelConfig(dataDirectory: config.dataDirectory)
        var job = JobBuilder.tunnelJob(
            cloudflaredPath: cloudflaredPath,
            runtimeDirectory: runtime.runtimeDirectory.path,
            port: config.port,
            emptyConfigPath: emptyConfig.path,
            baseEnvironment: ClaudeServiceController.tunnelEnvironment(
                from: ProcessInfo.processInfo.environment,
                nodeDirectory: runtime.nodeDirectory
            )
        )
        job.tag = "claude-tunnel"
        let child = SupervisorProcess(job: job, node: runtime.node, supervisor: runtime.supervisor)
        tunnelProcess = child
        child.onOutput = { [weak self] line in
            Task { @MainActor in
                guard let self, self.generation == current else { return }
                self.appendLog("[claude-tunnel] \(line)", token: token)
                guard self.discoveredPublicURL == nil, let candidate = ClaudeTunnelURL.inLogLine(line) else { return }
                self.discoveredPublicURL = candidate
            }
        }
        child.onExit = { [weak self] status in
            Task { @MainActor in
                self?.handleProcessExit(tag: job.tag, status: status, generation: current)
            }
        }
        try child.start()
        appendLog("已启动 Claude 独立 Cloudflare Quick Tunnel", token: token)

        let url = try await waitForTunnelURL(generation: current)
        guard let verified = ClaudeTunnelURL.validated(url) else {
            throw ValidationError("Cloudflare 返回的 Claude 公网地址无效")
        }
        try await waitForPublicHealth(url: verified, token: token, identifier: identifier, generation: current)
        // Both children must still be alive: the daemon can die while the public health check is
        // still succeeding, and publishing the address then would advertise a dead backend.
        guard generation == current, let tunnel = tunnelProcess, tunnel.isRunning,
              let daemon = process, daemon.isRunning else { throw CancellationError() }
        publicURL = verified
        state = .running
        appendLog("Claude 公网地址：\(verified.absoluteString)", token: token)
    }

    private func waitForTunnelURL(generation current: Int) async throws -> URL {
        let deadline = Date().addingTimeInterval(tunnelURLTimeout)
        while Date() < deadline {
            try Task.checkCancellation()
            guard generation == current, let tunnel = tunnelProcess, tunnel.isRunning else { throw CancellationError() }
            if let url = discoveredPublicURL { return url }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw ValidationError("Cloudflare 在 \(Int(tunnelURLTimeout)) 秒内没有返回有效的 Claude 公网地址")
    }

    private func waitForPublicHealth(url: URL, token: String, identifier: String, generation current: Int) async throws {
        let deadline = Date().addingTimeInterval(publicHealthTimeout)
        while Date() < deadline {
            try Task.checkCancellation()
            guard generation == current, let tunnel = tunnelProcess, tunnel.isRunning else { throw CancellationError() }
            if try await checkPublicHealth(url: url, token: token, identifier: identifier) { return }
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }
        throw ValidationError("Claude 公网地址在 \(Int(publicHealthTimeout)) 秒内未通过健康检查")
    }

    /// Returns `true` when the public endpoint is authentic; `false` for transient conditions to
    /// retry within the startup budget; throws immediately for auth/identity/redirect failures.
    private func checkPublicHealth(url: URL, token: String, identifier: String) async throws -> Bool {
        var request = URLRequest(url: url.appendingPathComponent("api/health"))
        request.timeoutInterval = 5
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await publicSession.data(for: request, delegate: redirectRejector)
        } catch let error as URLError {
            switch error.code {
            case .httpTooManyRedirects:
                throw ValidationError("Claude 公网健康检查被重定向，已拒绝")
            default:
                return false
            }
        }
        guard let http = response as? HTTPURLResponse else { return false }
        switch http.statusCode {
        case 200:
            break
        case 401:
            throw ValidationError("Claude 公网隧道身份校验失败（401）")
        case 502, 503, 504, 530:
            return false
        case 300...399:
            throw ValidationError("Claude 公网健康检查被重定向，已拒绝")
        default:
            return false
        }
        guard let health = try? JSONDecoder().decode(ClaudeServiceHealth.self, from: data),
              health.matches(instanceId: identifier) else {
            throw ValidationError("Claude 公网身份与服务不匹配")
        }
        return true
    }

    private func ensureEmptyTunnelConfig(dataDirectory: String) throws -> URL {
        let directory = URL(fileURLWithPath: dataDirectory, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = directory.appendingPathComponent("cloudflared-empty.yml")
        // Deliberately empty so cloudflared never falls back to the user's ~/.cloudflared config.
        try Data().write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return url
    }

    /// A tunnel job runs the shared cloudflared binary only. Use a strict allowlist so no daemon
    /// credential, Claude login (`ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`) or Cloudflare token
    /// (`TUNNEL_TOKEN`, `CF_*`) can leak in, and so unrelated `TUNNEL_*` variables cannot
    /// accidentally switch cloudflared out of Quick Tunnel mode.
    static func tunnelEnvironment(from base: [String: String], nodeDirectory: String) -> [String: String] {
        var environment: [String: String] = [:]
        for (key, value) in base where isAllowedTunnelKey(key) {
            environment[key] = value
        }
        environment["PATH"] = RuntimeEnvironment.path(bundledNodeDirectory: nodeDirectory, original: environment["PATH"])
        return environment
    }

    private static func isAllowedTunnelKey(_ key: String) -> Bool {
        if ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG"].contains(key) {
            return true
        }
        let upper = key.uppercased()
        if upper.hasPrefix("LC_") { return true }
        return ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].contains(upper)
    }

    // MARK: - Health, readiness and monitoring

    private func checkHealth(config: ClaudeServiceConfiguration, token: String, identifier: String) async throws -> Bool {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await localSession.data(for: request(config: config, path: "api/health", token: token), delegate: redirectRejector)
        } catch let error as URLError where [.cannotConnectToHost, .networkConnectionLost, .timedOut].contains(error.code) {
            return false
        }
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let health = try? JSONDecoder().decode(ClaudeServiceHealth.self, from: data),
              health.matches(instanceId: identifier) else {
            throw ValidationError("Claude 服务认证或实例身份不匹配")
        }
        return true
    }

    private func request(config: ClaudeServiceConfiguration, path: String, token: String?) -> URLRequest {
        var request = URLRequest(url: config.baseURL.appendingPathComponent(path))
        request.timeoutInterval = 3
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    private func beginMonitoring(config: ClaudeServiceConfiguration, token: String, identifier: String, generation current: Int) {
        let watchPublic = config.mode == .cloudflare
        monitor = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: 2_000_000_000)
                    guard let self, self.generation == current else { return }
                    guard try await self.checkHealth(config: config, token: token, identifier: identifier) else {
                        throw ValidationError("Claude 服务连接已失效")
                    }
                    if watchPublic {
                        guard let url = self.publicURL else { throw ValidationError("Claude 公网地址已丢失") }
                        guard try await self.checkPublicHealth(url: url, token: token, identifier: identifier) else {
                            throw ValidationError("Claude 公网连接已失效")
                        }
                    }
                } catch {
                    guard !Task.isCancelled, let self, self.generation == current else { return }
                    let message = DiagnosticRedactor.redact(error.localizedDescription, secrets: [token])
                    await self.stopWithFailure(message, generation: current)
                    return
                }
            }
        }
    }

    private func handleProcessExit(tag: String, status: Int32, generation current: Int) {
        guard generation == current, state == .starting || state == .running else { return }
        // This generation is already dead: clear any published address synchronously so a stale
        // `publicURL` cannot stay visible while the async cleanup is pending (or after a newer
        // generation supersedes it).
        publicURL = nil
        discoveredPublicURL = nil
        let message: String
        if tag == "claude-tunnel" {
            message = "Claude 公网隧道已退出（状态 \(status)），连接已中断"
        } else {
            message = "Claude 后端已退出（状态 \(status)），连接已中断"
        }
        // Capture the verified generation, never whatever `generation` is when the task runs.
        Task { await self.stopWithFailure(message, generation: current) }
    }

    /// Tears down the service belonging to `current` and records `message`. The entry guard is
    /// mandatory: callers schedule this asynchronously (process exit, monitor failure), so the user
    /// may have stopped/started a newer generation before the task runs — calling `stop()` then
    /// would tear down the new daemon/tunnel. The post-`stop()` guard still keeps a stale `.failed`
    /// from overwriting a newer state.
    private func stopWithFailure(_ message: String, generation current: Int) async {
        guard generation == current else { return }
        let stoppedGeneration = generation + 1
        await stop()
        guard generation == stoppedGeneration else { return }
        state = .failed(message)
    }

    private func startToken(for mode: ClaudeServiceMode) throws -> String {
        switch mode {
        case .local:
            return try tokenProvider()
        case .cloudflare:
            // In-memory only: a Cloudflare tunnel token must never be read from or written to the keychain.
            guard let token = TokenGenerator.randomHex() else { throw ValidationError("无法生成 Claude 服务凭据") }
            return try EndpointValidator.validateToken(token)
        }
    }

    private static func makeEphemeralSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }

    private func appendLog(_ line: String, token: String) {
        logs.append(DiagnosticRedactor.redact(line, secrets: [token]))
        if logs.count > 200 { logs.removeFirst(logs.count - 200) }
    }

    private static func storedToken() throws -> String {
        let keychain = KeychainStore()
        if let token = keychain.token(for: KeychainStore.claudeTokenAccount) {
            return try EndpointValidator.validateToken(token)
        }
        guard let token = TokenGenerator.randomHex() else { throw ValidationError("无法生成 Claude 服务凭据") }
        guard keychain.setToken(token, for: KeychainStore.claudeTokenAccount) else {
            throw ValidationError("无法将 Claude 服务凭据保存到系统钥匙串")
        }
        return token
    }
}
