import Foundation
import Security

public enum TokenGenerator {
    /// Cryptographically random hex token, at least 32 bytes of entropy (64 hex characters).
    public static func randomHex(byteCount: Int = 32) -> String? {
        let count = max(32, byteCount)
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        guard status == errSecSuccess else { return nil }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
