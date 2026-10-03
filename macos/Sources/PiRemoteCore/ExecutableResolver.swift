import Foundation

/// Resolves a PI_BIN value to an absolute executable path. Bare command names (e.g. "pi") are
/// looked up in the effective PATH, so a value copied from a .env file keeps working.
public enum ExecutableResolver {
    public static func resolve(_ raw: String, searchPath: String) -> String? {
        let value = (raw as NSString).expandingTildeInPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        if value.hasPrefix("/") {
            return FileManager.default.isExecutableFile(atPath: value) ? value : nil
        }
        for component in searchPath.split(separator: ":") where !component.isEmpty {
            let candidate = (String(component) as NSString).appendingPathComponent(value)
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return (candidate as NSString).standardizingPath
            }
        }
        return nil
    }

    public static func looksLikeAbsolutePath(_ raw: String) -> Bool {
        (raw as NSString).expandingTildeInPath.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/")
    }
}
