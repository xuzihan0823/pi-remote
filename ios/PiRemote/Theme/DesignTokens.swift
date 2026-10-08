import SwiftUI

public enum DesignTokens {
    // MARK: - Colors
    public enum Colors {
        public static let background = Color(light: 0xF7F8F5, dark: 0x111412)
        public static let surface = Color(light: 0xFFFFFF, dark: 0x1C201D)
        public static let textPrimary = Color(light: 0x202522, dark: 0xECEFEC)
        public static let textSecondary = Color(light: 0x777E79, dark: 0x9CA49E)
        public static let textPlaceholder = Color(light: 0x949B95, dark: 0x6E766F)
        public static let accentGreen = Color(light: 0x216B52, dark: 0x4FB38C)
        public static let textOnGreen = Color.white

        public static let glassLight = Color(light: 0xF0F3EC, dark: 0x1E2320)
        public static let glassMedium = Color(light: 0xE8EEE6, dark: 0x232925)
        public static let glassMediumAlt = Color(light: 0xEAEEE8, dark: 0x252B27)
        public static let glassCard = Color(light: 0xDFE5DF, dark: 0x2A312C)
        public static let glassCardSelected = Color(light: 0xE1EAE3, dark: 0x2C3A31)
        /// 叠在 clear 玻璃上的轻微雾化，保证文字可读又比 regular 更通透
        public static let glassFrost = Color(light: 0xFFFFFF, dark: 0xFFFFFF, lightAlpha: 0.28, darkAlpha: 0.06)

        public static let divider = Color(light: 0xE4E8E1, dark: 0x2C322E)

        public static let diffAdd = Color(light: 0x216B52, dark: 0x4FB38C)
        public static let diffRemove = Color(light: 0xB66E65, dark: 0xD98A80)

        public static let darkButton = Color(light: 0x202522, dark: 0x2F8A6A)
        public static let warning = Color(light: 0xB66E65, dark: 0xD98A80)
    }

    // MARK: - Typography
    public enum Fonts {
        public static func sfProBold(_ size: CGFloat) -> Font {
            .system(size: size, weight: .bold, design: .default)
        }

        public static func sfProRegular(_ size: CGFloat) -> Font {
            .system(size: size, weight: .regular, design: .default)
        }

        public static func notoBold(_ size: CGFloat) -> Font {
            .system(size: size, weight: .bold, design: .default)
        }

        public static func notoRegular(_ size: CGFloat) -> Font {
            .system(size: size, weight: .regular, design: .default)
        }
    }

    // MARK: - Radii
    public enum Radii {
        public static let card: CGFloat = 18
        public static let capsule: CGFloat = 999
        public static let button: CGFloat = 20
        public static let iconBox: CGFloat = 12
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1.0) {
        let red = Double((hex >> 16) & 0xFF) / 255.0
        let green = Double((hex >> 8) & 0xFF) / 255.0
        let blue = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: red, green: green, blue: blue, opacity: alpha)
    }
}

extension Color {
    /// 随系统浅色/深色模式自动切换
    init(light: UInt32, dark: UInt32, lightAlpha: Double = 1, darkAlpha: Double = 1) {
        self.init(uiColor: UIColor { traits in
            let isDark = traits.userInterfaceStyle == .dark
            let hex = isDark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: isDark ? darkAlpha : lightAlpha
            )
        })
    }
}

// MARK: - Liquid Glass surfaces
public extension View {
    func glassCapsule(isSelected: Bool = false) -> some View {
        glassEffect(
            Glass.clear.tint(isSelected ? DesignTokens.Colors.accentGreen.opacity(0.18) : DesignTokens.Colors.glassFrost),
            in: Capsule()
        )
    }

    func glassCard(cornerRadius: CGFloat = 18, fillColor: Color? = nil) -> some View {
        glassEffect(
            Glass.clear.tint(fillColor?.opacity(0.3) ?? DesignTokens.Colors.glassFrost),
            in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        )
    }

    func glassCircle() -> some View {
        glassEffect(Glass.clear.tint(DesignTokens.Colors.glassFrost), in: Circle())
    }
}

public extension View {
    func cardSurface(cornerRadius: CGFloat = 18) -> some View {
        background(DesignTokens.Colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .shadow(color: Color.black.opacity(0.03), radius: 6, x: 0, y: 2)
    }
}
