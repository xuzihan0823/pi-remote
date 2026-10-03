import Foundation
import PiRemoteCore

enum HealthOutcome {
    case ready(deviceId: String)
    case notReady(String)
    case failed(String)

    var message: String {
        switch self {
        case .ready(let deviceId): return "已连接（deviceId=\(deviceId)）"
        case .notReady(let message): return message
        case .failed(let message): return message
        }
    }
}

enum HealthChecker {
    /// Public TLS health check. TLS validation stays enabled; the relay's device id must match this
    /// app's own agent so an unrelated agent can never be mistaken for a successful connection.
    static func check(agentURL: URL, expectedDeviceId: String, timeout: TimeInterval) async -> HealthOutcome {
        let url: URL
        do {
            url = try EndpointValidator.healthURL(forAgentURL: agentURL)
        } catch {
            return .failed(error.localizedDescription)
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let session = makeSession(timeout: timeout)
        defer { session.invalidateAndCancel() }

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .failed("健康检查没有有效响应") }
            guard http.statusCode == 200 else { return .failed("健康检查返回状态码 \(http.statusCode)") }
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return .failed("健康检查响应格式无效")
            }
            let connected = (object["agentConnected"] as? Bool) ?? false
            let deviceId = object["agentDeviceId"] as? String
            if connected, deviceId == expectedDeviceId { return .ready(deviceId: deviceId ?? "") }
            if connected { return .notReady("Relay 上已有其他 Agent 连接（deviceId=\(deviceId ?? "未知")）") }
            return .notReady("Relay 可达，但 Agent 尚未完成握手")
        } catch {
            return .failed("健康检查失败：\(error.localizedDescription)")
        }
    }

    static func localHealthOK(url: URL, timeout: TimeInterval) async -> Bool {
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let session = makeSession(timeout: timeout)
        defer { session.invalidateAndCancel() }
        do {
            let (_, response) = try await session.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    private static func makeSession(timeout: TimeInterval) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }
}
