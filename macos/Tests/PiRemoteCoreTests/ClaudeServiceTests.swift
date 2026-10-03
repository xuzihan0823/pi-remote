import Foundation
import XCTest
@testable import PiRemoteCore

final class ClaudeServiceTests: XCTestCase {
    func testConfigurationIsSeparateAndContainsNoToken() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let piFile = directory.appendingPathComponent("config.json")
        let original = Data("existing Pi configuration".utf8)
        try original.write(to: piFile)
        let store = ClaudeConfigStore(file: directory.appendingPathComponent("claude-config.json"))
        let config = ClaudeServiceConfiguration(port: 23456, executablePath: "/usr/local/bin/claude", projectsDirectory: "/tmp/claude-projects", dataDirectory: "/tmp/claude-data")
        try store.save(config)
        XCTAssertEqual(try store.load(), config)
        XCTAssertEqual(try Data(contentsOf: piFile), original)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: store.file)) as? [String: Any])
        XCTAssertNil(json["token"])
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: store.file.path)[.posixPermissions] as? Int, 0o600)
    }

    func testInvalidConfigurationIsRejected() {
        for port in [0, -1, 65536] {
            XCTAssertThrowsError(try ClaudeServiceConfiguration(port: port).validated())
        }
        XCTAssertThrowsError(try ClaudeServiceConfiguration(executablePath: "claude").validated())
        XCTAssertThrowsError(try ClaudeServiceConfiguration(dataDirectory: "relative").validated())
    }

    func testJobKeepsServicesAndSecretsIsolated() throws {
        let token = String(repeating: "a", count: 64)
        let instance = UUID().uuidString
        let job = try JobBuilder.claudeJob(
            nodePath: "/app/runtime/node", runtimeDirectory: "/app/runtime",
            configuration: ClaudeServiceConfiguration(projectsDirectory: "/sessions", dataDirectory: "/state/Claude"),
            token: token, instanceId: instance,
            baseEnvironment: ["RELAY_TOKEN": "pi-secret", "AGENT_TOKEN": "agent-secret", "PI_RUNTIME": "omp", "BRIDGE_TOKEN": "old-secret", "BRIDGE_PUBLIC_BASES": "https://old.example", "UPLOADS_DIR": "/old/uploads", "INTERACTIONS_DB_PATH": "/old/db", "NODE_OPTIONS": "--import evil.js", "BARK_URL": "https://notification.example", "CLAUDE_CONFIG_DIR": "/user/claude", "PATH": "/user/bin"]
        )
        XCTAssertEqual(job.command, "/app/runtime/node")
        XCTAssertEqual(job.args, ["/app/runtime/claude/src/index.ts"])
        XCTAssertEqual(job.cwd, "/state/Claude")
        XCTAssertEqual(job.tag, "claude")
        XCTAssertEqual(job.env["BRIDGE_TOKEN"], token)
        XCTAssertEqual(job.env["BRIDGE_INSTANCE_ID"], instance)
        XCTAssertEqual(job.env["BRIDGE_HOST"], "127.0.0.1")
        XCTAssertEqual(job.env["BRIDGE_PORT"], "8788")
        XCTAssertEqual(job.env["INTERACTIONS_DB_PATH"], "/state/Claude/interactions.sqlite")
        XCTAssertEqual(job.env["UPLOADS_DIR"], "/state/Claude/uploads")
        XCTAssertEqual(job.env["CLAUDE_CONFIG_DIR"], "/user/claude")
        for key in ["RELAY_TOKEN", "AGENT_TOKEN", "PI_RUNTIME", "BRIDGE_PUBLIC_BASES", "NODE_OPTIONS", "BARK_URL"] { XCTAssertNil(job.env[key], key) }
        XCTAssertFalse(job.args.joined().contains(token))
        XCTAssertGreaterThanOrEqual(job.killGraceMs, 5_000)
    }

    func testJobRejectsInvalidTokenAndInstance() {
        XCTAssertThrowsError(try JobBuilder.claudeJob(nodePath: "/node", runtimeDirectory: "/runtime", configuration: ClaudeServiceConfiguration(), token: "short", instanceId: UUID().uuidString, baseEnvironment: [:]))
        XCTAssertThrowsError(try JobBuilder.claudeJob(nodePath: "/node", runtimeDirectory: "/runtime", configuration: ClaudeServiceConfiguration(), token: String(repeating: "a", count: 64), instanceId: "wrong", baseEnvironment: [:]))
    }

    func testHealthMustMatchServiceAndInstance() throws {
        let expected = UUID().uuidString
        func health(_ service: String, _ instance: String, _ ok: Bool = true) throws -> ClaudeServiceHealth {
            let data = try JSONSerialization.data(withJSONObject: ["ok": ok, "service": service, "instanceId": instance])
            return try JSONDecoder().decode(ClaudeServiceHealth.self, from: data)
        }
        XCTAssertTrue(try health("pi-remote-claude", expected).matches(instanceId: expected))
        XCTAssertFalse(try health("other", expected).matches(instanceId: expected))
        XCTAssertFalse(try health("pi-remote-claude", UUID().uuidString).matches(instanceId: expected))
        XCTAssertFalse(try health("pi-remote-claude", expected, false).matches(instanceId: expected))
        XCTAssertThrowsError(try JSONDecoder().decode(ClaudeServiceHealth.self, from: Data("{\"ok\":true}".utf8)))
    }
}
