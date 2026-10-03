import PiRemoteCore
import SwiftUI

enum StatusTone {
    case neutral, working, success, warning, danger

    var color: Color {
        switch self {
        case .neutral: return Theme.textSecondary
        case .working: return Theme.accent
        case .success: return Theme.accent
        case .warning: return Theme.warning
        case .danger: return Theme.danger
        }
    }

    var symbol: String {
        switch self {
        case .neutral: return "circle"
        case .working: return "arrow.left.arrow.right"
        case .success: return "checkmark.circle.fill"
        case .warning: return "arrow.clockwise"
        case .danger: return "exclamationmark.circle.fill"
        }
    }
}

/// Pure mapping from real model state to what the window says. Views never parse `statusDetail`.
struct ConnectionPresentation: Equatable {
    let title: String
    let subtitle: String
    let badge: String
    let tone: StatusTone

    static func make(
        phase: ConnectionPhase,
        idleReason: IdleReason,
        mode: ConnectionMode,
        step: ConnectionStep,
        deployVisible: Bool,
        deployStage: DeployStage,
        deploySourceIdle: Bool
    ) -> ConnectionPresentation {
        if deployVisible, phase == .idle || phase == .error {
            return deploy(deployStage)
        }
        switch phase {
        case .idle:
            if deploySourceIdle {
                return .init(title: "部署到你的服务器", subtitle: "填写服务器与 SSH 私钥，一步完成中转服务部署。", badge: "未连接", tone: .neutral)
            }
            return idleReason == .disconnected
                ? .init(title: "已断开连接", subtitle: "设置已保留，可随时重新连接。", badge: "已断开", tone: .neutral)
                : .init(title: "让手机连接这台 Mac", subtitle: "配置连接方式后，生成手机连接码。", badge: "未连接", tone: .neutral)
        case .connecting:
            return .init(title: "正在建立连接", subtitle: stepText(step, mode: mode) + "…", badge: "连接中", tone: .working)
        case .connected:
            return .init(title: "已准备好，随时连接", subtitle: "用 iPhone 扫码，访问这台 Mac 上的 pi。", badge: "可供手机连接", tone: .success)
        case .recovering:
            return .init(title: "连接暂时中断", subtitle: "正在自动重连，恢复后会重新显示连接码。", badge: "恢复中", tone: .warning)
        case .stopping:
            return .init(title: "正在断开", subtitle: "正在结束本次连接并清理后台进程。", badge: "正在断开", tone: .working)
        case .error:
            return .init(title: "连接未完成", subtitle: "请查看下方原因，处理后重试。", badge: "连接异常", tone: .danger)
        }
    }

    static func steps(for mode: ConnectionMode) -> [ConnectionStep] {
        mode == .cloudflare ? [.preparing, .awaitingTunnel, .awaitingServer] : [.preparing, .awaitingServer]
    }

    static func stepText(_ step: ConnectionStep, mode: ConnectionMode) -> String {
        switch step {
        case .preparing: return "准备运行环境"
        case .awaitingTunnel: return "获取临时地址"
        case .awaitingServer: return "等待服务器确认"
        }
    }

    private static func deploy(_ stage: DeployStage) -> ConnectionPresentation {
        switch stage {
        case .idle:
            return .init(title: "部署到你的服务器", subtitle: "填写服务器与 SSH 私钥，一步完成中转服务部署。", badge: "未连接", tone: .neutral)
        case .fetchingHostKey:
            return .init(title: "正在连接服务器", subtitle: "正在获取服务器指纹…", badge: "部署中", tone: .working)
        case .confirmHostKey:
            return .init(title: "确认服务器身份", subtitle: "首次连接这台服务器，请核对指纹后继续。", badge: "等待确认", tone: .warning)
        case .checking:
            return .init(title: "正在检查服务器", subtitle: "只读取环境信息，不会修改服务器。", badge: "部署中", tone: .working)
        case .preflightFailed:
            return .init(title: "服务器还不满足部署条件", subtitle: "处理下列问题后重新检查。服务器没有被修改。", badge: "需要处理", tone: .warning)
        case .confirmDeploy:
            return .init(title: "准备部署", subtitle: "确认后将在服务器上安装并启动中转服务。", badge: "等待确认", tone: .warning)
        case .running(let step):
            return .init(title: "正在部署中转服务", subtitle: deployStepText(step) + "…", badge: "部署中", tone: .working)
        case .failed:
            return .init(title: "部署未完成", subtitle: "请查看下方原因，处理后重试。", badge: "部署失败", tone: .danger)
        }
    }

    static let deploySteps: [DeployStep] = [.hostKey, .preflight, .upload, .install, .readToken, .waitPublic]

    static func deployStepText(_ step: DeployStep) -> String {
        switch step {
        case .hostKey: return "确认服务器身份"
        case .preflight: return "检查服务器环境"
        case .upload: return "上传部署文件"
        case .install: return "安装并启动服务"
        case .readToken: return "读取连接密钥"
        case .waitPublic: return "等待公网就绪"
        case .done: return "部署完成"
        }
    }

    /// The step the deploy flow is currently on, used to mark earlier steps as done.
    static func currentDeployStep(_ stage: DeployStage) -> DeployStep? {
        switch stage {
        case .idle: return nil
        case .fetchingHostKey, .confirmHostKey: return .hostKey
        case .checking, .preflightFailed: return .preflight
        case .confirmDeploy: return .upload
        case .running(let step): return step
        case .failed: return nil
        }
    }
}
