import Darwin
import Foundation
import XCTest
import PiRemoteCore
@testable import PiRemote

@MainActor
final class ClaudeServiceControllerTests: XCTestCase {
    private let token = String(repeating: "c", count: 64)

    private func temporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("claude-service-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func unusedPort() throws -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ValidationError("socket failed") }
        defer { close(fd) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0 else { throw ValidationError("bind failed") }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let result = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        guard result == 0 else { throw ValidationError("getsockname failed") }
        return Int(UInt16(bigEndian: address.sin_port))
    }

    private func fixture(_ directory: URL, healthMode: String = "valid", cloudflared: URL? = nil, instanceFile: URL? = nil) throws -> ClaudeRuntimePaths {
        let node = URL(fileURLWithPath: "/usr/local/bin/node")
        guard FileManager.default.isExecutableFile(atPath: node.path) else { throw XCTSkip("Node runtime is not installed") }
        let source = directory.appendingPathComponent("runtime/claude/src")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        let instanceLine = instanceFile.map { "import fs from 'node:fs';\nfs.writeFileSync('\($0.path)', process.env.BRIDGE_INSTANCE_ID);\n" } ?? ""
        let script = """
        import http from 'node:http';
        \(instanceLine)const server = http.createServer((req, res) => {
          res.setHeader('content-type', 'application/json');
          if (req.url === '/api/health') {
            if ('\(healthMode)' === 'waiting') { req.socket.destroy(); return; }
            if ('\(healthMode)' === 'unauthorized') { res.writeHead(401); res.end('{}'); return; }
            res.end(JSON.stringify({ok:true, service:'pi-remote-claude', instanceId:'\(healthMode)' === 'wrong' ? 'wrong' : process.env.BRIDGE_INSTANCE_ID}));
          } else if (req.url === '/api/pair-info') {
            res.end(JSON.stringify({bases:['http://127.0.0.1:' + process.env.BRIDGE_PORT], token:process.env.BRIDGE_TOKEN}));
          } else { res.writeHead(404); res.end('{}'); }
        });
        server.listen(Number(process.env.BRIDGE_PORT), '127.0.0.1', () => console.log('token=' + process.env.BRIDGE_TOKEN));
        process.on('SIGTERM', () => setTimeout(() => server.close(() => process.exit(0)), '\(healthMode)' === 'slow-stop' ? 800 : 0));
        """
        try Data(script.utf8).write(to: source.appendingPathComponent("index.ts"))
        let macos = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return ClaudeRuntimePaths(
            runtimeDirectory: directory.appendingPathComponent("runtime"),
            node: node,
            supervisor: macos.appendingPathComponent("runtime-supervisor.mjs"),
            cloudflared: cloudflared
        )
    }

    /// A stand-in for the shared cloudflared binary: prints one URL, then stays alive until a kill
    /// file appears (or the supervisor terminates it).
    private func fakeCloudflared(in directory: URL, printedURL: String, envDump: URL? = nil) throws -> URL {
        let executable = directory.appendingPathComponent("cloudflared-fake")
        let killFile = directory.appendingPathComponent("cloudflared-kill")
        try? FileManager.default.removeItem(at: killFile)
        var script = "#!/bin/sh\n"
        if let envDump { script += "env > '\(envDump.path)'\n" }
        script += "echo \"2026-10-03T00:00:00Z INF |  \(printedURL)  |\"\n"
        script += "while [ ! -f '\(killFile.path)' ]; do sleep 0.1; done\n"
        script += "exit 7\n"
        try Data(script.utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        return executable
    }

    private func cloudConfig(_ directory: URL, port: Int) -> ClaudeServiceConfiguration {
        ClaudeServiceConfiguration(
            port: port,
            executablePath: "/usr/bin/true",
            projectsDirectory: directory.appendingPathComponent("projects").path,
            dataDirectory: directory.appendingPathComponent("data").path,
            mode: .cloudflare
        )
    }

    private func mockTunnelSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ClaudeTunnelURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private func cloudController(_ directory: URL, runtime: ClaudeRuntimePaths, session: URLSession, urlTimeout: TimeInterval = 5, healthTimeout: TimeInterval = 5) -> ClaudeServiceController {
        ClaudeServiceController(
            store: ClaudeConfigStore(file: directory.appendingPathComponent("claude-config.json")),
            runtimeProvider: { runtime },
            tokenProvider: { throw ValidationError("cloud mode must not use the persistent token provider") },
            session: session,
            readinessTimeout: 5,
            tunnelURLTimeout: urlTimeout,
            publicHealthTimeout: healthTimeout
        )
    }

    private func controller(_ directory: URL, runtime: ClaudeRuntimePaths) -> ClaudeServiceController {
        ClaudeServiceController(store: ClaudeConfigStore(file: directory.appendingPathComponent("claude-config.json")), runtimeProvider: { runtime }, tokenProvider: { self.token }, readinessTimeout: 5)
    }

    private func config(_ directory: URL, port: Int) -> ClaudeServiceConfiguration {
        ClaudeServiceConfiguration(port: port, executablePath: "/usr/bin/true", projectsDirectory: directory.appendingPathComponent("projects").path, dataDirectory: directory.appendingPathComponent("data").path)
    }

    func testStartPairRestartAndStopUseOwnProcess() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let runtime = try fixture(directory)
        let service = controller(directory, runtime: runtime)
        let configuration = config(directory, port: try unusedPort())
        XCTAssertEqual(service.state, .idle)
        try await service.start(configuration: configuration)
        XCTAssertEqual(service.state, .running)
        let pair = try await service.readPairInfo()
        XCTAssertEqual(pair.token, token)
        XCTAssertEqual(pair.bases, [configuration.baseURL.absoluteString])
        XCTAssertFalse(service.logs.joined().contains(token))
        try await service.restart()
        XCTAssertEqual(service.state, .running)
        await service.stop()
        XCTAssertEqual(service.state, .idle)
        XCTAssertTrue(PortProbe.isAvailable(port: configuration.port))
    }

    func testWrongIdentityAndUnauthorizedAreNotHealthy() async throws {
        for mode in ["wrong", "unauthorized"] {
            let directory = try temporaryDirectory()
            let runtime = try fixture(directory, healthMode: mode)
            let service = controller(directory, runtime: runtime)
            let configuration = config(directory, port: try unusedPort())
            do {
                try await service.start(configuration: configuration)
                XCTFail("\(mode) should be rejected")
            } catch {
                guard case .failed = service.state else { return XCTFail("Expected failed state") }
                XCTAssertTrue(PortProbe.isAvailable(port: configuration.port))
            }
            await service.stop()
            try FileManager.default.removeItem(at: directory)
        }
    }

    func testPortConflictDoesNotStopExternalProcess() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let runtime = try fixture(directory)
        let port = try unusedPort()
        let external = Process()
        external.executableURL = runtime.node
        external.arguments = [runtime.runtimeDirectory.appendingPathComponent("claude/src/index.ts").path]
        external.environment = ["BRIDGE_PORT": String(port), "BRIDGE_TOKEN": token, "BRIDGE_INSTANCE_ID": UUID().uuidString]
        external.standardOutput = FileHandle.nullDevice
        external.standardError = FileHandle.nullDevice
        try external.run()
        defer { if external.isRunning { external.terminate(); external.waitUntilExit() } }
        for _ in 0..<50 {
            if !PortProbe.isAvailable(port: port) { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertFalse(PortProbe.isAvailable(port: port))
        let service = controller(directory, runtime: runtime)
        do {
            try await service.start(configuration: config(directory, port: port))
            XCTFail("Port conflict should be rejected")
        } catch {
            XCTAssertTrue(external.isRunning)
        }
        await service.stop()
        XCTAssertTrue(external.isRunning)
        let (_, response) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:\(port)/api/health")!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    func testPiDisconnectLeavesClaudeRunningAndAppShutdownStopsIt() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let runtime = try fixture(directory)
        let service = controller(directory, runtime: runtime)
        let configuration = config(directory, port: try unusedPort())
        try await service.start(configuration: configuration)
        let model = AppModel(store: ConfigStore(directory: directory.appendingPathComponent("pi")), readKeychain: false)
        model.claudeService = service
        model.phase = .connected
        model.disconnect()
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(service.state, .running)
        let (_, response) = try await URLSession.shared.data(from: configuration.baseURL.appendingPathComponent("api/health"))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        await model.shutdown()
        XCTAssertEqual(service.state, .idle)
        XCTAssertTrue(PortProbe.isAvailable(port: configuration.port))
        do {
            try await service.start(configuration: configuration)
            XCTFail("A shut-down controller must not restart")
        } catch { XCTAssertEqual(service.state, .idle) }
    }

    func testStopDuringStartupDoesNotReviveService() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let runtime = try fixture(directory, healthMode: "waiting")
        let service = controller(directory, runtime: runtime)
        let configuration = config(directory, port: try unusedPort())
        let starting = Task { try await service.start(configuration: configuration) }
        for _ in 0..<100 {
            if !service.logs.isEmpty { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(service.state, .starting)
        await service.stop()
        do {
            try await starting.value
            XCTFail("Interrupted startup should be cancelled")
        } catch is CancellationError {}
        catch { XCTFail("Expected CancellationError, got \(error)") }
        XCTAssertEqual(service.state, .idle)
        XCTAssertTrue(PortProbe.isAvailable(port: configuration.port))
    }

    func testStopDuringRestartCancelsPendingRestart() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let runtime = try fixture(directory, healthMode: "slow-stop")
        let service = controller(directory, runtime: runtime)
        let configuration = config(directory, port: try unusedPort())
        try await service.start(configuration: configuration)
        let restarting = Task { try await service.restart() }
        for _ in 0..<100 {
            if service.state == .stopping { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(service.state, .stopping)
        await service.stop()
        do {
            try await restarting.value
            XCTFail("Interrupted restart should be cancelled")
        } catch is CancellationError {}
        catch { XCTFail("Expected CancellationError, got \(error)") }
        XCTAssertEqual(service.state, .idle)
        XCTAssertTrue(PortProbe.isAvailable(port: configuration.port))
    }

    // MARK: - Cloudflare Quick Tunnel

    private func waitUntil(timeout: TimeInterval = 5, _ condition: @MainActor () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return condition()
    }

    private func healthyTunnelResponder(_ instanceFile: URL) -> (URLRequest) -> (Int, Data) {
        { _ in
            let instance = (try? String(contentsOf: instanceFile, encoding: .utf8))?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let body = "{\"ok\":true,\"service\":\"pi-remote-claude\",\"instanceId\":\"\(instance)\"}"
            return (200, Data(body.utf8))
        }
    }

    func testCloudTunnelPublishesOnlyVerifiedPublicURL() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let instanceFile = directory.appendingPathComponent("instance.txt")
        let cloudflared = try fakeCloudflared(in: directory, printedURL: "https://calm-test-9999.trycloudflare.com")
        let runtime = try fixture(directory, cloudflared: cloudflared, instanceFile: instanceFile)
        ClaudeTunnelURLProtocol.respond = healthyTunnelResponder(instanceFile)
        let service = cloudController(directory, runtime: runtime, session: mockTunnelSession())
        let configuration = cloudConfig(directory, port: try unusedPort())

        try await service.start(configuration: configuration)
        XCTAssertEqual(service.state, .running)
        XCTAssertEqual(service.publicURL?.absoluteString, "https://calm-test-9999.trycloudflare.com")

        let pair = try await service.readPairInfo()
        XCTAssertEqual(pair.bases, ["https://calm-test-9999.trycloudflare.com"])
        XCTAssertEqual(pair.token.count, 64)
        XCTAssertFalse(service.logs.joined().contains(pair.token))

        let stored = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("claude-config.json"))) as? [String: Any]
        XCTAssertEqual(stored?["mode"] as? String, "cloudflare")
        XCTAssertNil(stored?["token"])
        XCTAssertNil(stored?["publicURL"])

        let emptyConfig = directory.appendingPathComponent("data/cloudflared-empty.yml")
        XCTAssertTrue(FileManager.default.fileExists(atPath: emptyConfig.path))
        XCTAssertEqual(try Data(contentsOf: emptyConfig).count, 0)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: emptyConfig.path)[.posixPermissions] as? Int, 0o600)

        await service.stop()
        XCTAssertEqual(service.state, .idle)
        XCTAssertNil(service.publicURL)
        XCTAssertTrue(PortProbe.isAvailable(port: configuration.port))
    }

    func testCloudTunnelIgnoresInvalidOrLookalikePublicURLs() async throws {
        for printed in [
            "https://evil.example.com",
            "http://calm.trycloudflare.com",
            "https://user:pass@calm.trycloudflare.com",
            "https://trycloudflare.com",
            "https://x.trycloudflare.com.evil.example",
        ] {
            let directory = try temporaryDirectory()
            let instanceFile = directory.appendingPathComponent("instance.txt")
            let cloudflared = try fakeCloudflared(in: directory, printedURL: printed)
            let runtime = try fixture(directory, cloudflared: cloudflared, instanceFile: instanceFile)
            ClaudeTunnelURLProtocol.respond = { _ in (200, Data("{}".utf8)) }
            let service = cloudController(directory, runtime: runtime, session: mockTunnelSession(), urlTimeout: 1, healthTimeout: 1)
            let configuration = cloudConfig(directory, port: try unusedPort())
            do {
                try await service.start(configuration: configuration)
                XCTFail("\(printed) should not be accepted as a public address")
            } catch {}
            if case .failed = service.state {} else { XCTFail("Expected failed state for \(printed)") }
            XCTAssertNil(service.publicURL)
            XCTAssertTrue(PortProbe.isAvailable(port: configuration.port))
            await service.stop()
            try? FileManager.default.removeItem(at: directory)
        }
    }

    func testCloudPublicHealthRejectsWrongIdentityAndUnauthorized() async throws {
        for mode in ["identity", "unauthorized"] {
            let directory = try temporaryDirectory()
            let instanceFile = directory.appendingPathComponent("instance.txt")
            let cloudflared = try fakeCloudflared(in: directory, printedURL: "https://calm-\(mode)-1234.trycloudflare.com")
            let runtime = try fixture(directory, cloudflared: cloudflared, instanceFile: instanceFile)
            if mode == "identity" {
                ClaudeTunnelURLProtocol.respond = { _ in
                    (200, Data("{\"ok\":true,\"service\":\"pi-remote-claude\",\"instanceId\":\"\(UUID().uuidString)\"}".utf8))
                }
            } else {
                ClaudeTunnelURLProtocol.respond = { _ in (401, Data("{}".utf8)) }
            }
            let service = cloudController(directory, runtime: runtime, session: mockTunnelSession())
            let configuration = cloudConfig(directory, port: try unusedPort())
            let started = Date()
            do {
                try await service.start(configuration: configuration)
                XCTFail("\(mode) must not be treated as healthy")
            } catch let error as ValidationError {
                XCTAssertTrue(error.message.contains(mode == "identity" ? "身份" : "401"), error.message)
            }
            XCTAssertLessThan(Date().timeIntervalSince(started), 8, "\(mode) should fail immediately, not after the health budget")
            XCTAssertNil(service.publicURL)
            XCTAssertTrue(PortProbe.isAvailable(port: configuration.port))
            await service.stop()
            try? FileManager.default.removeItem(at: directory)
        }
    }

    func testCloudPublicHealthRetriesTransientGatewayErrors() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let instanceFile = directory.appendingPathComponent("instance.txt")
        let cloudflared = try fakeCloudflared(in: directory, printedURL: "https://calm-retry-1234.trycloudflare.com")
        let runtime = try fixture(directory, cloudflared: cloudflared, instanceFile: instanceFile)
        let counter = AtomicCounter()
        let healthy = healthyTunnelResponder(instanceFile)
        ClaudeTunnelURLProtocol.respond = { request in
            if counter.next() <= 2 { return (502, Data("{}".utf8)) }
            return healthy(request)
        }
        let service = cloudController(directory, runtime: runtime, session: mockTunnelSession(), urlTimeout: 5, healthTimeout: 10)
        let configuration = cloudConfig(directory, port: try unusedPort())
        try await service.start(configuration: configuration)
        XCTAssertEqual(service.state, .running)
        XCTAssertEqual(service.publicURL?.absoluteString, "https://calm-retry-1234.trycloudflare.com")
        XCTAssertGreaterThanOrEqual(counter.value, 3)
        await service.stop()
    }

    func testCloudPublicHealthRejectsRedirect() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let instanceFile = directory.appendingPathComponent("instance.txt")
        let cloudflared = try fakeCloudflared(in: directory, printedURL: "https://calm-redirect-1234.trycloudflare.com")
        let runtime = try fixture(directory, cloudflared: cloudflared, instanceFile: instanceFile)
        ClaudeTunnelURLProtocol.respond = { _ in (302, Data()) }
        let service = cloudController(directory, runtime: runtime, session: mockTunnelSession())
        let configuration = cloudConfig(directory, port: try unusedPort())
        do {
            try await service.start(configuration: configuration)
            XCTFail("A redirecting public endpoint must not be accepted")
        } catch let error as ValidationError {
            XCTAssertTrue(error.message.contains("重定向"), error.message)
        }
        XCTAssertNil(service.publicURL)
        XCTAssertTrue(PortProbe.isAvailable(port: configuration.port))
        await service.stop()
    }

    func testRedirectRejectorRefusesToFollow() {
        let rejector = ClaudeRedirectRejector()
        let task = URLSession.shared.dataTask(with: URL(string: "https://calm.trycloudflare.com")!)
        defer { task.cancel() }
        let original = task.originalRequest!
        let response = HTTPURLResponse(url: original.url!, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: ["Location": "https://evil.example.com"])!
        var followed: URLRequest? = original
        rejector.urlSession(
            URLSession.shared,
            task: task,
            willPerformHTTPRedirection: response,
            newRequest: URLRequest(url: URL(string: "https://evil.example.com")!)
        ) { followed = $0 }
        XCTAssertNil(followed)
    }

    func testTunnelEnvironmentUsesStrictAllowlist() {
        let base: [String: String] = [
            "PATH": "/usr/bin",
            "HOME": "/Users/tester",
            "USER": "tester",
            "TMPDIR": "/tmp/xyz",
            "LANG": "en_US.UTF-8",
            "LC_ALL": "en_US.UTF-8",
            "HTTP_PROXY": "http://proxy:8080",
            "https_proxy": "http://proxy:8080",
            "NO_PROXY": "localhost",
            "BRIDGE_TOKEN": "bridge-secret",
            "RELAY_TOKEN": "relay-secret",
            "AGENT_TOKEN": "agent-secret",
            "ANTHROPIC_API_KEY": "sk-ant",
            "CLAUDE_CODE_OAUTH_TOKEN": "oauth",
            "TUNNEL_TOKEN": "cf-token",
            "CF_API_TOKEN": "cf-api",
            "PI_RUNTIME": "omp",
            "NODE_OPTIONS": "--import evil.js",
            "BARK_URL": "https://notification.example",
        ]
        let env = ClaudeServiceController.tunnelEnvironment(from: base, nodeDirectory: "/runtime/bin")
        XCTAssertEqual(env["PATH"]?.split(separator: ":").first.map(String.init), "/runtime/bin")
        XCTAssertEqual(env["HOME"], "/Users/tester")
        XCTAssertEqual(env["USER"], "tester")
        XCTAssertEqual(env["TMPDIR"], "/tmp/xyz")
        XCTAssertEqual(env["LANG"], "en_US.UTF-8")
        XCTAssertEqual(env["LC_ALL"], "en_US.UTF-8")
        XCTAssertEqual(env["HTTP_PROXY"], "http://proxy:8080")
        XCTAssertEqual(env["https_proxy"], "http://proxy:8080")
        XCTAssertEqual(env["NO_PROXY"], "localhost")
        for key in ["BRIDGE_TOKEN", "RELAY_TOKEN", "AGENT_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "TUNNEL_TOKEN", "CF_API_TOKEN", "PI_RUNTIME", "NODE_OPTIONS", "BARK_URL"] {
            XCTAssertNil(env[key], key)
        }
    }

    func testCloudTunnelChildEnvironmentCarriesNoSecrets() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let instanceFile = directory.appendingPathComponent("instance.txt")
        let envDump = directory.appendingPathComponent("cloudflared-env.txt")
        let cloudflared = try fakeCloudflared(in: directory, printedURL: "https://calm-env-1111.trycloudflare.com", envDump: envDump)
        let runtime = try fixture(directory, cloudflared: cloudflared, instanceFile: instanceFile)
        ClaudeTunnelURLProtocol.respond = healthyTunnelResponder(instanceFile)
        let service = cloudController(directory, runtime: runtime, session: mockTunnelSession())
        let configuration = cloudConfig(directory, port: try unusedPort())
        try await service.start(configuration: configuration)
        XCTAssertEqual(service.state, .running)
        let env = try String(contentsOf: envDump, encoding: .utf8)
        for key in ["BRIDGE_TOKEN", "RELAY_TOKEN", "AGENT_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "TUNNEL_TOKEN", "NODE_OPTIONS", "PI_RUNTIME"] {
            XCTAssertFalse(env.contains("\(key)="), key)
        }
        XCTAssertTrue(env.contains("PATH="))
        await service.stop()
    }

    func testCloudRestartAndStopClearTunnelAndPublicURL() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let instanceFile = directory.appendingPathComponent("instance.txt")
        let cloudflared = try fakeCloudflared(in: directory, printedURL: "https://calm-restart-1234.trycloudflare.com")
        let runtime = try fixture(directory, cloudflared: cloudflared, instanceFile: instanceFile)
        ClaudeTunnelURLProtocol.respond = healthyTunnelResponder(instanceFile)
        let service = cloudController(directory, runtime: runtime, session: mockTunnelSession())
        let configuration = cloudConfig(directory, port: try unusedPort())
        try await service.start(configuration: configuration)
        XCTAssertEqual(service.state, .running)
        XCTAssertNotNil(service.publicURL)

        try await service.restart()
        XCTAssertEqual(service.state, .running)
        XCTAssertEqual(service.publicURL?.absoluteString, "https://calm-restart-1234.trycloudflare.com")

        await service.stop()
        XCTAssertEqual(service.state, .idle)
        XCTAssertNil(service.publicURL)
        XCTAssertTrue(PortProbe.isAvailable(port: configuration.port))
    }

    func testCancelDuringCloudStartupClearsBothChildren() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let instanceFile = directory.appendingPathComponent("instance.txt")
        let cloudflared = try fakeCloudflared(in: directory, printedURL: "https://evil.example.com")
        let runtime = try fixture(directory, cloudflared: cloudflared, instanceFile: instanceFile)
        ClaudeTunnelURLProtocol.respond = { _ in (200, Data("{}".utf8)) }
        let service = cloudController(directory, runtime: runtime, session: mockTunnelSession(), urlTimeout: 30, healthTimeout: 30)
        let configuration = cloudConfig(directory, port: try unusedPort())
        let starting = Task { try await service.start(configuration: configuration) }
        let launched = await waitUntil { service.logs.contains { $0.contains("Quick Tunnel") } }
        XCTAssertTrue(launched)
        await service.stop()
        do {
            try await starting.value
            XCTFail("Interrupted cloud startup should be cancelled")
        } catch is CancellationError {}
        catch { XCTFail("Expected CancellationError, got \(error)") }
        XCTAssertEqual(service.state, .idle)
        XCTAssertNil(service.publicURL)
        XCTAssertTrue(PortProbe.isAvailable(port: configuration.port))
    }

    func testTunnelExitStopsOwnDaemonOnly() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let instanceFile = directory.appendingPathComponent("instance.txt")
        let cloudflared = try fakeCloudflared(in: directory, printedURL: "https://calm-exit-1234.trycloudflare.com")
        let runtime = try fixture(directory, cloudflared: cloudflared, instanceFile: instanceFile)
        ClaudeTunnelURLProtocol.respond = healthyTunnelResponder(instanceFile)
        let service = cloudController(directory, runtime: runtime, session: mockTunnelSession())
        let configuration = cloudConfig(directory, port: try unusedPort())
        try await service.start(configuration: configuration)
        XCTAssertEqual(service.state, .running)

        // Ask the fake cloudflared to exit; the controller must tear down its own daemon with it.
        try Data().write(to: directory.appendingPathComponent("cloudflared-kill"))
        let failed = await waitUntil(timeout: 6) {
            if case .failed = service.state { return true }
            return false
        }
        XCTAssertTrue(failed, "tunnel exit should fail the service")
        XCTAssertNil(service.publicURL)
        XCTAssertTrue(PortProbe.isAvailable(port: configuration.port))
        do {
            _ = try await URLSession.shared.data(from: configuration.baseURL.appendingPathComponent("api/health"))
            XCTFail("Claude daemon should have been stopped")
        } catch {}
    }

    func testCloudModeWithoutExecutableCloudflaredStartsNothing() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let runtime = try fixture(directory)
        XCTAssertNil(runtime.cloudflared)
        let service = cloudController(directory, runtime: runtime, session: mockTunnelSession())
        let configuration = cloudConfig(directory, port: try unusedPort())
        do {
            try await service.start(configuration: configuration)
            XCTFail("Cloudflare mode without cloudflared must be rejected")
        } catch let error as ValidationError {
            XCTAssertTrue(error.message.contains("cloudflared"), error.message)
        }
        XCTAssertEqual(service.state, .failed("应用内缺少可执行的 cloudflared，无法为 Claude 服务建立隧道"))
        XCTAssertNil(service.publicURL)
        XCTAssertTrue(PortProbe.isAvailable(port: configuration.port))
    }
}

/// Lets the public-health tests return a transient error before a healthy response.
final class AtomicCounter {
    private let lock = NSLock()
    private var count = 0

    var value: Int {
        lock.lock(); defer { lock.unlock() }
        return count
    }

    func next() -> Int {
        lock.lock(); defer { lock.unlock() }
        count += 1
        return count
    }
}

/// Intercepts only `*.trycloudflare.com` so loopback daemon traffic still uses the real network.
final class ClaudeTunnelURLProtocol: URLProtocol {
    static var respond: ((URLRequest) -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(".trycloudflare.com") == true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let respond = ClaudeTunnelURLProtocol.respond else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let (status, data) = respond(request)
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
