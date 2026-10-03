import Combine
import Foundation
import PiRemoteCore

@MainActor
final class ClaudeServiceController: ObservableObject {
    enum State: Equatable {
        case idle, starting, running, stopping, failed(String)
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var configuration = ClaudeServiceConfiguration()
    @Published private(set) var logs: [String] = []

    private let store: ClaudeConfigStore
    private let runtimeProvider: () throws -> ClaudeRuntimePaths
    private let tokenProvider: @MainActor () throws -> String
    private let session: URLSession
    private let readinessTimeout: TimeInterval
    private var process: SupervisorProcess?
    private var monitor: Task<Void, Never>?
    private var generation = 0
    private var activeToken: String?
    private var isShuttingDown = false
    private var instanceId: String?

    init(
        store: ClaudeConfigStore = ClaudeConfigStore(),
        runtimeProvider: @escaping () throws -> ClaudeRuntimePaths = { try RuntimeLocator.locateClaude() },
        tokenProvider: @escaping @MainActor () throws -> String = ClaudeServiceController.storedToken,
        session: URLSession = .shared,
        readinessTimeout: TimeInterval = 30
    ) {
        self.store = store
        self.runtimeProvider = runtimeProvider
        self.tokenProvider = tokenProvider
        self.session = session
        self.readinessTimeout = readinessTimeout
        do { configuration = try store.load() }
        catch { state = .failed(error.localizedDescription) }
    }

    func start(configuration requested: ClaudeServiceConfiguration? = nil) async throws {
        guard !isShuttingDown else { throw ValidationError("应用正在退出，不能启动 Claude 服务") }
        guard process == nil, state != .starting, state != .stopping else {
            throw ValidationError("Claude 服务仍在运行或切换状态")
        }
        generation += 1
        let current = generation
        state = .starting
        do {
            let config = try (requested ?? configuration).validated()
            guard FileManager.default.isExecutableFile(atPath: config.executablePath) else {
                throw ValidationError("找不到可执行的 Claude CLI，请检查路径")
            }
            guard PortProbe.isAvailable(port: config.port) else {
                throw ValidationError("Claude 服务端口 \(config.port) 已被占用；不会停止占用端口的进程")
            }
            let runtime = try runtimeProvider()
            let token = try tokenProvider()
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
                    guard let self, self.generation == current else { return }
                    self.monitor?.cancel()
                    self.monitor = nil
                    self.process = nil
                    self.activeToken = nil
                    self.instanceId = nil
                    self.state = .failed("Claude 后端已退出（状态 \(status)）")
                }
            }
            try child.start()
            let deadline = Date().addingTimeInterval(readinessTimeout)
            while Date() < deadline {
                try Task.checkCancellation()
                guard generation == current, child.isRunning else { throw CancellationError() }
                if try await checkHealth(config: config, token: token, identifier: identifier) {
                    guard generation == current, child.isRunning else { throw CancellationError() }
                    state = .running
                    appendLog("Claude 后端已就绪", token: token)
                    beginMonitoring(config: config, token: token, identifier: identifier, generation: current)
                    return
                }
                try await Task.sleep(nanoseconds: 250_000_000)
            }
            throw ValidationError("等待 Claude 后端启动超时")
        } catch {
            if generation == current {
                let message = DiagnosticRedactor.redact(error.localizedDescription, secrets: [activeToken ?? ""])
                await stopWithFailure(message)
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
        guard let child = process else {
            state = .idle
            return
        }
        state = .stopping
        child.stop()
        await Task.detached {
            if !child.waitUntilExit(deadline: Date().addingTimeInterval(11)) {
                child.forceTerminate()
                _ = child.waitUntilExit(deadline: Date().addingTimeInterval(2))
            }
        }.value
        guard generation == current else { return }
        process = nil
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
        let (data, response) = try await session.data(for: request(config: config, path: "api/pair-info", token: nil))
        guard generation == current, state == .running,
              (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw ValidationError("Claude 配对信息不可用")
        }
        let info = try JSONDecoder().decode(ClaudePairInfo.self, from: data)
        guard info.token == token, !info.bases.isEmpty else { throw ValidationError("Claude 配对信息与本服务不匹配") }
        return info
    }

    private func checkHealth(config: ClaudeServiceConfiguration, token: String, identifier: String) async throws -> Bool {
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request(config: config, path: "api/health", token: token)) }
        catch let error as URLError where [.cannotConnectToHost, .networkConnectionLost, .timedOut].contains(error.code) { return false }
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

    private func stopWithFailure(_ message: String) async {
        let stoppedGeneration = generation + 1
        await stop()
        guard generation == stoppedGeneration else { return }
        state = .failed(message)
    }

    private func beginMonitoring(config: ClaudeServiceConfiguration, token: String, identifier: String, generation current: Int) {
        monitor = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: 2_000_000_000)
                    guard let self, self.generation == current else { return }
                    guard try await self.checkHealth(config: config, token: token, identifier: identifier) else {
                        throw ValidationError("Claude 服务连接已失效")
                    }
                } catch {
                    guard !Task.isCancelled, let self, self.generation == current else { return }
                    let message = DiagnosticRedactor.redact(error.localizedDescription, secrets: [token])
                    await self.stopWithFailure(message)
                    return
                }
            }
        }
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
