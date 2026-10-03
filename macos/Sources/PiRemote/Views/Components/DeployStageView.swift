import PiRemoteCore
import SwiftUI

/// Right-hand stage while deploying to the user's own server: real step list plus the two
/// confirmation points (host fingerprint, then the server-modifying deploy itself).
struct DeployStageView: View {
    @ObservedObject var model: AppModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            stepList
            switch model.deployStage {
            case .confirmHostKey(let info):
                hostKeyCard(info)
            case .preflightFailed(let issues):
                issuesCard(issues)
            case .confirmDeploy(let domain, let isUpgrade):
                confirmCard(domain: domain, isUpgrade: isUpgrade)
            case .failed(let message):
                failedCard(message)
            case .fetchingHostKey, .checking, .running:
                HStack {
                    Spacer()
                    Button("取消部署") { model.cancelDeploy() }
                        .buttonStyle(SecondaryButtonStyle())
                }
            case .idle:
                EmptyView()
            }
        }
        .padding(24)
        .frame(maxWidth: 440)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.stage, style: .continuous)
                .fill(Theme.surface)
                .shadow(color: .black.opacity(colorScheme == .dark ? 0 : 0.05), radius: 20, y: 6)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.stage, style: .continuous)
                .stroke(Theme.border, lineWidth: colorScheme == .dark ? 1 : 0.5)
        )
    }

    private var stepList: some View {
        let steps = ConnectionPresentation.deploySteps
        let current = ConnectionPresentation.currentDeployStep(model.deployStage)
        let currentIndex = current.flatMap { steps.firstIndex(of: $0) } ?? (current == .done ? steps.count : -1)
        let failed: Bool = {
            if case .failed = model.deployStage { return true }
            if case .preflightFailed = model.deployStage { return true }
            return false
        }()
        return VStack(alignment: .leading, spacing: 10) {
            Text("\(model.deployTarget.user)@\(model.deployTarget.host)")
                .font(Theme.Font.control)
                .foregroundColor(Theme.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                HStack(spacing: 10) {
                    stepIcon(done: index < currentIndex, active: index == currentIndex, failed: failed && index == currentIndex)
                    Text(ConnectionPresentation.deployStepText(step))
                        .font(Theme.Font.body)
                        .foregroundColor(index <= currentIndex ? Theme.textPrimary : Theme.textTertiary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityValue(index < currentIndex ? "已完成" : index == currentIndex ? "进行中" : "未开始")
            }
        }
    }

    @ViewBuilder
    private func stepIcon(done: Bool, active: Bool, failed: Bool) -> some View {
        Group {
            if failed {
                Image(systemName: "exclamationmark.circle.fill").foregroundColor(Theme.warning)
            } else if done {
                Image(systemName: "checkmark.circle.fill").foregroundColor(Theme.accent)
            } else if active && model.deployStage.isWorking {
                ProgressView().controlSize(.small).scaleEffect(0.7)
            } else if active {
                Image(systemName: "circle.inset.filled").foregroundColor(Theme.warning)
            } else {
                Image(systemName: "circle").foregroundColor(Theme.border)
            }
        }
        .font(.system(size: 14))
        .frame(width: 18, height: 18)
        .accessibilityHidden(true)
    }

    private func hostKeyCard(_ info: HostKeyInfo) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("首次连接 \(info.host):\(info.port)")
                .font(Theme.Font.control)
                .foregroundColor(Theme.textPrimary)
            Text("请和服务商控制台或 `ssh-keygen -lf /etc/ssh/ssh_host_*.pub` 的输出核对以下指纹。指纹不一致时不要继续。")
                .font(Theme.Font.caption)
                .foregroundColor(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 4) {
                ForEach(info.fingerprints, id: \.self) { fingerprint in
                    Text(fingerprint)
                        .font(Theme.Font.mono)
                        .foregroundColor(Theme.textPrimary)
                        .textSelection(.enabled)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.canvas))
            HStack {
                Button("取消") { model.cancelDeploy() }
                    .buttonStyle(SecondaryButtonStyle())
                Spacer()
                Button("信任并继续") { model.trustHostKey() }
                    .buttonStyle(PrimaryButtonStyle())
                    .frame(width: 140)
            }
        }
    }

    private func issuesCard(_ issues: [String]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(issues, id: \.self) { issue in
                Label(issue, systemImage: "exclamationmark.circle")
                    .font(Theme.Font.caption)
                    .foregroundColor(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button("关闭") { model.dismissDeployResult() }
                    .buttonStyle(SecondaryButtonStyle())
                Spacer()
                Button("重新检查") { model.startDeploy() }
                    .buttonStyle(PrimaryButtonStyle())
                    .frame(width: 120)
            }
        }
    }

    private func confirmCard(domain: String, isUpgrade: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            summaryRow("服务器", "\(model.deployTarget.user)@\(model.deployTarget.host)")
            summaryRow("域名", domain)
            summaryRow("操作", isUpgrade ? "升级已有部署（保留原连接密钥）" : "首次安装到 /opt/pi-remote")
            Text(isUpgrade
                 ? "升级前会备份现有部署；新版本启动失败时自动换回旧版本。"
                 : "将占用服务器的 80 和 443 端口，并自动申请 HTTPS 证书。")
                .font(Theme.Font.caption)
                .foregroundColor(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("取消") { model.cancelDeploy() }
                    .buttonStyle(SecondaryButtonStyle())
                Spacer()
                Button(isUpgrade ? "开始升级" : "开始部署") { model.confirmDeploy() }
                    .buttonStyle(PrimaryButtonStyle())
                    .frame(width: 140)
            }
        }
    }

    private func failedCard(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Notice(title: "部署未完成", message: message, tone: .danger, actionTitle: "查看诊断") {
                model.diagnosticsExpanded = true
            }
            HStack {
                Button("关闭") { model.dismissDeployResult() }
                    .buttonStyle(SecondaryButtonStyle())
                Spacer()
                Button("重试") { model.startDeploy() }
                    .buttonStyle(PrimaryButtonStyle())
                    .frame(width: 120)
            }
        }
    }

    private func summaryRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label)
                .font(Theme.Font.caption)
                .foregroundColor(Theme.textSecondary)
                .frame(width: 44, alignment: .leading)
            Text(value)
                .font(Theme.Font.body)
                .foregroundColor(Theme.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
