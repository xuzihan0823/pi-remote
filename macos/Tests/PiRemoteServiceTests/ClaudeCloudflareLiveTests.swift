import Darwin
import Foundation
import XCTest
import PiRemoteCore
@testable import PiRemote

@MainActor
final class ClaudeCloudflareLiveTests: XCTestCase {
    func testLiveClaudeTunnel() async throws {
        guard ProcessInfo.processInfo.environment["PI_REMOTE_LIVE_CLAUDE_CLOUDFLARE"] == "1" else {
            throw XCTSkip("Set PI_REMOTE_LIVE_CLAUDE_CLOUDFLARE=1 for the network smoke test")
        }
        let node = URL(fileURLWithPath: "/usr/local/bin/node")
        let cloudflared = URL(fileURLWithPath: "/opt/homebrew/bin/cloudflared")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.isExecutableFile(atPath: cloudflared.path) else {
            throw ValidationError("Live smoke test requires Node and cloudflared")
        }
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("claude-cloudflare-live-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let runtime = temporary.appendingPathComponent("runtime")
        let pack = Process()
        pack.executableURL = node
        pack.arguments = [root.appendingPathComponent("backend/claude/scripts/package-runtime.mjs").path, runtime.appendingPathComponent("claude").path]
        pack.standardOutput = FileHandle.nullDevice
        pack.standardError = FileHandle.nullDevice
        try pack.run()
        pack.waitUntilExit()
        guard pack.terminationStatus == 0 else { throw ValidationError("Could not package live test runtime") }
        let projects = temporary.appendingPathComponent("projects")
        try FileManager.default.createDirectory(at: projects, withIntermediateDirectories: true)
        let paths = ClaudeRuntimePaths(runtimeDirectory: runtime, node: node, supervisor: root.appendingPathComponent("macos/runtime-supervisor.mjs"), cloudflared: cloudflared)
        let service = ClaudeServiceController(
            store: ClaudeConfigStore(file: temporary.appendingPathComponent("config.json")),
            runtimeProvider: { paths },
            tokenProvider: { throw ValidationError("Cloudflare must not access the persistent token provider") }
        )
        let port = try unusedPort()
        let configuration = ClaudeServiceConfiguration(port: port, executablePath: "/usr/bin/true", projectsDirectory: projects.path, dataDirectory: temporary.appendingPathComponent("state").path, mode: .cloudflare)
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        do {
            try await service.start(configuration: configuration)
            XCTAssertEqual(service.state, .running)
            let publicURL = try XCTUnwrap(service.publicURL)
            XCTAssertEqual(publicURL.scheme, "https")
            XCTAssertTrue(publicURL.host?.hasSuffix(".trycloudflare.com") == true)
            let pair = try await service.readPairInfo()
            XCTAssertEqual(pair.bases, [publicURL.absoluteString])
            XCTAssertGreaterThanOrEqual(pair.token.count, 32)
            XCTAssertFalse(service.logs.joined().contains(pair.token))

            var healthRequest = URLRequest(url: publicURL.appendingPathComponent("api/health"))
            healthRequest.timeoutInterval = 15
            healthRequest.setValue("Bearer \(pair.token)", forHTTPHeaderField: "Authorization")
            let (healthData, healthResponse) = try await session.data(for: healthRequest)
            XCTAssertEqual((healthResponse as? HTTPURLResponse)?.statusCode, 200)
            let health = try JSONDecoder().decode(ClaudeServiceHealth.self, from: healthData)
            XCTAssertEqual(health.service, "pi-remote-claude")
            XCTAssertTrue(health.ok)
            XCTAssertNotNil(UUID(uuidString: health.instanceId))
            healthRequest.setValue("Bearer \(String(repeating: "x", count: 64))", forHTTPHeaderField: "Authorization")
            let (_, unauthorized) = try await session.data(for: healthRequest)
            XCTAssertEqual((unauthorized as? HTTPURLResponse)?.statusCode, 401)

            let (_, pairResponse) = try await session.data(from: publicURL.appendingPathComponent("api/pair-info"))
            XCTAssertEqual((pairResponse as? HTTPURLResponse)?.statusCode, 403)
            let (_, qrResponse) = try await session.data(from: publicURL.appendingPathComponent("api/pair-qr.svg"))
            XCTAssertEqual((qrResponse as? HTTPURLResponse)?.statusCode, 403)

            var uploadURL = URLComponents(url: publicURL.appendingPathComponent("api/upload"), resolvingAgainstBaseURL: false)!
            uploadURL.queryItems = [URLQueryItem(name: "filename", value: "cloudflare-smoke.txt")]
            var upload = URLRequest(url: try XCTUnwrap(uploadURL.url))
            upload.httpMethod = "POST"
            upload.timeoutInterval = 15
            upload.setValue("Bearer \(pair.token)", forHTTPHeaderField: "Authorization")
            upload.httpBody = Data("dummy smoke attachment".utf8)
            let (_, uploadResponse) = try await session.data(for: upload)
            XCTAssertEqual((uploadResponse as? HTTPURLResponse)?.statusCode, 200)

            var socketURL = URLComponents(url: publicURL, resolvingAgainstBaseURL: false)!
            socketURL.scheme = "wss"
            socketURL.path = "/ws"
            socketURL.queryItems = [URLQueryItem(name: "token", value: pair.token)]
            let socket = session.webSocketTask(with: try XCTUnwrap(socketURL.url))
            socket.resume()
            do {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    socket.sendPing { error in
                        if error != nil { continuation.resume(throwing: ValidationError("Cloudflare WebSocket ping failed")) }
                        else { continuation.resume() }
                    }
                }
            } catch {
                socket.cancel(with: .goingAway, reason: nil)
                throw error
            }
            socket.cancel(with: .normalClosure, reason: nil)
            await service.stop()
            XCTAssertEqual(service.state, .idle)
            XCTAssertNil(service.publicURL)
            XCTAssertTrue(PortProbe.isAvailable(port: port))
        } catch {
            await service.stop()
            throw error
        }
    }

    private func unusedPort() throws -> Int {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw ValidationError("socket failed") }
        defer { close(descriptor) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard result == 0 else { throw ValidationError("bind failed") }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        guard withUnsafeMutablePointer(to: &address, { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(descriptor, $0, &length) }
        }) == 0 else { throw ValidationError("getsockname failed") }
        return Int(UInt16(bigEndian: address.sin_port))
    }
}
