// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "PiRemote",
    platforms: [.macOS(.v13)],
    targets: [
        .target(
            name: "PiRemoteCore",
            path: "Sources/PiRemoteCore"
        ),
        .executableTarget(
            name: "PiRemote",
            dependencies: ["PiRemoteCore"],
            path: "Sources/PiRemote"
        ),
        .testTarget(
            name: "PiRemoteCoreTests",
            dependencies: ["PiRemoteCore"],
            path: "Tests/PiRemoteCoreTests"
        ),
        .testTarget(
            name: "PiRemoteServiceTests",
            dependencies: ["PiRemote", "PiRemoteCore"],
            path: "Tests/PiRemoteServiceTests"
        ),
    ]
)
