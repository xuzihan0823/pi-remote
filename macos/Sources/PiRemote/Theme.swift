import AppKit
import SwiftUI

enum Theme {
    private static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let hex = isDark ? dark : light
            return NSColor(
                calibratedRed: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        })
    }

    static let canvas = adaptive(0xF7F8F5, 0x151B18)
    static let sidebar = adaptive(0xEEF2EC, 0x1C2420)
    static let surface = adaptive(0xFFFFFF, 0x242E28)
    static let surfaceHover = adaptive(0xE8EEE6, 0x2D3931)
    static let border = adaptive(0xDCE3D9, 0x405046)
    static let controlBorder = adaptive(0x7A877D, 0x798F80)
    static let textPrimary = adaptive(0x202A24, 0xEDF2EA)
    static let textSecondary = adaptive(0x59665E, 0xB0BDB3)
    static let textTertiary = adaptive(0x657269, 0x9AADA0)
    static let accent = adaptive(0x216B52, 0x94D9B4)
    static let primaryFill = adaptive(0x216B52, 0x94D9B4)
    static let onPrimary = adaptive(0xFFFFFF, 0x132C20)
    static let warning = adaptive(0x845810, 0xE8BC6A)
    static let danger = adaptive(0xB23F3B, 0xF0A09A)
    static let focusRing = adaptive(0x216B52, 0x94D9B4)
    static let qrPaper = Color.white

    enum Font {
        static let brand = SwiftUI.Font.system(size: 17, weight: .semibold)
        static let hero = SwiftUI.Font.system(size: 28, weight: .semibold)
        static let section = SwiftUI.Font.system(size: 17, weight: .semibold)
        static let body = SwiftUI.Font.system(size: 13)
        static let control = SwiftUI.Font.system(size: 13, weight: .medium)
        static let caption = SwiftUI.Font.system(size: 12)
        static let mono = SwiftUI.Font.system(size: 11.5, design: .monospaced)
    }

    enum Radius {
        static let control: CGFloat = 10
        static let segment: CGFloat = 12
        static let stage: CGFloat = 20
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.Font.control)
            .foregroundColor(Theme.onPrimary)
            .frame(maxWidth: .infinity, minHeight: 40)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
                    .fill(Theme.primaryFill)
                    .brightness(configuration.isPressed ? -0.06 : 0)
            )
            .opacity(isEnabled ? 1 : 0.45)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
            .animation(configuration.isPressed ? Motion.press : Motion.release, value: configuration.isPressed)
            .contentShape(Rectangle())
    }
}

/// Outlined button. `fill` stretches it to the available width (used for the sidebar's main action).
struct SecondaryButtonStyle: ButtonStyle {
    var fill = false
    var tint: Color = Theme.textPrimary
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.Font.control)
            .foregroundColor(tint)
            .padding(.horizontal, 14)
            .frame(maxWidth: fill ? .infinity : nil, minHeight: fill ? 40 : 32)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
                    .fill(configuration.isPressed || hovering ? Theme.surfaceHover : Theme.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
                    .stroke(Theme.controlBorder.opacity(0.7), lineWidth: 1)
            )
            .opacity(isEnabled ? 1 : 0.5)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
            .animation(Motion.hover, value: hovering)
            .animation(configuration.isPressed ? Motion.press : Motion.release, value: configuration.isPressed)
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
    }
}

/// Text-only action such as "从 .env 导入".
struct LinkButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.Font.caption.weight(.medium))
            .foregroundColor(Theme.accent)
            .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.45)
            .frame(minHeight: 28)
            .contentShape(Rectangle())
    }
}
