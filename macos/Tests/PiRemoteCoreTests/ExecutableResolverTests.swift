import XCTest
@testable import PiRemoteCore

final class ExecutableResolverTests: XCTestCase {
    func testResolvesBareCommandNameFromSearchPath() throws {
        let resolved = try XCTUnwrap(ExecutableResolver.resolve("sh", searchPath: "/usr/bin:/bin"))
        XCTAssertEqual((resolved as NSString).lastPathComponent, "sh")
        XCTAssertTrue(resolved.hasPrefix("/"))
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: resolved))
    }

    func testResolvesBareCommandNameIgnoringMissingEntries() {
        XCTAssertNil(ExecutableResolver.resolve("definitely-not-a-real-command-xyz", searchPath: "/usr/bin:/bin"))
    }

    func testKeepsAbsoluteExecutablePath() {
        XCTAssertEqual(ExecutableResolver.resolve("/bin/sh", searchPath: "/usr/bin"), "/bin/sh")
    }

    func testRejectsAbsolutePathThatIsNotExecutable() {
        XCTAssertNil(ExecutableResolver.resolve("/etc/hosts", searchPath: "/usr/bin"))
    }

    func testRejectsEmptyValue() {
        XCTAssertNil(ExecutableResolver.resolve("   ", searchPath: "/usr/bin"))
    }

    func testAbsolutePathDetection() {
        XCTAssertTrue(ExecutableResolver.looksLikeAbsolutePath("/usr/local/bin/pi"))
        XCTAssertTrue(ExecutableResolver.looksLikeAbsolutePath("~/bin/pi"))
        XCTAssertFalse(ExecutableResolver.looksLikeAbsolutePath("pi"))
    }
}
