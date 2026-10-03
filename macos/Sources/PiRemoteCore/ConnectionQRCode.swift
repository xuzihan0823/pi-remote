import CoreImage
import Foundation

/// Connection QR payload v1, identical to what the iOS client parses.
public struct ConnectionQRPayload: Codable, Equatable {
    public let version: Int
    public let serverUrl: String
    public let token: String

    public init(version: Int, serverUrl: String, token: String) {
        self.version = version
        self.serverUrl = serverUrl
        self.token = token
    }
}

public enum ConnectionQRCode {
    public static func payload(agentURL: URL, token: String) throws -> ConnectionQRPayload {
        _ = try EndpointValidator.validateWebSocket(agentURL.absoluteString, expectedPath: .agent)
        let iosURL = try EndpointValidator.iosURL(forAgentURL: agentURL)
        _ = try EndpointValidator.validateWebSocket(iosURL.absoluteString, expectedPath: .ios)
        let token = try EndpointValidator.validateToken(token)
        return ConnectionQRPayload(version: 1, serverUrl: iosURL.absoluteString, token: token)
    }

    public static func text(agentURL: URL, token: String) throws -> String {
        let payload = try payload(agentURL: agentURL, token: token)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(payload)
        guard let text = String(data: data, encoding: .utf8), text.utf8.count <= 4096 else {
            throw ValidationError("二维码内容无效")
        }
        return text
    }

    public static func image(from text: String, scale: CGFloat = 8) -> CGImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(text.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        return CIContext().createCGImage(scaled, from: scaled.extent)
    }
}
