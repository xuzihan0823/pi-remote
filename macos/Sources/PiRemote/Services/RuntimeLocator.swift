import Foundation
import PiRemoteCore

struct RuntimePaths {
    let runtimeDirectory: URL
    let node: URL
    let cloudflared: URL
    let supervisor: URL

    var nodeDirectory: String { node.deletingLastPathComponent().path }
}

struct ClaudeRuntimePaths {
    let runtimeDirectory: URL
    let node: URL
    let supervisor: URL
}

enum RuntimeLocator {
    static func bundledServerBundleDirectory() -> URL {
        let resources = Bundle.main.resourceURL ?? Bundle.main.bundleURL
        let bundled = resources.appendingPathComponent("server-bundle", isDirectory: true)
        if FileManager.default.fileExists(atPath: bundled.appendingPathComponent("scripts/install-server.sh").path) {
            return bundled
        }
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return source
    }

    static func locateServerBundle() throws -> URL {
        let bundle = bundledServerBundleDirectory()
        for path in ["scripts/install-server.sh", "scripts/lib/server-preflight.sh", "deploy/docker-compose.standalone.yml", "deploy/Caddyfile.standalone", "package.json", "package-lock.json", "Dockerfile", "src"] {
            guard FileManager.default.fileExists(atPath: bundle.appendingPathComponent(path).path) else {
                throw ValidationError("部署文件缺少 \(path)，请用 macos/build.sh 重新构建")
            }
        }
        return bundle
    }

    static func bundledRuntimeDirectory() -> URL {
        let resources = Bundle.main.resourceURL ?? Bundle.main.bundleURL
        return resources.appendingPathComponent("runtime", isDirectory: true)
    }

    static func locateClaude() throws -> ClaudeRuntimePaths {
        let directory = bundledRuntimeDirectory()
        for path in [
            "node", "runtime-supervisor.mjs", "claude/package.json", "claude/src/index.ts",
            "claude/node_modules/@anthropic-ai/claude-agent-sdk/package.json",
            "claude/node_modules/ws/package.json", "claude/node_modules/qrcode/package.json",
        ] {
            guard FileManager.default.fileExists(atPath: directory.appendingPathComponent(path).path) else {
                throw ValidationError("应用内 Claude 运行环境缺少 \(path)，请用 macos/build.sh 重新构建")
            }
        }
        return ClaudeRuntimePaths(
            runtimeDirectory: directory,
            node: directory.appendingPathComponent("node"),
            supervisor: directory.appendingPathComponent("runtime-supervisor.mjs")
        )
    }

    static func locate() throws -> RuntimePaths {
        let directory = bundledRuntimeDirectory()
        let fileManager = FileManager.default
        func require(_ relativePath: String) throws -> URL {
            let url = directory.appendingPathComponent(relativePath)
            guard fileManager.fileExists(atPath: url.path) else {
                throw ValidationError("应用内运行环境缺少 \(relativePath)，请用 macos/build.sh 重新构建")
            }
            return url
        }
        return RuntimePaths(
            runtimeDirectory: directory,
            node: try require("node"),
            cloudflared: try require("cloudflared"),
            supervisor: try require("runtime-supervisor.mjs")
        )
    }
}
