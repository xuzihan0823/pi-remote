import XCTest
@testable import PiRemoteCore

final class ConfigStoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("pi-remote-config-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testRoundTrip() throws {
        let store = ConfigStore(directory: directory)
        XCTAssertNil(store.load())

        let config = AppConfig(
            mode: .cloudflare,
            serverURL: AppConfig.defaultServerURL,
            workspacePath: "/Users/tester/Desktop",
            piBinPath: "/usr/local/bin/pi",
            deviceId: "pi-mac-deadbeef"
        )
        try store.save(config)
        XCTAssertEqual(store.load(), config)
    }

    func testLegacyConfigWithoutNewFieldsStillLoads() throws {
        let store = ConfigStore(directory: directory)
        let legacy = #"{"deviceId":"pi-mac-deadbeef","mode":"server","piBinPath":"/usr/local/bin/pi","serverURL":"wss://pi.anyyu.cyou/ws/agent","workspacePath":"/Users/tester/Desktop"}"#
        try Data(legacy.utf8).write(to: store.fileURL)
        let loaded = try XCTUnwrap(store.load())
        XCTAssertEqual(loaded.deviceId, "pi-mac-deadbeef")
        XCTAssertEqual(loaded.runtime, .pi)
        XCTAssertEqual(loaded.serverSource, .existing)
        XCTAssertEqual(loaded.deployTarget, RemoteDeployTarget())
    }

    func testNewFieldsRoundTrip() throws {
        let store = ConfigStore(directory: directory)
        var config = AppConfig.makeDefault(deviceId: "pi-mac-deadbeef")
        config.runtime = .omp
        config.serverSource = .deploy
        config.deployTarget = RemoteDeployTarget(host: "203.0.113.7", port: 2222, user: "ubuntu", identityFile: "/Users/tester/.ssh/id_ed25519", domain: "")
        try store.save(config)
        XCTAssertEqual(store.load(), config)
    }

    func testRuntimeSwitchOnlyReplacesDefaultBinaries() {
        let piDefault = AgentRuntime.pi.defaultBinaryPath
        let ompDefault = AgentRuntime.omp.defaultBinaryPath
        XCTAssertEqual(AgentRuntime.binaryPath(afterSwitchingTo: .omp, current: piDefault), ompDefault)
        XCTAssertEqual(AgentRuntime.binaryPath(afterSwitchingTo: .pi, current: ompDefault), piDefault)
        XCTAssertEqual(AgentRuntime.binaryPath(afterSwitchingTo: .omp, current: "pi"), ompDefault)
        XCTAssertEqual(AgentRuntime.binaryPath(afterSwitchingTo: .omp, current: ""), ompDefault)
        XCTAssertEqual(AgentRuntime.binaryPath(afterSwitchingTo: .omp, current: "/opt/custom/pi"), "/opt/custom/pi")
    }

    func testConfigFileIsOwnerOnly() throws {
        let store = ConfigStore(directory: directory)
        try store.save(AppConfig.makeDefault(deviceId: "pi-mac-deadbeef"))
        let attributes = try FileManager.default.attributesOfItem(atPath: store.fileURL.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }

    func testServerModeValidationRequiresAgentEndpoint() throws {
        var config = AppConfig.makeDefault(deviceId: "pi-mac-deadbeef")
        XCTAssertNoThrow(try config.validated())

        config.serverURL = "wss://pi.anyyu.cyou/ws/ios"
        XCTAssertThrowsError(try config.validated())

        config.serverURL = "wss://pi.anyyu.cyou/ws/agent?token=abc"
        XCTAssertThrowsError(try config.validated())
    }

    func testCloudflareModeSkipsServerURLValidation() throws {
        let config = AppConfig(
            mode: .cloudflare,
            serverURL: "",
            workspacePath: "/Users/tester/Desktop",
            piBinPath: "/usr/local/bin/pi",
            deviceId: "pi-mac-deadbeef"
        )
        XCTAssertNoThrow(try config.validated())
    }

    func testWorkspaceValidation() {
        var config = AppConfig.makeDefault(deviceId: "pi-mac-deadbeef")
        config.workspacePath = "relative/path"
        XCTAssertThrowsError(try config.validated())

        config.workspacePath = "/"
        XCTAssertThrowsError(try config.validated())

        config.workspacePath = "/Users/tester/Desktop"
        XCTAssertNoThrow(try config.validated())
    }

    func testGeneratedDeviceIdMatchesRelayPattern() {
        let deviceId = DeviceIdentity.makeDeviceId()
        XCTAssertTrue(DeviceIdentity.isValid(deviceId))
        XCTAssertTrue(deviceId.hasPrefix("pi-mac-"))
        XCTAssertFalse(DeviceIdentity.isValid(""))
        XCTAssertFalse(DeviceIdentity.isValid("-leading-dash"))
        XCTAssertFalse(DeviceIdentity.isValid("has space"))
    }

    func testGeneratedTokenIsLongEnoughAndHex() throws {
        let token = try XCTUnwrap(TokenGenerator.randomHex(byteCount: 32))
        XCTAssertEqual(token.count, 64)
        XCTAssertNoThrow(try EndpointValidator.validateToken(token))
        XCTAssertNotEqual(token, try XCTUnwrap(TokenGenerator.randomHex(byteCount: 32)))
    }
}
