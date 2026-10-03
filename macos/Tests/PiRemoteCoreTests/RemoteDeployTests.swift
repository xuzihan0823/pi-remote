import XCTest
@testable import PiRemoteCore

final class RemoteDeployTests: XCTestCase {
    private let key = "/etc/hosts"

    func testTargetRejectsSSHArgumentInjection() throws {
        for host in ["-ProxyCommand=evil", "example.com -o ProxyCommand=evil", "root@example.com", "example.com:22", "a..b", "a-.b", "a/b"] {
            XCTAssertThrowsError(try RemoteDeployTarget(host: host, identityFile: key).validated(), host)
        }
        for user in ["-oProxyCommand=evil", "a b", "root;echo hacked", "root@other"] {
            XCTAssertThrowsError(try RemoteDeployTarget(host: "example.org", user: user, identityFile: key).validated(), user)
        }
        XCTAssertThrowsError(try RemoteDeployTarget(host: "example.org", port: 65536, identityFile: key).validated())
        XCTAssertThrowsError(try RemoteDeployTarget(host: "example.org", identityFile: key, domain: "domain.com;echo bad").validated())
        XCTAssertNoThrow(try RemoteDeployTarget(host: "example.org", identityFile: key).validated())
    }

    func testSSHArgumentsEnforceKnownHostAndBatchMode() throws {
        let target = try RemoteDeployTarget(host: "example.org", port: 2200, user: "deploy", identityFile: key).validated()
        let arguments = RemoteDeploySupport.sshArguments(for: target, knownHosts: URL(fileURLWithPath: "/tmp/app_known_hosts"), command: "id")
        XCTAssertEqual(arguments.suffix(2), ["deploy@example.org", "id"])
        XCTAssertTrue(arguments.contains("UserKnownHostsFile=/tmp/app_known_hosts"))
        XCTAssertTrue(arguments.contains("StrictHostKeyChecking=yes"))
        XCTAssertTrue(arguments.contains("BatchMode=yes"))
        XCTAssertTrue(arguments.contains("IdentitiesOnly=yes"))
        XCTAssertEqual(RemoteDeploySupport.shellQuote("a'b"), "'a'\\''b'")
    }

    func testSSLipDomainRejectsMalformedAddresses() {
        XCTAssertEqual(SSLipDomain.make(ipv4: "1.2.3.4"), "1-2-3-4.sslip.io")
        for invalid in ["1.2.3", "1.2.3.256", "1.2.03.4", "-1.2.3.4", "1.2.3.4.5", "1.2.3.4 "] {
            XCTAssertNil(SSLipDomain.make(ipv4: invalid), invalid)
        }
    }

    func testPreflightParsingHealthyUpgradeAndFailures() {
        let healthy = """
        os=Linux
        arch=aarch64
        distro=debian
        docker=ok
        compose=ok
        daemon=ok
        privilege=ok
        directory=ok
        port80=free
        port443=free
        """
        let fresh = RemoteDeploySupport.parsePreflight(healthy)
        XCTAssertTrue(fresh.passed, "\(fresh.issues)")
        XCTAssertFalse(fresh.isUpgrade)
        let upgrade = RemoteDeploySupport.parsePreflight(healthy.replacingOccurrences(of: "directory=ok", with: "directory=upgrade")
            .replacingOccurrences(of: "port80=free", with: "port80=owned"))
        XCTAssertTrue(upgrade.passed, "\(upgrade.issues)")
        XCTAssertTrue(upgrade.isUpgrade)
        let broken = RemoteDeploySupport.parsePreflight(healthy.replacingOccurrences(of: "docker=ok", with: "docker=missing")
            .replacingOccurrences(of: "privilege=ok", with: "privilege=missing")
            .replacingOccurrences(of: "directory=ok", with: "directory=unsafe")
            .replacingOccurrences(of: "port443=free", with: "port443=occupied"))
        XCTAssertEqual(broken.issues.count, 4)
        XCTAssertTrue(broken.issues.contains { $0.contains("443") })
        XCTAssertFalse(RemoteDeploySupport.parsePreflight("").passed)
    }

    func testKnownHostsAndTokens() {
        let output = "# comment\nexample.com ssh-ed25519 AQID\ninvalid ssh-rsa not-base64!\nexample.com ssh-unknown AQID\n"
        XCTAssertEqual(RemoteDeploySupport.knownHostLines(output), ["example.com ssh-ed25519 AQID"])
        let token = String(repeating: "a", count: 32)
        XCTAssertEqual(RemoteDeploySupport.validToken(token), token)
        XCTAssertNil(RemoteDeploySupport.validToken(String(repeating: "a", count: 31)))
        XCTAssertNil(RemoteDeploySupport.validToken(token + " "))
        XCTAssertNil(RemoteDeploySupport.validToken(token + "\n"))
    }
}
