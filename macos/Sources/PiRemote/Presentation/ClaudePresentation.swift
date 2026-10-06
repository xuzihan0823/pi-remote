import PiRemoteCore

enum ServiceKind: Hashable {
    case pi, claude

    var title: String { self == .pi ? "Pi Remote" : "Claude" }
}

/// Pure mapping from the Claude service controller state to window copy, mirroring `ConnectionPresentation`.
struct ClaudePresentation: Equatable {
    let title: String
    let subtitle: String
    let badge: String
    let tone: StatusTone

    static func make(state: ClaudeServiceController.State, mode: ClaudeServiceMode) -> ClaudePresentation {
        switch state {
        case .idle:
            return .init(title: "在这台 Mac 上运行 Claude", subtitle: "启动后，可用 Claude Remote 访问本机的 Claude 会话。", badge: "未启动", tone: .neutral)
        case .starting:
            let step = mode == .cloudflare ? "正在启动后端并建立临时隧道…" : "正在启动本机后端…"
            return .init(title: "正在启动 Claude 服务", subtitle: step, badge: "启动中", tone: .working)
        case .running:
            return mode == .cloudflare
                ? .init(title: "已准备好，随时连接", subtitle: "用 iPhone 上的 Claude Remote 扫码连接。", badge: "可供手机连接", tone: .success)
                : .init(title: "Claude 服务正在本机运行", subtitle: "只监听 127.0.0.1，手机无法直接连接；需要手机访问请改用临时隧道。", badge: "本机运行中", tone: .success)
        case .stopping:
            return .init(title: "正在停止", subtitle: "正在结束 Claude 服务并清理后台进程。", badge: "正在停止", tone: .working)
        case .failed:
            return .init(title: "Claude 服务未运行", subtitle: "请查看下方原因，处理后重试。", badge: "服务异常", tone: .danger)
        }
    }
}

extension ClaudeServiceController.State {
    var canEdit: Bool {
        switch self {
        case .idle, .failed: return true
        default: return false
        }
    }

    var failureMessage: String? {
        if case .failed(let message) = self { return message }
        return nil
    }
}
