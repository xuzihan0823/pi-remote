import Foundation
import PiRemoteCore

/// One managed child process, run through runtime-supervisor.mjs. The supervisor owns the process
/// tree; stopping this object closes the supervisor's stdin, which triggers a graceful SIGTERM and
/// a SIGKILL fallback inside the supervisor.
/// `@unchecked Sendable`: the only cross-thread access is `waitUntilExit`/`forceTerminate` from the
/// shutdown helper on a background queue, and the exit-callback flag is guarded by `stateLock`.
final class SupervisorProcess: @unchecked Sendable {
    let tag: String

    private let job: SupervisorJob
    private let node: URL
    private let supervisor: URL
    private let process = Process()
    private let stdinPipe = Pipe()
    private let stdoutPipe = Pipe()
    private let stderrPipe = Pipe()
    private let stateLock = NSLock()
    private var suppressExitCallback = false

    var onOutput: ((String) -> Void)?
    var onExit: ((Int32) -> Void)?

    init(job: SupervisorJob, node: URL, supervisor: URL) {
        self.job = job
        self.node = node
        self.supervisor = supervisor
        self.tag = job.tag
    }

    var isRunning: Bool { process.isRunning }

    func start() throws {
        process.executableURL = node
        process.arguments = [supervisor.path]
        process.environment = job.env
        process.currentDirectoryURL = URL(fileURLWithPath: job.cwd, isDirectory: true)
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        installReader(stdoutPipe.fileHandleForReading)
        installReader(stderrPipe.fileHandleForReading)
        process.terminationHandler = { [weak self] finished in
            guard let self else { return }
            self.stateLock.lock()
            let suppress = self.suppressExitCallback
            self.stateLock.unlock()
            if !suppress { self.onExit?(finished.terminationStatus) }
        }
        try process.run()
        try stdinPipe.fileHandleForWriting.write(contentsOf: job.encodedLine())
    }

    func stop() {
        stateLock.lock()
        suppressExitCallback = true
        stateLock.unlock()
        try? stdinPipe.fileHandleForWriting.close()
    }

    func waitUntilExit(deadline: Date) -> Bool {
        while Date() < deadline {
            if !process.isRunning { return true }
            usleep(100_000)
        }
        return !process.isRunning
    }

    func forceTerminate() {
        if process.isRunning { process.terminate() }
    }

    private func installReader(_ handle: FileHandle) {
        var buffer = Data()
        handle.readabilityHandler = { [weak self] fileHandle in
            let data = fileHandle.availableData
            if data.isEmpty {
                fileHandle.readabilityHandler = nil
                if !buffer.isEmpty {
                    let line = String(decoding: buffer, as: UTF8.self)
                    buffer.removeAll()
                    self?.onOutput?(line)
                }
                return
            }
            buffer.append(data)
            while let index = buffer.firstIndex(of: 0x0A) {
                let lineData = buffer[buffer.startIndex..<index]
                buffer.removeSubrange(buffer.startIndex...index)
                self?.onOutput?(String(decoding: lineData, as: UTF8.self))
            }
        }
    }
}
