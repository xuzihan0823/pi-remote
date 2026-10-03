import Foundation

public struct RemoteDeployTarget: Codable, Equatable {
    public var host: String
    public var port: Int
    public var user: String
    public var identityFile: String
    public var domain: String

    public init(host: String = "", port: Int = 22, user: String = "root", identityFile: String = "", domain: String = "") {
        self.host = host
        self.port = port
        self.user = user
        self.identityFile = identityFile
        self.domain = domain
    }

    public func validated() throws -> RemoteDeployTarget {
        guard Self.validHostname(host) else { throw ValidationError("服务器地址必须是 IPv4 地址或有效主机名，不能带端口或用户名") }
        guard (1...65535).contains(port) else { throw ValidationError("SSH 端口必须在 1–65535 之间") }
        guard user.range(of: #"^[A-Za-z_][A-Za-z0-9_.-]*$"#, options: .regularExpression) != nil, user.count <= 32 else {
            throw ValidationError("SSH 用户名格式无效")
        }
        guard !identityFile.isEmpty, identityFile.rangeOfCharacter(from: .controlCharacters) == nil,
              (try? FileManager.default.attributesOfItem(atPath: identityFile)[.type] as? FileAttributeType) == .typeRegular else {
            throw ValidationError("请选择存在的 SSH 私钥文件")
        }
        if !domain.isEmpty {
            guard Self.validHostname(domain), !domain.hasPrefix("-"), domain.contains(".") else {
                throw ValidationError("域名格式无效，请填写完整域名")
            }
        }
        return self
    }

    private static func validHostname(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf8.count <= 253, !value.hasPrefix("-"), !value.hasSuffix(".") else { return false }
        let labels = value.split(separator: ".", omittingEmptySubsequences: false)
        return labels.allSatisfy { label in
            label.count <= 63 && label.range(of: #"^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$"#, options: .regularExpression) != nil
        }
    }
}

public enum SSLipDomain {
    public static func make(ipv4: String) -> String? {
        let parts = ipv4.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, parts.allSatisfy({ $0.range(of: #"^(0|[1-9][0-9]{0,2})$"#, options: .regularExpression) != nil && (Int($0).map { $0 <= 255 } ?? false) }) else { return nil }
        return parts.joined(separator: "-") + ".sslip.io"
    }
}

public enum DeployStep: Equatable {
    case hostKey, preflight, upload, install, readToken, waitPublic, done

    public var title: String {
        switch self {
        case .hostKey: "确认主机指纹"
        case .preflight: "检查服务器环境"
        case .upload: "上传部署包"
        case .install: "安装 Relay"
        case .readToken: "读取连接密钥"
        case .waitPublic: "等待公网服务"
        case .done: "部署完成"
        }
    }
}

public struct HostKeyInfo: Equatable {
    public let host: String
    public let port: Int
    public let keyLines: [String]
    public let fingerprints: [String]

    public init(host: String, port: Int, keyLines: [String], fingerprints: [String]) {
        self.host = host
        self.port = port
        self.keyLines = keyLines
        self.fingerprints = fingerprints
    }
}

public struct RemotePreflightReport: Equatable {
    public let issues: [String]
    public let isUpgrade: Bool
    public var passed: Bool { issues.isEmpty }

    public init(issues: [String], isUpgrade: Bool) {
        self.issues = issues
        self.isUpgrade = isUpgrade
    }
}

public struct DeployResult: Equatable {
    public let domain: String
    public let agentURL: URL
    public let token: String
    public let wasUpgrade: Bool

    public init(domain: String, agentURL: URL, token: String, wasUpgrade: Bool) {
        self.domain = domain
        self.agentURL = agentURL
        self.token = token
        self.wasUpgrade = wasUpgrade
    }
}

public enum RemoteDeploySupport {
    public static func sshArguments(for target: RemoteDeployTarget, knownHosts: URL, command: String? = nil) -> [String] {
        var args = ["-i", target.identityFile, "-p", String(target.port), "-o", "BatchMode=yes",
                    "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=15",
                    "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=\(knownHosts.path)",
                    "-o", "ServerAliveInterval=15", "\(target.user)@\(target.host)"]
        if let command { args.append(command) }
        return args
    }

    public static func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    public static func knownHostLines(_ output: String) -> [String] {
        output.split(whereSeparator: \.isNewline).map(String.init).filter { line in
            let parts = line.split(separator: " ")
            return parts.count == 3 && !line.hasPrefix("#") &&
                ["ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"].contains(String(parts[1])) &&
                Data(base64Encoded: String(parts[2])) != nil
        }
    }

    public static func parsePreflight(_ output: String) -> RemotePreflightReport {
        var values: [String: String] = [:]
        for line in output.split(whereSeparator: \.isNewline) {
            let pair = line.split(separator: "=", maxSplits: 1).map(String.init)
            if pair.count == 2 { values[pair[0]] = pair[1] }
        }
        var issues: [String] = []
        if values["os"] != "Linux" { issues.append("仅支持 Linux，请选择 Linux 服务器") }
        if !["x86_64", "amd64", "aarch64", "arm64"].contains(values["arch"] ?? "") { issues.append("架构不支持，请使用 x86_64 或 aarch64 服务器") }
        if !["ubuntu", "debian", "rocky", "almalinux", "fedora"].contains(values["distro"] ?? "") { issues.append("Linux 发行版不支持，请使用 Ubuntu、Debian、Rocky、AlmaLinux 或 Fedora") }
        if values["docker"] != "ok" { issues.append("Docker 未安装，请先安装 Docker Engine") }
        if values["compose"] != "ok" { issues.append("Docker Compose 不可用，请安装 Compose 插件") }
        if values["daemon"] != "ok" { issues.append("Docker 守护进程不可用，请启动 Docker 并授予访问权限") }
        if values["privilege"] != "ok" { issues.append("需要 root 或免密 sudo，请给用户配置 sudo -n 权限") }
        if values["directory"] != "ok" && values["directory"] != "upgrade" { issues.append("/opt/pi-remote 已存在但不是受管安装，或包含符号链接；请手动检查目录") }
        for port in [80, 443] {
            if values["port\(port)"] != "free" && values["port\(port)"] != "owned" {
                issues.append("端口 \(port) 被其他进程占用或无法检测，请手动使用 external-proxy 模式部署")
            }
        }
        return RemotePreflightReport(issues: issues, isUpgrade: values["directory"] == "upgrade")
    }

    public static func validToken(_ value: String) -> String? {
        guard value.utf8.count >= 32, value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
              value.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
        return value
    }
}
