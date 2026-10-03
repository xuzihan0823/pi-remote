import Foundation

public struct DotEnvValues: Equatable {
    public var relayURL: String?
    public var relayToken: String?
    public var agentToken: String?
    public var piBin: String?
    public var workspaceRoot: String?
    public var runtime: String?

    public init(
        relayURL: String? = nil,
        relayToken: String? = nil,
        agentToken: String? = nil,
        piBin: String? = nil,
        workspaceRoot: String? = nil,
        runtime: String? = nil
    ) {
        self.relayURL = relayURL
        self.relayToken = relayToken
        self.agentToken = agentToken
        self.piBin = piBin
        self.workspaceRoot = workspaceRoot
        self.runtime = runtime
    }

    /// Prefers AGENT_TOKEN (the credential the agent presents) and falls back to RELAY_TOKEN.
    public var effectiveToken: String? {
        if let agentToken, !agentToken.isEmpty { return agentToken }
        if let relayToken, !relayToken.isEmpty { return relayToken }
        return nil
    }
}

/// Minimal .env reader. It never executes a shell and never logs values.
public enum DotEnv {
    public static let knownKeys: Set<String> = [
        "RELAY_URL", "RELAY_TOKEN", "AGENT_TOKEN", "PI_BIN", "PI_WORKSPACE_ROOT", "PI_RUNTIME",
    ]

    public static func parse(_ text: String) -> [String: String] {
        var values: [String: String] = [:]
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            var line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            if line.hasPrefix("export ") { line = String(line.dropFirst("export ".count)).trimmingCharacters(in: .whitespaces) }
            guard let separator = line.firstIndex(of: "=") else { continue }
            let key = String(line[line.startIndex..<separator]).trimmingCharacters(in: .whitespaces)
            guard !key.isEmpty else { continue }
            var value = String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespaces)
            value = unquote(value)
            guard !value.isEmpty else { continue }
            values[key] = value
        }
        return values
    }

    public static func extract(_ text: String) -> DotEnvValues {
        let values = parse(text)
        return DotEnvValues(
            relayURL: values["RELAY_URL"],
            relayToken: values["RELAY_TOKEN"],
            agentToken: values["AGENT_TOKEN"],
            piBin: values["PI_BIN"],
            workspaceRoot: values["PI_WORKSPACE_ROOT"],
            runtime: values["PI_RUNTIME"]
        )
    }

    private static func unquote(_ value: String) -> String {
        if value.hasPrefix("'") {
            let rest = value.dropFirst()
            guard let end = rest.firstIndex(of: "'") else { return String(rest) }
            return String(rest[rest.startIndex..<end])
        }
        if value.hasPrefix("\"") {
            let rest = value.dropFirst()
            let inner = rest.firstIndex(of: "\"").map { rest[rest.startIndex..<$0] } ?? rest
            return inner
                .replacingOccurrences(of: "\\n", with: "\n")
                .replacingOccurrences(of: "\\\"", with: "\"")
                .replacingOccurrences(of: "\\\\", with: "\\")
        }
        if let comment = value.range(of: " #") {
            return String(value[value.startIndex..<comment.lowerBound]).trimmingCharacters(in: .whitespaces)
        }
        return value
    }
}
