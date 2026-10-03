import Foundation
import PiRemoteCore

/// Legacy per-user launchd agent (`com.piremote.agent`). We only ever touch this one label and only
/// after the user presses the takeover button.
enum LegacyAgentHandoff {
    static let label = "com.piremote.agent"

    static var domainTarget: String { "gui/\(getuid())/\(label)" }

    static func isInstalled() -> Bool {
        run(["print", domainTarget]).status == 0
    }

    static func takeover() throws {
        _ = run(["bootout", domainTarget])
        let disable = run(["disable", domainTarget])
        guard disable.status == 0 else {
            let detail = disable.output.isEmpty ? "launchctl 返回 \(disable.status)" : disable.output
            throw ValidationError("无法停用旧服务 \(label)：\(detail)")
        }
    }

    static func recoveryCommand() -> String {
        "launchctl enable \(domainTarget) && launchctl bootstrap gui/\(getuid()) ~/Library/LaunchAgents/\(label).plist"
    }

    private static func run(_ arguments: [String]) -> (status: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            process.waitUntilExit()
            let read = try? pipe.fileHandleForReading.readToEnd()
            let data = (read ?? nil) ?? Data()
            return (process.terminationStatus, String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
        } catch {
            return (1, error.localizedDescription)
        }
    }
}
