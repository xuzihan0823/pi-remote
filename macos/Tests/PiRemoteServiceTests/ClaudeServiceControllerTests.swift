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

    private func fixture(_ directory: URL, healthMode: String = "valid") throws -> ClaudeRuntimePaths {
        let node = URL(fileURLWithPath: "/usr/local/bin/node")
        guard FileManager.default.isExecutableFile(atPath: node.path) else { throw XCTSkip("Node runtime is not installed") }
        let source = directory.appendingPathComponent("runtime/claude/src")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        let script = """
        import http from 'node:http';
        const server = http.createServer((req, res) => {
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
        return ClaudeRuntimePaths(runtimeDirectory: directory.appendingPathComponent("runtime"), node: node, supervisor: macos.appendingPathComponent("runtime-supervisor.mjs"))
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
}
