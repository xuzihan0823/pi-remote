import XCTest
@testable import PiRemoteCore

final class SupervisorJobTests: XCTestCase {
    private let baseEnvironment = ["PATH": "/usr/bin:/bin", "HOME": "/Users/tester"]
    private let token = String(repeating: "t", count: 32)

    func testAgentJobCarriesAgentConfiguration() throws {
        let job = JobBuilder.agentJob(
            nodePath: "/App/Contents/Resources/runtime/node",
            runtimeDirectory: "/App/Contents/Resources/runtime",
            agentURL: "wss://pi.anyyu.cyou/ws/agent",
            token: token,
            deviceId: "pi-mac-1234abcd",
            workspacePath: "/Users/tester/Desktop",
            piBinPath: "/usr/local/bin/pi",
            baseEnvironment: baseEnvironment
        )
        XCTAssertEqual(job.command, "/App/Contents/Resources/runtime/node")
        XCTAssertEqual(job.args, ["src/agent/run.ts"])
        XCTAssertEqual(job.cwd, "/App/Contents/Resources/runtime")
        XCTAssertEqual(job.env["RELAY_URL"], "wss://pi.anyyu.cyou/ws/agent")
        XCTAssertEqual(job.env["RELAY_TOKEN"], token)
        XCTAssertEqual(job.env["AGENT_TOKEN"], token)
        XCTAssertEqual(job.env["AGENT_DEVICE_ID"], "pi-mac-1234abcd")
        XCTAssertEqual(job.env["PI_WORKSPACE_ROOT"], "/Users/tester/Desktop")
        XCTAssertEqual(job.env["PI_BIN"], "/usr/local/bin/pi")
        XCTAssertEqual(job.env["HOME"], "/Users/tester")
        XCTAssertGreaterThanOrEqual(job.killGraceMs, 3000)
    }

    func testAgentJobPassesSelectedRuntime() {
        let job = JobBuilder.agentJob(
            nodePath: "/runtime/node",
            runtimeDirectory: "/runtime",
            agentURL: "wss://pi.anyyu.cyou/ws/agent",
            token: token,
            deviceId: "pi-mac-1234abcd",
            workspacePath: "/Users/tester/Desktop",
            piBinPath: "/Users/tester/.local/bin/omp",
            runtime: .omp,
            baseEnvironment: ["PI_RUNTIME": "pi"]
        )
        XCTAssertEqual(job.env["PI_RUNTIME"], "omp")
        XCTAssertEqual(job.env["PI_BIN"], "/Users/tester/.local/bin/omp")
    }

    func testRelayJobBindsLoopback() {
        let job = JobBuilder.relayJob(
            nodePath: "/runtime/node",
            runtimeDirectory: "/runtime",
            port: 8789,
            token: token,
            workspacePath: "/Users/tester/Desktop",
            piBinPath: "/usr/local/bin/pi",
            baseEnvironment: baseEnvironment
        )
        XCTAssertEqual(job.env["RELAY_HOST"], "127.0.0.1")
        XCTAssertEqual(job.env["RELAY_PORT"], "8789")
        XCTAssertEqual(job.env["RELAY_TOKEN"], token)
        XCTAssertEqual(job.args, ["src/index.ts"])
    }

    func testTunnelJobUsesEmptyConfigAndQuickTunnelFlags() {
        let job = JobBuilder.tunnelJob(
            cloudflaredPath: "/runtime/cloudflared",
            runtimeDirectory: "/runtime",
            port: 8789,
            emptyConfigPath: "/support/cloudflared-empty.yml",
            baseEnvironment: baseEnvironment
        )
        XCTAssertEqual(job.command, "/runtime/cloudflared")
        XCTAssertEqual(job.args, [
            "--no-autoupdate",
            "tunnel",
            "--config", "/support/cloudflared-empty.yml",
            "--url", "http://127.0.0.1:8789",
        ])
    }

    func testPathPrefersBundledNodeAndKeepsOriginalEntries() {
        let path = RuntimeEnvironment.path(bundledNodeDirectory: "/runtime/node-bin", original: "/opt/custom/bin:/usr/bin")
        let components = path.split(separator: ":").map(String.init)
        XCTAssertEqual(components.first, "/runtime/node-bin")
        XCTAssertTrue(components.contains("/usr/local/bin"))
        XCTAssertTrue(components.contains("/opt/homebrew/bin"))
        XCTAssertTrue(components.contains("/usr/bin"))
        XCTAssertTrue(components.contains("/bin"))
        XCTAssertTrue(components.contains("/opt/custom/bin"))
        XCTAssertEqual(components.filter { $0 == "/usr/bin" }.count, 1)
    }

    func testEncodedLineIsSingleJSONLine() throws {
        let job = JobBuilder.tunnelJob(
            cloudflaredPath: "/runtime/cloudflared",
            runtimeDirectory: "/runtime",
            port: 8789,
            emptyConfigPath: "/support/empty.yml",
            baseEnvironment: baseEnvironment
        )
        let data = try job.encodedLine()
        XCTAssertEqual(data.last, 0x0A)
        XCTAssertEqual(data.filter { $0 == 0x0A }.count, 1)
        let decoded = try JSONDecoder().decode(SupervisorJob.self, from: data.dropLast())
        XCTAssertEqual(decoded, job)
    }

    func testTunnelLogParserExtractsPublicURL() throws {
        let line = "2026-09-18T10:00:00Z INF |  https://calm-river-1234.trycloudflare.com  |"
        let publicURL = try XCTUnwrap(TunnelLogParser.publicURL(in: line))
        XCTAssertEqual(publicURL.absoluteString, "https://calm-river-1234.trycloudflare.com")
        let agentURL = try XCTUnwrap(TunnelLogParser.agentURL(fromPublicURL: publicURL))
        XCTAssertEqual(agentURL.absoluteString, "wss://calm-river-1234.trycloudflare.com/ws/agent")
        XCTAssertNil(TunnelLogParser.publicURL(in: "INF Requesting new quick Tunnel"))
    }
}
