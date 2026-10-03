import Foundation

/// Scrubs text before it is shown or exported as diagnostics: known secrets, `token=` style URL/query
/// parameters, and the user's home directory prefix.
public enum DiagnosticRedactor {
    public static func redact(_ text: String, secrets: [String], homeDirectory: String = NSHomeDirectory()) -> String {
        var result = text
        for secret in Set(secrets.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }) where secret.count >= 8 {
            result = result.replacingOccurrences(of: secret, with: "***")
        }
        result = result.replacingOccurrences(
            of: #"(?i)((?:token|secret|password|key)[\"']?\s*[=:]\s*[\"']?)[^\s&\"',}]+"#,
            with: "$1***",
            options: .regularExpression
        )
        if homeDirectory.count > 1 {
            result = result.replacingOccurrences(of: homeDirectory, with: "~")
        }
        return result
    }
}
