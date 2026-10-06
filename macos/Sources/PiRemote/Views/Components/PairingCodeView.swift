import AppKit
import SwiftUI

/// Pairing area. A real code is shown only when the caller passes an image, which it must do only for
/// `phase == .connected && qrImage != nil`; any other state swaps to a same-size placeholder at once.
struct PairingCodeView: View {
    let image: NSImage?
    let placeholderSymbol: String
    let placeholderTone: StatusTone
    let placeholderText: String
    var scanHint = "打开 iPhone 上的 Pi Remote，选择扫码连接"
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale

    private let codeSize: CGFloat = 232
    private let generatorScale: CGFloat = 8

    var body: some View {
        VStack(spacing: 14) {
            VStack(spacing: 4) {
                Text(image == nil ? "手机连接码" : "用手机扫码")
                    .font(Theme.Font.section)
                    .foregroundColor(Theme.textPrimary)
                Text(image == nil ? placeholderText : scanHint)
                    .font(Theme.Font.body)
                    .foregroundColor(Theme.textSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let image {
                code(image)
            } else {
                placeholder
            }
            Text("连接码包含访问密钥，仅供自己的设备使用")
                .font(Theme.Font.caption)
                .foregroundColor(Theme.textTertiary)
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

    private func code(_ image: NSImage) -> some View {
        let modules = max(image.size.width / generatorScale, 21)
        let pixelSize = snapped(codeSize, modules: modules)
        let quietZone = max(20, ceil(4 * pixelSize / modules))
        return Image(nsImage: image)
            .interpolation(.none)
            .resizable()
            .frame(width: pixelSize, height: pixelSize)
            .padding(quietZone)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.qrPaper))
            .accessibilityLabel("手机连接二维码，包含连接凭据")
    }

    private var placeholder: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Theme.canvas)
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Theme.border, style: StrokeStyle(lineWidth: 1, dash: [5, 5]))
            Image(systemName: placeholderSymbol)
                .font(.system(size: 40, weight: .light))
                .foregroundColor(placeholderTone.color)
        }
        .frame(width: codeSize + 40, height: codeSize + 40)
        .accessibilityHidden(true)
    }

    /// Picks a size where every module maps to a whole number of device pixels.
    private func snapped(_ target: CGFloat, modules: CGFloat) -> CGFloat {
        let scale = max(displayScale, 1)
        let pixelsPerModule = max(floor(target * scale / modules), 1)
        return pixelsPerModule * modules / scale
    }
}
