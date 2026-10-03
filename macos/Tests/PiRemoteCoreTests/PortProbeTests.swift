import Darwin
import XCTest
@testable import PiRemoteCore

final class PortProbeTests: XCTestCase {
    func testRejectsOutOfRangePorts() {
        XCTAssertFalse(PortProbe.isAvailable(port: 0))
        XCTAssertFalse(PortProbe.isAvailable(port: 70000))
    }

    func testReportsBoundPortAsUnavailable() throws {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(descriptor, 0)
        defer { close(descriptor) }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bindResult = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        XCTAssertEqual(bindResult, 0)

        var bound = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameResult = withUnsafeMutablePointer(to: &bound) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(descriptor, $0, &length)
            }
        }
        XCTAssertEqual(nameResult, 0)
        let port = Int(UInt16(bigEndian: bound.sin_port))

        XCTAssertFalse(PortProbe.isAvailable(port: port))
    }
}
