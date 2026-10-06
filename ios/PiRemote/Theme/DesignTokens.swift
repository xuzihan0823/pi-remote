import SwiftUI

public enum DesignTokens {
    // MARK: - Colors
    public enum Colors {
        public static let background = Color(hex: 0xF7F8F5)
        public static let surface = Color.white
        public static let textPrimary = Color(hex: 0x202522)
        public static let textSecondary = Color(hex: 0x777E79)
        public static let textPlaceholder = Color(hex: 0x949B95)
        public static let accentGreen = Color(hex: 0x216B52)
        public static let textOnGreen = Color.white

        public static let glassLight = Color(hex: 0xF0F3EC)
        public static let glassMedium = Color(hex: 0xE8EEE6)
        public static let glassMediumAlt = Color(hex: 0xEAEEE8)
        public static let glassCard = Color(hex: 0xDFE5DF)
        public static let glassCardSelected = Color(hex: 0xE1EAE3)

        public static let divider = Color(hex: 0xE4E8E1)

        public static let diffAdd = Color(hex: 0x216B52)
        public static let diffRemove = Color(hex: 0xB66E65)

        public static let darkButton = Color(hex: 0x202522)
        public static let warning = Color(hex: 0xB66E65)
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

// MARK: - Liquid Glass surfaces
public extension View {
    func glassCapsule(isSelected: Bool = false) -> some View {
        glassEffect(
            isSelected ? Glass.regular.tint(DesignTokens.Colors.accentGreen.opacity(0.16)) : .regular,
            in: Capsule()
        )
    }

    func glassCard(cornerRadius: CGFloat = 18, fillColor: Color? = nil) -> some View {
        glassEffect(
            fillColor.map { Glass.regular.tint($0.opacity(0.35)) } ?? .regular,
            in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        )
    }

    func glassCircle() -> some View {
        glassEffect(.regular, in: Circle())
    }
}

public extension View {
    func cardSurface(cornerRadius: CGFloat = 18) -> some View {
        background(DesignTokens.Colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .shadow(color: Color.black.opacity(0.03), radius: 6, x: 0, y: 2)
    }
}
