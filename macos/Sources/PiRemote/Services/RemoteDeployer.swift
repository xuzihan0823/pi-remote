import Foundation
import PiRemoteCore

@MainActor final class RemoteDeployer {
    enum Event { case step(DeployStep); case log(String) }
    private let serverBundle: URL
    private let knownHostsURL: URL
    private let runner = ProcessRunner()

    init(serverBundle: URL, knownHostsURL: URL) {
        self.serverBundle = serverBundle
        self.knownHostsURL = knownHostsURL
    }

    func knownHostKey(for target: RemoteDeployTarget) -> Bool {
        guard let text = try? String(contentsOf: knownHostsURL) else { return false }
        let name = target.port == 22 ? target.host : "[\(target.host)]:\(target.port)"
        return text.split(whereSeparator: \.isNewline).contains { $0.split(separator: " ").first?.split(separator: ",").contains(Substring(name)) == true }
    }

    func fetchHostKey(for target: RemoteDeployTarget) async throws -> HostKeyInfo {
        let target = try target.validated()
        let key = target.port == 22 ? target.host : "[\(target.host)]:\(target.port)"
        let result = try await run("/usr/bin/ssh-keyscan", arguments: ["-T", "15", "-p", String(target.port), target.host])
        let lines = RemoteDeploySupport.knownHostLines(result.stdout).filter { $0.split(separator: " ").first == Substring(key) }
        guard !lines.isEmpty else { throw ValidationError("无法获取服务器主机指纹，请检查地址和网络") }
        var fingerprints: [String] = []
        for line in lines {
            let parts = line.split(separator: " ")
            fingerprints.append(try fingerprint(for: String(parts[1]), base64: String(parts[2])))
        }
        return HostKeyInfo(host: target.host, port: target.port, keyLines: lines, fingerprints: fingerprints)
    }

    func trust(_ info: HostKeyInfo) throws {
        guard !knownHostKey(for: RemoteDeployTarget(host: info.host, port: info.port)) else {
            throw ValidationError("服务器主机密钥已存在，不会自动覆盖；若指纹变化，请先确认原因")
        }
        guard !info.keyLines.isEmpty, info.keyLines.count == info.fingerprints.count else { throw ValidationError("主机指纹不完整") }
        try FileManager.default.createDirectory(at: knownHostsURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        var text = (try? String(contentsOf: knownHostsURL)) ?? ""
        let name = info.port == 22 ? info.host : "[\(info.host)]:\(info.port)"
        for line in info.keyLines {
            let fields = line.split(separator: " ")
            guard fields.count == 3 else { continue }
            text += "\(name) \(fields[1]) \(fields[2])\n"
        }
        try Data(text.utf8).write(to: knownHostsURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: knownHostsURL.path)
    }

    func preflight(_ target: RemoteDeployTarget) async throws -> RemotePreflightReport {
        let target = try target.validated()
        let command = """
        printf 'os=%s\\n' "$(uname -s)"; printf 'arch=%s\\n' "$(uname -m)";
        if [ -r /etc/os-release ]; then . /etc/os-release; printf 'distro=%s\\n' "$ID"; fi;
        command -v docker >/dev/null && echo docker=ok || echo docker=missing;
        docker compose version >/dev/null 2>&1 && echo compose=ok || echo compose=missing;
        if [ "$(id -u)" = 0 ]; then prefix=''; echo privilege=ok; elif sudo -n true 2>/dev/null; then prefix='sudo -n'; echo privilege=ok; else prefix=''; echo privilege=missing; fi;
        $prefix docker info >/dev/null 2>&1 && echo daemon=ok || echo daemon=missing;
        if [ -L /opt/pi-remote ] || [ -L /opt/pi-remote/.env ]; then echo directory=unsafe;
        elif [ -f /opt/pi-remote/.pi-remote-managed ] && grep -qx pi-remote-installer-v1 /opt/pi-remote/.pi-remote-managed; then echo directory=upgrade;
        elif [ -e /opt/pi-remote ]; then echo directory=unsafe; else echo directory=ok; fi;
        for p in 80 443; do
            if command -v ss >/dev/null 2>&1; then occupied=$(ss -tulnH 2>/dev/null | grep -E "(^|[[:space:]:])$p[[:space:]]" || true);
            elif command -v netstat >/dev/null 2>&1; then occupied=$(netstat -tuln 2>/dev/null | grep -E "[:.]$p[[:space:]]" || true);
            else occupied=unknown; fi;
            if [ "$occupied" = unknown ]; then echo port$p=unknown;
            elif [ -z "$occupied" ]; then echo port$p=free;
            elif [ -f /opt/pi-remote/.pi-remote-managed ] && [ "$($prefix docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' pi-remote-caddy 2>/dev/null)" = pi-remote ] && $prefix docker port pi-remote-caddy 2>/dev/null | grep -Eq ":$p$"; then echo port$p=owned;
            else echo port$p=occupied; fi;
        done
        """
        let output = try await run("/usr/bin/ssh", arguments: RemoteDeploySupport.sshArguments(for: target, knownHosts: knownHostsURL, command: command))
        return RemoteDeploySupport.parsePreflight(output.stdout)
    }

    func deploy(_ rawTarget: RemoteDeployTarget, onEvent: @escaping (Event) -> Void) async throws -> DeployResult {
        let target = try rawTarget.validated()
        onEvent(.step(.preflight))
        let report = try await preflight(target)
        guard report.passed else { throw ValidationError(report.issues.joined(separator: "；")) }
        let domain = try resolvedDomain(target)
        let archive = try makeArchive()
        let temp = "/tmp/pi-remote-upload-\(UUID().uuidString)"
        defer { Task { try? await self.run("/usr/bin/ssh", arguments: RemoteDeploySupport.sshArguments(for: target, knownHosts: self.knownHostsURL, command: "rm -rf \(RemoteDeploySupport.shellQuote(temp))")) } }
        onEvent(.step(.upload))
        _ = try await run("/usr/bin/ssh", arguments: RemoteDeploySupport.sshArguments(for: target, knownHosts: knownHostsURL, command: "mkdir -m 700 \(RemoteDeploySupport.shellQuote(temp)) && tar xzf - -C \(RemoteDeploySupport.shellQuote(temp))"), input: archive)
        onEvent(.step(.install))
        let command = target.user == "root" ? "bash" : "sudo -n bash"
        _ = try await run("/usr/bin/ssh", arguments: RemoteDeploySupport.sshArguments(for: target, knownHosts: knownHostsURL, command: "\(command) \(RemoteDeploySupport.shellQuote(temp + "/scripts/install-server.sh")) --domain \(RemoteDeploySupport.shellQuote(domain)) --mode standalone"), onOutput: { chunk in
            Task { @MainActor in onEvent(.log(Self.redact(chunk))) }
        })
        onEvent(.step(.readToken))
        let tokenCommand = target.user == "root" ? "grep '^RELAY_TOKEN=' /opt/pi-remote/.env" : "sudo -n grep '^RELAY_TOKEN=' /opt/pi-remote/.env"
        let tokenOutput = try await run("/usr/bin/ssh", arguments: RemoteDeploySupport.sshArguments(for: target, knownHosts: knownHostsURL, command: tokenCommand))
        guard let token = RemoteDeploySupport.validToken(tokenOutput.stdout.split(separator: "=", maxSplits: 1).dropFirst().joined(separator: "=").trimmingCharacters(in: .newlines)) else { throw ValidationError("服务器 Token 无效") }
        onEvent(.step(.waitPublic))
        try await waitPublic(domain: domain)
        onEvent(.step(.done))
        return DeployResult(domain: domain, agentURL: URL(string: "wss://\(domain)/ws/agent")!, token: token, wasUpgrade: report.isUpgrade)
    }

    func cancel() { runner.terminate() }

    private func resolvedDomain(_ target: RemoteDeployTarget) throws -> String {
        if !target.domain.isEmpty { return target.domain }
        if let domain = SSLipDomain.make(ipv4: target.host) { return domain }
        var hints = addrinfo(ai_flags: 0, ai_family: AF_INET, ai_socktype: SOCK_STREAM, ai_protocol: IPPROTO_TCP, ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil)
        var result: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(target.host, nil, &hints, &result) == 0, let info = result else { throw ValidationError("无法解析服务器 IPv4，请填写域名") }
        defer { freeaddrinfo(info) }
        var address = info.pointee.ai_addr!.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
        var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
        guard inet_ntop(AF_INET, &address, &buffer, socklen_t(INET_ADDRSTRLEN)) != nil else { throw ValidationError("无法解析服务器 IPv4，请填写域名") }
        return SSLipDomain.make(ipv4: String(cString: buffer))!
    }

    private func waitPublic(domain: String) async throws {
        let url = URL(string: "https://\(domain)/api/health")!
        let deadline = Date().addingTimeInterval(180)
        while Date() < deadline {
            var request = URLRequest(url: url)
            request.timeoutInterval = 15
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                if (response as? HTTPURLResponse)?.statusCode == 200,
                   let json = try JSONSerialization.jsonObject(with: data) as? [String: Any], json["status"] as? String == "ok" { return }
            } catch is CancellationError { throw CancellationError() } catch { }
            try await Task.sleep(for: .seconds(3))
        }
        throw ValidationError("等待公网服务超时，请检查 DNS 是否指向服务器，以及安全组是否放行 80/443 端口")
    }

    private func makeArchive() throws -> Data {
        let process = Process(); let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        process.arguments = ["-czf", "-", "-C", serverBundle.path, "."]
        process.standardOutput = pipe; try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw ValidationError("无法打包服务器部署文件") }
        return data
    }

    private func run(_ executable: String, arguments: [String], input: Data? = nil, onOutput: ((String) -> Void)? = nil) async throws -> ProcessOutput {
        try await runner.run(executable, arguments: arguments, input: input, onOutput: onOutput)
    }

    private static func redact(_ line: String) -> String {
        line.replacingOccurrences(of: #"RELAY_TOKEN=[^[:space:]]+"#, with: "RELAY_TOKEN=[已隐藏]", options: .regularExpression)
    }

    private func fingerprint(for type: String, base64: String) throws -> String {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try Data("\(type) \(base64)\n".utf8).write(to: temporary)
        let p = Process(); let out = Pipe(); p.executableURL = URL(fileURLWithPath: "/usr/bin/ssh-keygen"); p.arguments = ["-lf", temporary.path, "-E", "sha256"]; p.standardOutput = out; try p.run(); p.waitUntilExit()
        let text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        guard let value = text.split(whereSeparator: \.isWhitespace).first(where: { $0.hasPrefix("SHA256:") }) else { throw ValidationError("无法计算主机指纹") }
        return String(value)
    }
}

private struct ProcessOutput: Sendable { let stdout: String; let stderr: String }

private final class ProcessRunner: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?
    private var cancelled = false

    func terminate() {
        lock.lock()
        cancelled = true
        if let process, process.isRunning { process.terminate() }
        lock.unlock()
    }

    func run(_ executable: String, arguments: [String], input: Data? = nil, onOutput: ((String) -> Void)? = nil) async throws -> ProcessOutput {
        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global().async {
                    let child = Process()
                    let stdoutPipe = Pipe()
                    let stderrPipe = Pipe()
                    let inputPipe = input == nil ? nil : Pipe()
                    child.executableURL = URL(fileURLWithPath: executable)
                    child.arguments = arguments
                    child.standardOutput = stdoutPipe
                    child.standardError = stderrPipe
                    child.standardInput = inputPipe
                    self.lock.lock()
                    if self.cancelled {
                        self.lock.unlock()
                        continuation.resume(throwing: CancellationError())
                        return
                    }
                    do { try child.run() }
                    catch {
                        self.lock.unlock()
                        continuation.resume(throwing: error)
                        return
                    }
                    self.process = child
                    self.lock.unlock()

                    let group = DispatchGroup()
                    let outputLock = NSLock()
                    var stdout = Data()
                    var stderr = Data()
                    group.enter()
                    DispatchQueue.global().async {
                        defer { group.leave() }
                        var pendingLine = Data()
                        while true {
                            let data = stdoutPipe.fileHandleForReading.availableData
                            if data.isEmpty { break }
                            outputLock.lock()
                            stdout.append(data)
                            outputLock.unlock()
                            if onOutput != nil {
                                pendingLine.append(data)
                                while let index = pendingLine.firstIndex(of: 0x0A) {
                                    let line = Data(pendingLine[..<index])
                                    pendingLine.removeSubrange(...index)
                                    onOutput?(String(decoding: line, as: UTF8.self))
                                }
                            }
                        }
                        if !pendingLine.isEmpty { onOutput?(String(decoding: pendingLine, as: UTF8.self)) }
                    }
                    group.enter()
                    DispatchQueue.global().async {
                        defer { group.leave() }
                        while true {
                            let data = stderrPipe.fileHandleForReading.availableData
                            if data.isEmpty { break }
                            outputLock.lock()
                            stderr.append(data)
                            outputLock.unlock()
                        }
                    }
                    var inputError: Error?
                    if let input, let inputPipe {
                        do {
                            try inputPipe.fileHandleForWriting.write(contentsOf: input)
                            try inputPipe.fileHandleForWriting.close()
                        } catch {
                            inputError = error
                            self.terminate()
                        }
                    }
                    child.waitUntilExit()
                    group.wait()
                    self.lock.lock()
                    let wasCancelled = self.cancelled
                    self.process = nil
                    self.cancelled = false
                    self.lock.unlock()
                    let result = ProcessOutput(stdout: String(decoding: stdout, as: UTF8.self), stderr: String(decoding: stderr, as: UTF8.self))
                    if wasCancelled { continuation.resume(throwing: CancellationError()) }
                    else if let inputError { continuation.resume(throwing: inputError) }
                    else if child.terminationStatus != 0 { continuation.resume(throwing: ValidationError(Self.message(for: result.stderr))) }
                    else { continuation.resume(returning: result) }
                }
            }
        }, onCancel: { self.terminate() })
    }

    private static func message(for stderr: String) -> String {
        if stderr.localizedCaseInsensitiveContains("passphrase") || stderr.localizedCaseInsensitiveContains("sign_and_send_pubkey") {
            return "SSH 私钥需要口令，请先 ssh-add 加入钥匙串代理"
        }
        if stderr.localizedCaseInsensitiveContains("host key verification failed") || stderr.localizedCaseInsensitiveContains("REMOTE HOST IDENTIFICATION HAS CHANGED") {
            return "服务器主机密钥不匹配，已拒绝连接"
        }
        return "远程命令失败：\(stderr.trimmingCharacters(in: .whitespacesAndNewlines))"
    }
}
