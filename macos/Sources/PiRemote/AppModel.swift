import AppKit
import Foundation
import PiRemoteCore
import SwiftUI

enum ConnectionPhase: Equatable {
    case idle
    case connecting
    case connected
    case recovering
    case stopping
    case error

    var isBusy: Bool { self == .connecting || self == .recovering || self == .stopping }

    var title: String {
        switch self {
        case .idle: return "未连接"
        case .connecting: return "连接中"
        case .connected: return "已连接"
        case .recovering: return "连接恢复中"
        case .stopping: return "正在停止"
        case .error: return "连接异常"
        }
    }
}

/// Real connection sub-steps; only ever advanced by actual events, never by timers.
enum ConnectionStep: Int, Comparable {
    case preparing
    case awaitingTunnel
    case awaitingServer

    static func < (lhs: ConnectionStep, rhs: ConnectionStep) -> Bool { lhs.rawValue < rhs.rawValue }
}

enum IdleReason: Equatable {
    case initial
    case disconnected
}

enum ConfigField: Hashable {
    case serverURL, token, workspace, piBin
    case deployHost, deployPort, deployUser, deployKey, deployDomain
}

struct FieldError: LocalizedError {
    let field: ConfigField
    let message: String
    var errorDescription: String? { message }
}

struct LogEntry: Identifiable, Equatable {
    let id: Int
    let text: String
}

enum DeployStage: Equatable {
    case idle
    case fetchingHostKey
    case confirmHostKey(HostKeyInfo)
    case checking
    case preflightFailed([String])
    case confirmDeploy(domain: String, isUpgrade: Bool)
    case running(DeployStep)
    case failed(String)

    var isWorking: Bool {
        switch self {
        case .fetchingHostKey, .checking, .running: return true
        default: return false
        }
    }

    /// While a host or deployment is being confirmed the target must not change under the user.
    var locksConfig: Bool {
        switch self {
        case .idle, .preflightFailed, .failed: return false
        default: return true
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published var mode: ConnectionMode
    @Published var serverURL: String
    @Published var token: String
    @Published var workspacePath: String
    @Published var piBinPath: String
    @Published var runtime: AgentRuntime
    @Published var serverSource: ServerSource
    @Published var deployTarget: RemoteDeployTarget
    @Published var phase: ConnectionPhase = .idle
    @Published var connectionStep: ConnectionStep = .preparing
    @Published var idleReason: IdleReason = .initial
    @Published var fieldErrors: [ConfigField: String] = [:]
    @Published var deployStage: DeployStage = .idle
    @Published var diagnosticsExpanded = false
    @Published var activeService: ServiceKind = .pi
    @Published var statusDetail: String = "未连接"
    @Published var errorMessage: String? = nil
    @Published var infoMessage: String? = nil
    @Published var qrImage: NSImage? = nil
    @Published var tunnelURL: String? = nil
    @Published var legacyAgentDetected: Bool = false
    @Published var logs: [LogEntry] = []
    private(set) var isShuttingDown = false
    lazy var claudeService = ClaudeServiceController()
    private var nextLogId = 0
    private var deployer: RemoteDeployer?
    private var deployTask: Task<Void, Never>?
    private var deployGeneration = 0

    private let configStore: ConfigStore
    private let keychain: KeychainStore
    private let hadSavedConfig: Bool
    private var config: AppConfig

    private var generation = 0
    private var services: [String: SupervisorProcess] = [:]
    private var waitTask: Task<Void, Never>?
    private var monitorTask: Task<Void, Never>?
    private var registrationTask: Task<Void, Never>?
    private var activeToken: String?
    private var activeAgentURL: URL?

    convenience init() {
        self.init(store: ConfigStore(directory: ConfigStore.defaultDirectory()), readKeychain: true)
    }

    /// `readKeychain: false` is for DEBUG snapshot fixtures, which must never touch real credentials.
    init(store: ConfigStore, readKeychain: Bool) {
        let keychain = KeychainStore()
        let saved = store.load()
        var loaded = saved ?? AppConfig.makeDefault(deviceId: DeviceIdentity.makeDeviceId())
        if !DeviceIdentity.isValid(loaded.deviceId) {
            loaded.deviceId = DeviceIdentity.makeDeviceId()
        }
        self.configStore = store
        self.keychain = keychain
        self.hadSavedConfig = saved != nil
        self.config = loaded
        self.mode = loaded.mode
        self.serverURL = loaded.serverURL
        self.workspacePath = loaded.workspacePath
        self.piBinPath = loaded.piBinPath
        self.runtime = loaded.runtime
        self.serverSource = loaded.serverSource
        self.deployTarget = loaded.deployTarget
        self.token = readKeychain ? keychain.token(for: KeychainStore.serverTokenAccount) ?? "" : ""
    }

    // MARK: - Editing guards

    var canEditConfig: Bool { !phase.isBusy && phase != .connected && !deployStage.locksConfig }
    var canConnect: Bool { (phase == .idle || phase == .error) && !deployStage.locksConfig }
    var presentation: ConnectionPresentation {
        ConnectionPresentation.make(
            phase: phase,
            idleReason: idleReason,
            mode: mode,
            step: connectionStep,
            deployVisible: isDeployFlowVisible,
            deployStage: deployStage,
            deploySourceIdle: mode == .server && serverSource == .deploy
        )
    }

    var isDeployFlowVisible: Bool { mode == .server && serverSource == .deploy && deployStage != .idle }
    var canDisconnect: Bool { phase != .idle && phase != .stopping }
    var connectedIOSURL: URL? {
        guard phase == .connected, qrImage != nil, let activeAgentURL else { return nil }
        return try? EndpointValidator.iosURL(forAgentURL: activeAgentURL)
    }

    func onAppear() {
        refreshLegacyAgent()
        if hadSavedConfig && phase == .idle && !isShuttingDown && !(mode == .server && serverSource == .deploy) {
            connect()
        }
    }

    // MARK: - Connect

    func connect() {
        guard canConnect else { return }
        errorMessage = nil
        infoMessage = nil
        qrImage = nil
        tunnelURL = nil
        activeAgentURL = nil
        fieldErrors = [:]
        do {
            try validateFields(for: mode)
            let resolvedConfig = try currentConfig()
            let resolvedToken = try resolveToken(for: resolvedConfig.mode)
            let runtime = try RuntimeLocator.locate()
            try preflight(resolvedConfig)
            try persist(resolvedConfig, token: resolvedToken)

            let currentGeneration = beginGeneration()
            activeToken = resolvedToken
            phase = .connecting
            connectionStep = .preparing
            statusDetail = "正在准备运行环境…"
            appendLog("开始连接（\(resolvedConfig.mode.title)）")
            switch resolvedConfig.mode {
            case .server:
                startServer(config: resolvedConfig, token: resolvedToken, runtime: runtime, generation: currentGeneration)
            case .cloudflare:
                startCloudflare(config: resolvedConfig, token: resolvedToken, runtime: runtime, generation: currentGeneration)
            }
        } catch let error as FieldError {
            fieldErrors[error.field] = error.message
            fail(error.message)
        } catch {
            fail(error.localizedDescription)
        }
    }

    /// Readiness budgets. Cloudflare registration has its own 90s deadline, so the agent
    /// handshake after the tunnel URL is known gets a separate, more generous budget.
    private static let serverReadinessTimeout: TimeInterval = 30
    private static let cloudflareReadinessTimeout: TimeInterval = 60
    private static let tunnelRegistrationTimeout: TimeInterval = 90
    private static let recoveryTimeout: TimeInterval = 90

    func disconnect() {
        guard canDisconnect, phase != .stopping else { return }
        generation += 1
        cancelTasks()
        qrImage = nil
        tunnelURL = nil
        phase = .stopping
        statusDetail = "正在停止受管服务…"
        appendLog("正在停止受管服务…")
        let expected = phase
        let currentGeneration = generation
        Task { [weak self] in
            guard let self else { return }
            await self.stopAllServicesAndWait(timeout: 9)
            guard self.generation == currentGeneration, self.phase == expected else { return }
            self.phase = .idle
            self.idleReason = .disconnected
            self.statusDetail = "已断开"
            self.appendLog("已停止所有受管服务")
        }
    }

    func shutdown() async {
        isShuttingDown = true
        generation += 1
        cancelTasks()
        phase = .stopping
        statusDetail = "正在退出…"
        async let claudeStop: Void = claudeService.shutdown()
        await stopAllServicesAndWait(timeout: 9)
        await claudeStop
    }

    #if DEBUG
    func applyFixtureAgentURL(_ url: URL?) { activeAgentURL = url }
    func appendFixtureLog(_ line: String) { appendLog(line) }
    #endif

    // MARK: - Field validation

    func setRuntime(_ newValue: AgentRuntime) {
        guard canEditConfig, newValue != runtime else { return }
        piBinPath = AgentRuntime.binaryPath(afterSwitchingTo: newValue, current: piBinPath)
        runtime = newValue
        fieldErrors[.piBin] = nil
    }

    /// Light checks run when a field loses focus; existence checks stay in the connect preflight.
    func validateOnBlur(_ field: ConfigField) {
        do {
            try validate(field)
            fieldErrors[field] = nil
        } catch {
            fieldErrors[field] = error.localizedDescription
        }
    }

    func clearFieldError(_ field: ConfigField) {
        if fieldErrors[field] != nil { fieldErrors[field] = nil }
    }

    private func validate(_ field: ConfigField) throws {
        switch field {
        case .serverURL:
            guard !serverURL.trimmingCharacters(in: .whitespaces).isEmpty else { return }
            do { _ = try EndpointValidator.validateWebSocket(serverURL, expectedPath: .agent) } catch {
                throw FieldError(field: field, message: "请输入完整的服务器连接地址（wss://…/ws/agent）")
            }
        case .token:
            let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            do { _ = try EndpointValidator.validateToken(trimmed) } catch {
                throw FieldError(field: field, message: error.localizedDescription)
            }
        case .deployHost, .deployPort, .deployUser, .deployKey, .deployDomain:
            do { _ = try deployTarget.validated() } catch {
                let message = error.localizedDescription
                if Self.deployField(for: message) == field { throw FieldError(field: field, message: message) }
            }
        case .workspace, .piBin:
            return
        }
    }

    private func validateFields(for mode: ConnectionMode) throws {
        if mode == .server {
            do { _ = try EndpointValidator.validateWebSocket(serverURL, expectedPath: .agent) } catch {
                throw FieldError(field: .serverURL, message: "请输入完整的服务器连接地址（wss://…/ws/agent）")
            }
        }
        let workspace = ((workspacePath as NSString).expandingTildeInPath as NSString).standardizingPath
        var isDirectory: ObjCBool = false
        guard workspace.hasPrefix("/"), workspace != "/",
              FileManager.default.fileExists(atPath: workspace, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw FieldError(field: .workspace, message: "找不到这个文件夹，请重新选择")
        }
        guard let resolved = ExecutableResolver.resolve(piBinPath.trimmingCharacters(in: .whitespacesAndNewlines), searchPath: effectiveSearchPath()),
              FileManager.default.isExecutableFile(atPath: resolved) else {
            throw FieldError(field: .piBin, message: "找不到 \(runtime.rawValue)，请检查可执行文件路径")
        }
    }

    private static func deployField(for message: String) -> ConfigField {
        if message.contains("端口") { return .deployPort }
        if message.contains("用户") { return .deployUser }
        if message.contains("私钥") || message.contains("密钥") { return .deployKey }
        if message.contains("域名") { return .deployDomain }
        return .deployHost
    }

    // MARK: - Deploy to own server

    var deployDomainPreview: String {
        let domain = deployTarget.domain.trimmingCharacters(in: .whitespaces)
        if !domain.isEmpty { return domain }
        return SSLipDomain.make(ipv4: deployTarget.host.trimmingCharacters(in: .whitespaces)) ?? "按服务器 IP 生成的 sslip.io 域名"
    }

    func startDeploy() {
        guard canConnect, phase != .connected else { return }
        errorMessage = nil
        infoMessage = nil
        fieldErrors = [:]
        let target: RemoteDeployTarget
        do {
            target = try deployTarget.validated()
            guard FileManager.default.isReadableFile(atPath: (target.identityFile as NSString).expandingTildeInPath) else {
                throw FieldError(field: .deployKey, message: "无法读取这个私钥文件，请重新选择")
            }
            deployTarget = target
            try saveNonSecretConfig()
        } catch let error as FieldError {
            fieldErrors[error.field] = error.message
            return
        } catch {
            fieldErrors[Self.deployField(for: error.localizedDescription)] = error.localizedDescription
            return
        }
        let deployer: RemoteDeployer
        do {
            deployer = try makeDeployer()
        } catch {
            deployStage = .failed(error.localizedDescription)
            return
        }
        let generation = beginDeployGeneration()
        appendLog("准备部署到 \(target.user)@\(target.host):\(target.port)")
        if deployer.knownHostKey(for: target) {
            runPreflight(target, generation: generation)
            return
        }
        deployStage = .fetchingHostKey
        deployTask = Task { [weak self] in
            do {
                let info = try await deployer.fetchHostKey(for: target)
                guard let self, self.deployGeneration == generation else { return }
                self.deployStage = .confirmHostKey(info)
            } catch {
                self?.deployFailed(error, generation: generation)
            }
        }
    }

    func trustHostKey() {
        guard case .confirmHostKey(let info) = deployStage, let deployer else { return }
        do {
            try deployer.trust(info)
            appendLog("已信任主机指纹 \(info.fingerprints.first ?? "")")
            runPreflight(deployTarget, generation: deployGeneration)
        } catch {
            deployFailed(error, generation: deployGeneration)
        }
    }

    func confirmDeploy() {
        guard case .confirmDeploy = deployStage, let deployer else { return }
        let target = deployTarget
        let generation = deployGeneration
        deployStage = .running(.upload)
        deployTask = Task { [weak self] in
            do {
                let result = try await deployer.deploy(target) { [weak self] event in
                    Task { @MainActor in
                        guard let self, self.deployGeneration == generation else { return }
                        switch event {
                        case .step(let step): self.deployStage = .running(step)
                        case .log(let line): self.appendLog("[deploy] \(line)")
                        }
                    }
                }
                guard let self, self.deployGeneration == generation else { return }
                self.finishDeploy(result)
            } catch {
                self?.deployFailed(error, generation: generation)
            }
        }
    }

    func cancelDeploy() {
        let wasRunning: Bool
        if case .running = deployStage { wasRunning = true } else { wasRunning = false }
        deployGeneration += 1
        deployTask?.cancel()
        deployTask = nil
        deployer?.cancel()
        deployStage = .idle
        if wasRunning {
            infoMessage = "已取消部署。服务器上可能已完成部分步骤；未完成的升级会由安装器自动回滚。"
            appendLog("用户取消了部署")
        }
    }

    func dismissDeployResult() {
        guard !deployStage.isWorking else { return }
        deployStage = .idle
    }

    private func runPreflight(_ target: RemoteDeployTarget, generation: Int) {
        guard let deployer else { return }
        deployStage = .checking
        deployTask = Task { [weak self] in
            do {
                let report = try await deployer.preflight(target)
                guard let self, self.deployGeneration == generation else { return }
                if report.passed {
                    self.deployStage = .confirmDeploy(domain: self.deployDomainPreview, isUpgrade: report.isUpgrade)
                } else {
                    self.appendLog("服务器预检未通过：\(report.issues.joined(separator: "；"))")
                    self.deployStage = .preflightFailed(report.issues)
                }
            } catch {
                self?.deployFailed(error, generation: generation)
            }
        }
    }

    private func finishDeploy(_ result: DeployResult) {
        deployTask = nil
        deployStage = .idle
        serverURL = result.agentURL.absoluteString
        token = result.token
        serverSource = .existing
        appendLog("部署完成：\(result.domain)\(result.wasUpgrade ? "（已升级，保留原连接密钥）" : "")")
        connect()
        infoMessage = "已部署到 \(result.domain)，连接密钥已保存到钥匙���。"
    }

    private func deployFailed(_ error: Error, generation: Int) {
        guard deployGeneration == generation else { return }
        deployTask = nil
        if error is CancellationError { return }
        let message = error.localizedDescription
        appendLog("部署失败：\(message)")
        deployStage = .failed(message)
    }

    private func beginDeployGeneration() -> Int {
        deployGeneration += 1
        deployTask?.cancel()
        return deployGeneration
    }

    private func makeDeployer() throws -> RemoteDeployer {
        if let deployer { return deployer }
        let created = RemoteDeployer(
            serverBundle: try RuntimeLocator.locateServerBundle(),
            knownHostsURL: configStore.directory.appendingPathComponent("known_hosts")
        )
        deployer = created
        return created
    }

    private func saveNonSecretConfig() throws {
        var snapshot = config
        snapshot.mode = mode
        snapshot.serverSource = serverSource
        snapshot.deployTarget = deployTarget
        snapshot.runtime = runtime
        try configStore.save(snapshot)
        config = snapshot
    }

    // MARK: - Legacy agent handoff

    func refreshLegacyAgent() {
        legacyAgentDetected = LegacyAgentHandoff.isInstalled()
    }

    func takeoverLegacyAgent() {
        do {
            try LegacyAgentHandoff.takeover()
            legacyAgentDetected = false
            infoMessage = "已停用旧 launchd 服务 \(LegacyAgentHandoff.label)。退出本应用后不会自动恢复它。"
            appendLog("已 bootout + disable \(LegacyAgentHandoff.domainTarget)")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - .env import

    func importDotEnv(from url: URL) {
        do {
            let text = try String(contentsOf: url, encoding: .utf8)
            let values = DotEnv.extract(text)
            var applied: [String] = []
            var skipped: [String] = []
            if let relayURL = values.relayURL, !relayURL.isEmpty {
                serverURL = relayURL
                applied.append("服务器地址")
            }
            if let importedToken = values.effectiveToken, !importedToken.isEmpty {
                token = importedToken
                applied.append("Token")
            }
            if let piBin = values.piBin, !piBin.isEmpty {
                if let resolved = ExecutableResolver.resolve(piBin, searchPath: effectiveSearchPath()) {
                    piBinPath = resolved
                    applied.append("PI_BIN")
                } else {
                    skipped.append("PI_BIN（\"\(piBin)\" 不是可执行文件，已保留原值）")
                }
            }
            if let rawRuntime = values.runtime, !rawRuntime.isEmpty {
                if let imported = AgentRuntime(rawValue: rawRuntime.lowercased()) {
                    if values.piBin == nil { piBinPath = AgentRuntime.binaryPath(afterSwitchingTo: imported, current: piBinPath) }
                    runtime = imported
                    applied.append("运行时")
                } else {
                    skipped.append("运行时（\(rawRuntime) 不是 pi 或 omp，已保留原值）")
                }
            }
            if let workspace = values.workspaceRoot, !workspace.isEmpty {
                let expanded = (workspace as NSString).expandingTildeInPath
                if expanded.hasPrefix("/"), expanded != "/" {
                    workspacePath = expanded
                    applied.append("工作区")
                } else {
                    skipped.append("工作区（\(workspace) 不是绝对路径，已保留原值）")
                }
            }
            if applied.isEmpty && skipped.isEmpty {
                infoMessage = "该文件没有可导入的配置项（仅读取 RELAY_URL、RELAY_TOKEN、AGENT_TOKEN、PI_BIN、PI_WORKSPACE_ROOT、PI_RUNTIME）"
            } else {
                var message = applied.isEmpty ? "没有配置项被导入" : "已导入：\(applied.joined(separator: "、"))"
                if !skipped.isEmpty { message += "；已跳过：\(skipped.joined(separator: "、"))" }
                infoMessage = message + (applied.isEmpty ? "。" : "。连接时保存，密钥只存入钥匙串。")
                if !applied.isEmpty, mode == .server { serverSource = .existing }
            }
            appendLog("已从 \(url.lastPathComponent) 导入：\(applied.isEmpty ? "无可用配置" : applied.joined(separator: "、"))")
        } catch {
            errorMessage = "无法读取文件：\(error.localizedDescription)"
        }
    }

    // MARK: - Modes

    private func startServer(config: AppConfig, token: String, runtime: RuntimePaths, generation currentGeneration: Int) {
        guard let agentURL = URL(string: config.serverURL) else {
            fail("服务器地址无效")
            return
        }
        let environment = baseEnvironment(runtime: runtime)
        let job = JobBuilder.agentJob(
            nodePath: runtime.node.path,
            runtimeDirectory: runtime.runtimeDirectory.path,
            agentURL: config.serverURL,
            token: token,
            deviceId: config.deviceId,
            workspacePath: config.workspacePath,
            piBinPath: config.piBinPath,
            runtime: config.runtime,
            baseEnvironment: environment
        )
        do {
            try launch(job: job, node: runtime.node, supervisor: runtime.supervisor, generation: currentGeneration)
        } catch {
            failAndCleanup(error.localizedDescription, generation: currentGeneration)
            return
        }
        activeAgentURL = agentURL
        advance(to: .awaitingServer)
        statusDetail = "Mac Agent 已启动，正在等待 Relay 握手…"
        waitForReady(
            agentURL: agentURL,
            deviceId: config.deviceId,
            token: token,
            generation: currentGeneration,
            deadline: Date().addingTimeInterval(Self.serverReadinessTimeout)
        )
    }

    private func startCloudflare(config: AppConfig, token: String, runtime: RuntimePaths, generation currentGeneration: Int) {
        let port = AppConfig.defaultRelayPort
        let environment = baseEnvironment(runtime: runtime)
        let emptyConfig: URL
        do {
            emptyConfig = try ensureEmptyTunnelConfig()
        } catch {
            failAndCleanup(error.localizedDescription, generation: currentGeneration)
            return
        }
        let relayJob = JobBuilder.relayJob(
            nodePath: runtime.node.path,
            runtimeDirectory: runtime.runtimeDirectory.path,
            port: port,
            token: token,
            workspacePath: config.workspacePath,
            piBinPath: config.piBinPath,
            runtime: config.runtime,
            baseEnvironment: environment
        )
        let tunnelJob = JobBuilder.tunnelJob(
            cloudflaredPath: runtime.cloudflared.path,
            runtimeDirectory: runtime.runtimeDirectory.path,
            port: port,
            emptyConfigPath: emptyConfig.path,
            baseEnvironment: environment
        )
        do {
            try launch(job: relayJob, node: runtime.node, supervisor: runtime.supervisor, generation: currentGeneration)
            try launch(job: tunnelJob, node: runtime.node, supervisor: runtime.supervisor, generation: currentGeneration)
        } catch {
            failAndCleanup(error.localizedDescription, generation: currentGeneration)
            return
        }
        advance(to: .awaitingTunnel)
        statusDetail = "正在启动本地 Relay 与 Cloudflare Tunnel…"
        beginTunnelRegistrationDeadline(generation: currentGeneration)
        waitForLocalRelay(port: port, config: config, token: token, generation: currentGeneration)
    }

    private func waitForLocalRelay(port: Int, config: AppConfig, token: String, generation currentGeneration: Int) {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/health") else { return }
        Task { [weak self] in
            guard let self else { return }
            let deadline = Date().addingTimeInterval(15)
            while Date() < deadline {
                if Task.isCancelled { return }
                guard self.generation == currentGeneration else { return }
                if await HealthChecker.localHealthOK(url: url, timeout: 3) {
                    guard self.generation == currentGeneration else { return }
                    self.appendLog("本地 Relay 已就绪（127.0.0.1:\(port)）")
                    self.statusDetail = "本地 Relay 已就绪，等待 Cloudflare 分配公网地址…"
                    return
                }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
            guard self.generation == currentGeneration else { return }
            self.failAndCleanup("本地 Relay 在 15 秒内未就绪（端口 \(port)）", generation: currentGeneration)
        }
    }

    private func beginTunnelRegistrationDeadline(generation currentGeneration: Int) {
        registrationTask?.cancel()
        registrationTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.tunnelRegistrationTimeout * 1_000_000_000))
            guard let self, !Task.isCancelled else { return }
            guard self.generation == currentGeneration else { return }
            if self.tunnelURL == nil {
                self.failAndCleanup(
                    "Cloudflare 在 \(Int(Self.tunnelRegistrationTimeout)) 秒内没有返回公网地址，请检查网络后重试",
                    generation: currentGeneration
                )
            }
        }
    }

    private func startAgentAgainstTunnel(publicURL: URL, generation currentGeneration: Int) {
        guard self.generation == currentGeneration else { return }
        guard let agentURL = TunnelLogParser.agentURL(fromPublicURL: publicURL),
              let token = activeToken,
              let runtime = try? RuntimeLocator.locate() else {
            failAndCleanup("无法从 Tunnel 地址构造 Agent 地址", generation: currentGeneration)
            return
        }
        let job = JobBuilder.agentJob(
            nodePath: runtime.node.path,
            runtimeDirectory: runtime.runtimeDirectory.path,
            agentURL: agentURL.absoluteString,
            token: token,
            deviceId: config.deviceId,
            workspacePath: config.workspacePath,
            piBinPath: config.piBinPath,
            runtime: config.runtime,
            baseEnvironment: baseEnvironment(runtime: runtime)
        )
        do {
            try launch(job: job, node: runtime.node, supervisor: runtime.supervisor, generation: currentGeneration)
        } catch {
            failAndCleanup(error.localizedDescription, generation: currentGeneration)
            return
        }
        activeAgentURL = agentURL
        advance(to: .awaitingServer)
        appendLog("公网地址：\(publicURL.absoluteString)")
        statusDetail = "Tunnel 已就绪，正在等待 Agent 握手…"
        waitForReady(
            agentURL: agentURL,
            deviceId: config.deviceId,
            token: token,
            generation: currentGeneration,
            deadline: Date().addingTimeInterval(Self.cloudflareReadinessTimeout)
        )
    }

    // MARK: - Readiness and monitoring

    private func waitForReady(agentURL: URL, deviceId: String, token: String, generation currentGeneration: Int, deadline: Date) {
        waitTask?.cancel()
        waitTask = Task { [weak self] in
            var lastMessage = "尚未收到健康检查结果"
            while Date() < deadline {
                if Task.isCancelled { return }
                guard let self, self.generation == currentGeneration else { return }
                let outcome = await HealthChecker.check(agentURL: agentURL, expectedDeviceId: deviceId, timeout: 8)
                if Task.isCancelled { return }
                guard self.generation == currentGeneration else { return }
                switch outcome {
                case .ready:
                    self.showConnected(agentURL: agentURL, token: token, generation: currentGeneration)
                    return
                case .notReady(let message), .failed(let message):
                    lastMessage = message
                }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
            guard let self, self.generation == currentGeneration else { return }
            self.failAndCleanup("初次连通超时：\(lastMessage)", generation: currentGeneration)
        }
    }

    private func showConnected(agentURL: URL, token: String, generation currentGeneration: Int) {
        guard self.generation == currentGeneration else { return }
        do {
            let text = try ConnectionQRCode.text(agentURL: agentURL, token: token)
            guard let cgImage = ConnectionQRCode.image(from: text) else {
                throw ValidationError("二维码生成失败")
            }
            qrImage = NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
        } catch {
            failAndCleanup(error.localizedDescription, generation: currentGeneration)
            return
        }
        phase = .connected
        statusDetail = "已连接：Agent 握手与公网健康检查通过"
        errorMessage = nil
        appendLog("Agent 握手与健康检查通过（deviceId=\(config.deviceId)），二维码已显示")
        startMonitor(agentURL: agentURL, token: token, deviceId: config.deviceId, generation: currentGeneration)
    }

    /// Keeps the managed processes alive while the Relay/Agent recovers. The QR is hidden as soon as
    /// a health check fails and is only shown again after the health check passes, and only within
    /// the bounded recovery window; otherwise the whole tree is cleaned up and an error is reported.
    private func startMonitor(agentURL: URL, token: String, deviceId: String, generation currentGeneration: Int) {
        monitorTask?.cancel()
        monitorTask = Task { [weak self] in
            var recoveryDeadline: Date?
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                if Task.isCancelled { return }
                guard let self, self.generation == currentGeneration, !self.isShuttingDown else { return }
                let outcome = await HealthChecker.check(agentURL: agentURL, expectedDeviceId: deviceId, timeout: 8)
                if Task.isCancelled { return }
                guard self.generation == currentGeneration, !self.isShuttingDown else { return }

                if case .ready = outcome {
                    recoveryDeadline = nil
                    if self.phase == .recovering {
                        self.appendLog("健康检查恢复，重新显示二维码")
                        self.showConnected(agentURL: agentURL, token: token, generation: currentGeneration)
                        return
                    }
                    continue
                }

                if self.phase != .recovering {
                    self.qrImage = nil
                    self.phase = .recovering
                    self.statusDetail = "连接中断，正在等待 Agent/Relay 自动恢复…"
                    recoveryDeadline = Date().addingTimeInterval(Self.recoveryTimeout)
                    self.appendLog("健康检查未通过：\(outcome.message)。已隐藏二维码，保留受管进程等待自动重连")
                }
                if let deadline = recoveryDeadline, Date() >= deadline {
                    self.failAndCleanup("连接在 \(Int(Self.recoveryTimeout)) 秒内未恢复：\(outcome.message)", generation: currentGeneration)
                    return
                }
            }
        }
    }

    // MARK: - Process handling

    private func launch(job: SupervisorJob, node: URL, supervisor: URL, generation currentGeneration: Int) throws {
        if let existing = services[job.tag] {
            existing.stop()
            services[job.tag] = nil
        }
        let process = SupervisorProcess(job: job, node: node, supervisor: supervisor)
        process.onOutput = { [weak self] line in
            Task { @MainActor in self?.handleOutput(line, tag: job.tag, generation: currentGeneration) }
        }
        process.onExit = { [weak self] status in
            Task { @MainActor in self?.handleExit(tag: job.tag, status: status, generation: currentGeneration) }
        }
        services[job.tag] = process
        try process.start()
        appendLog("已启动 \(displayName(for: job.tag)) 进程")
    }

    private func handleOutput(_ line: String, tag: String, generation currentGeneration: Int) {
        guard self.generation == currentGeneration, !line.isEmpty else { return }
        appendLog("[\(tag)] \(redact(line))")
        if tag == "tunnel", tunnelURL == nil, let publicURL = TunnelLogParser.publicURL(in: line) {
            tunnelURL = publicURL.absoluteString
            registrationTask?.cancel()
            startAgentAgainstTunnel(publicURL: publicURL, generation: currentGeneration)
        }
    }

    private func handleExit(tag: String, status: Int32, generation currentGeneration: Int) {
        guard self.generation == currentGeneration else { return }
        guard phase == .connecting || phase == .connected || phase == .recovering else { return }
        failAndCleanup("\(displayName(for: tag)) 进程已退出（退出码 \(status)），连接已中断", generation: currentGeneration)
    }

    @discardableResult
    private func stopAllServicesAndWait(timeout: TimeInterval) async -> Bool {
        let processes = Array(services.values)
        services.removeAll()
        guard !processes.isEmpty else { return true }
        for process in processes { process.stop() }
        return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            DispatchQueue.global().async {
                let deadline = Date().addingTimeInterval(timeout)
                var allExited = true
                for process in processes {
                    if !process.waitUntilExit(deadline: deadline) {
                        process.forceTerminate()
                        allExited = false
                    }
                }
                continuation.resume(returning: allExited)
            }
        }
    }

    // MARK: - State helpers

    private func beginGeneration() -> Int {
        generation += 1
        cancelTasks()
        return generation
    }

    private func cancelTasks() {
        waitTask?.cancel()
        waitTask = nil
        monitorTask?.cancel()
        monitorTask = nil
        registrationTask?.cancel()
        registrationTask = nil
    }

    private func fail(_ message: String) {
        errorMessage = message
        statusDetail = message
        qrImage = nil
        phase = .error
        appendLog("错误：\(message)")
    }

    /// Invalidates the current generation first so no in-flight task can keep writing state, then
    /// stays in `.stopping` until every managed process has actually exited. Only afterwards does it
    /// report the error, so a retry cannot race with processes or a still-bound local port.
    private func failAndCleanup(_ message: String, generation currentGeneration: Int) {
        guard self.generation == currentGeneration else { return }
        generation += 1
        let cleanupGeneration = generation
        cancelTasks()
        qrImage = nil
        tunnelURL = nil
        phase = .stopping
        statusDetail = "正在清理受管进程…"
        appendLog("错误：\(message)")
        Task { [weak self] in
            guard let self else { return }
            await self.stopAllServicesAndWait(timeout: 9)
            guard self.generation == cleanupGeneration else { return }
            self.phase = .error
            self.errorMessage = message
            self.statusDetail = message
            self.appendLog("受管进程已全部退出，可重新连接")
        }
    }

    private func appendLog(_ line: String) {
        let stamp = Self.timeFormatter.string(from: Date())
        nextLogId += 1
        logs.append(LogEntry(id: nextLogId, text: "[\(stamp)] \(redact(line))"))
        if logs.count > 300 { logs.removeFirst(logs.count - 300) }
    }

    /// A later callback (e.g. health vs. tunnel URL arriving out of order) must never move the step backwards.
    private func advance(to step: ConnectionStep) {
        if step > connectionStep { connectionStep = step }
    }

    private func redact(_ line: String) -> String {
        DiagnosticRedactor.redact(line, secrets: knownSecrets())
    }

    private func knownSecrets() -> [String] {
        [token, activeToken ?? ""]
    }

    /// Version, mode, state and redacted log only; no token, QR payload or home directory.
    func diagnosticsReport() -> String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        var lines = [
            "Pi Remote \(version)",
            "模式：\(mode.title)\(mode == .server ? "（\(serverSource == .deploy ? "部署到服务器" : "已有服务器")）" : "")",
            "运行时：\(runtime.rawValue)",
            "状态：\(phase.title)",
            "",
        ]
        lines += logs.map(\.text)
        return lines.map { DiagnosticRedactor.redact($0, secrets: knownSecrets()) }.joined(separator: "\n")
    }

    private func displayName(for tag: String) -> String {
        switch tag {
        case "agent": return "Mac Agent"
        case "relay": return "本地 Relay"
        case "tunnel": return "Cloudflare Tunnel"
        default: return tag
        }
    }

    // MARK: - Config helpers

    private func currentConfig() throws -> AppConfig {
        var candidate = AppConfig(
            mode: mode,
            serverURL: serverURL,
            workspacePath: workspacePath,
            piBinPath: piBinPath,
            deviceId: config.deviceId,
            runtime: runtime,
            serverSource: serverSource,
            deployTarget: deployTarget
        )
        candidate = try candidate.validated()
        guard let resolvedPiBin = ExecutableResolver.resolve(candidate.piBinPath, searchPath: effectiveSearchPath()) else {
            throw FieldError(field: .piBin, message: "找不到可执行的 PI_BIN：\(candidate.piBinPath)（可在 PATH 中查找，或填写绝对路径）")
        }
        candidate.piBinPath = resolvedPiBin
        piBinPath = resolvedPiBin
        return candidate
    }

    private func effectiveSearchPath() -> String {
        RuntimeEnvironment.path(
            bundledNodeDirectory: RuntimeLocator.bundledRuntimeDirectory().path,
            original: ProcessInfo.processInfo.environment["PATH"]
        )
    }

    private func resolveToken(for mode: ConnectionMode) throws -> String {
        switch mode {
        case .server:
            let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
            let value: String
            if trimmed.isEmpty {
                guard let stored = keychain.token(for: KeychainStore.serverTokenAccount) else {
                    throw FieldError(field: .token, message: "请输入至少 32 个字符的连接密钥")
                }
                value = stored
            } else {
                value = trimmed
            }
            let validated: String
            do { validated = try EndpointValidator.validateToken(value) } catch {
                throw FieldError(field: .token, message: error.localizedDescription)
            }
            token = validated
            return validated
        case .cloudflare:
            guard let generated = TokenGenerator.randomHex(byteCount: 32) else {
                throw ValidationError("无法生成随机 Token")
            }
            return try EndpointValidator.validateToken(generated)
        }
    }

    private func persist(_ config: AppConfig, token: String) throws {
        try configStore.save(config)
        self.config = config
        if config.mode == .server {
            guard keychain.setToken(token, for: KeychainStore.serverTokenAccount) else {
                throw ValidationError("无法把 Token 写入系统钥匙串，请检查钥匙串访问权限后重试")
            }
        }
    }

    private func preflight(_ config: AppConfig) throws {
        if config.mode == .cloudflare {
            guard PortProbe.isAvailable(port: AppConfig.defaultRelayPort) else {
                throw ValidationError("本地端口 \(AppConfig.defaultRelayPort) 已被占用，请先释放该端口再连接")
            }
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: config.workspacePath, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw ValidationError("工作区目录不存在：\(config.workspacePath)")
        }
        guard FileManager.default.isExecutableFile(atPath: config.piBinPath) else {
            throw ValidationError("PI_BIN 不可执行：\(config.piBinPath)")
        }
    }

    private func baseEnvironment(runtime: RuntimePaths) -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = RuntimeEnvironment.path(
            bundledNodeDirectory: runtime.nodeDirectory,
            original: environment["PATH"]
        )
        return environment
    }

    private func ensureEmptyTunnelConfig() throws -> URL {
        let directory = configStore.directory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("cloudflared-empty.yml")
        if !FileManager.default.fileExists(atPath: url.path) {
            try "# pi-remote: 故意留空的配置，避免 cloudflared 读取用户已有的 ~/.cloudflared/config.yml\n"
                .write(to: url, atomically: true, encoding: .utf8)
        }
        return url
    }

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()
}
