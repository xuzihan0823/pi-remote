#if DEBUG
import AppKit
import PiRemoteCore
import SwiftUI

/// DEBUG-only: `PI_REMOTE_SNAPSHOT_DIR=<dir>` renders fixture states to PNG and exits. Fixtures use a
/// throwaway config directory, never read the keychain, and never start processes.
@MainActor
enum SnapshotRenderer {
    static var outputDirectory: String? { ProcessInfo.processInfo.environment["PI_REMOTE_SNAPSHOT_DIR"] }
    static var isActive: Bool { outputDirectory != nil }

    static func fixtureModel() -> AppModel {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("pi-remote-fixture-\(UUID().uuidString)")
        let model = AppModel(store: ConfigStore(directory: directory), readKeychain: false)
        model.serverURL = "wss://relay.example.com/ws/agent"
        model.workspacePath = "/Users/demo/Projects"
        model.deployTarget = RemoteDeployTarget(host: "203.0.113.10", identityFile: "/Users/demo/.ssh/id_ed25519")
        return model
    }

    struct Fixture {
        let name: String
        var size = CGSize(width: 1040, height: 720)
        var dark = false
        let configure: (AppModel) -> Void
    }

    static let demoToken = String(repeating: "d3m0", count: 16)

    static func connected(_ model: AppModel) {
        let url = URL(string: "wss://relay.example.com/ws/agent")!
        model.phase = .connected
        model.applyFixtureAgentURL(url)
        if let text = try? ConnectionQRCode.text(agentURL: url, token: demoToken), let image = ConnectionQRCode.image(from: text) {
            model.qrImage = NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
        }
        model.appendFixtureLog("[agent] connected to relay（演示）")
        model.appendFixtureLog("Agent 握手与健康检查通过（演示数据）")
    }

    static let fixtures: [Fixture] = [
        Fixture(name: "01-idle") { _ in },
        Fixture(name: "02-connecting-tunnel") { model in
            model.mode = .cloudflare
            model.phase = .connecting
            model.connectionStep = .awaitingTunnel
        },
        Fixture(name: "03-connected", configure: connected),
        Fixture(name: "04-connected-dark", dark: true, configure: connected),
        Fixture(name: "05-connected-min", size: CGSize(width: 900, height: 640), configure: connected),
        Fixture(name: "06-recovering") { model in
            model.phase = .recovering
        },
        Fixture(name: "07-error-diagnostics") { model in
            model.phase = .error
            model.errorMessage = "初次连通超时：健康检查返回状态码 502"
            model.diagnosticsExpanded = true
            for index in 1...14 { model.appendFixtureLog("[agent] reconnecting attempt \(index) token=\(demoToken)") }
        },
        Fixture(name: "08-deploy-form") { model in
            model.serverSource = .deploy
            model.fieldErrors[.deployKey] = "无法读取这个私钥文件，请重新选择"
        },
        Fixture(name: "09-deploy-hostkey") { model in
            model.serverSource = .deploy
            model.deployStage = .confirmHostKey(HostKeyInfo(
                host: "203.0.113.10", port: 22, keyLines: [],
                fingerprints: ["256 SHA256:n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg (ED25519)"]
            ))
        },
        Fixture(name: "10-deploy-confirm") { model in
            model.serverSource = .deploy
            model.deployStage = .confirmDeploy(domain: "203-0-113-10.sslip.io", isUpgrade: false)
        },
        Fixture(name: "11-deploy-running-dark", dark: true) { model in
            model.serverSource = .deploy
            model.deployStage = .running(.install)
        },
        Fixture(name: "12-deploy-preflight") { model in
            model.serverSource = .deploy
            model.deployStage = .preflightFailed([
                "未安装 Docker：请先按 Docker 官方文档安装 Docker Engine 后重试",
                "端口 443 已被其他程序占用：需要手动以 external-proxy 模式部署",
            ])
        },
    ]

    static func renderAll() {
        guard let outputDirectory else { return }
        try? FileManager.default.createDirectory(atPath: outputDirectory, withIntermediateDirectories: true)
        for fixture in fixtures {
            let model = fixtureModel()
            let hosting = NSHostingView(rootView: ContentView(model: model))
            let window = NSWindow(
                contentRect: NSRect(origin: .zero, size: fixture.size),
                styleMask: [.titled, .closable],
                backing: .buffered,
                defer: false
            )
            window.appearance = NSAppearance(named: fixture.dark ? .darkAqua : .aqua)
            window.contentView = hosting
            window.orderFrontRegardless()
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
            model.legacyAgentDetected = false
            fixture.configure(model)
            RunLoop.current.run(until: Date().addingTimeInterval(0.8))
            hosting.layoutSubtreeIfNeeded()
            guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { continue }
            hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
            let url = URL(fileURLWithPath: outputDirectory).appendingPathComponent("\(fixture.name).png")
            try? bitmap.representation(using: .png, properties: [:])?.write(to: url)
            window.orderOut(nil)
        }
    }
}
#endif
