import SwiftUI

struct StatusBadge: View {
    let text: String
    let tone: StatusTone

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: tone.symbol)
                .font(.system(size: 11, weight: .semibold))
            Text(text)
                .font(Theme.Font.caption.weight(.medium))
        }
        .foregroundColor(tone.color)
        .padding(.horizontal, 10)
        .frame(height: 26)
        .background(Capsule().fill(tone.color.opacity(0.12)))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("状态：\(text)")
    }
}

struct SectionTitle: View {
    let text: String

    var body: some View {
        Text(text)
            .font(Theme.Font.section)
            .foregroundColor(Theme.textPrimary)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Titled card that groups related settings; the title sits outside the card like macOS Settings.
struct SettingsGroup<Content: View>: View {
    var title: String? = nil
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title {
                Text(title)
                    .font(Theme.Font.caption.weight(.medium))
                    .foregroundColor(Theme.textSecondary)
                    .padding(.leading, 4)
                    .accessibilityAddTraits(.isHeader)
            }
            VStack(alignment: .leading, spacing: 16) { content }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: Theme.Radius.segment, style: .continuous).fill(Theme.canvas))
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.segment, style: .continuous).stroke(Theme.border, lineWidth: 1))
        }
    }
}

/// Fixed header for a settings pane: title plus an optional lock hint.
struct SettingsHeader: View {
    let title: String
    var lockedHint: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionTitle(text: title)
            if let lockedHint {
                Label(lockedHint, systemImage: "lock.fill")
                    .font(Theme.Font.caption)
                    .foregroundColor(Theme.textSecondary)
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 20)
        .padding(.bottom, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Label + control + help/error text. The control keeps its own focus binding for the ring.
struct InputField<Content: View>: View {
    let label: String
    var help: String? = nil
    var error: String? = nil
    var focused = false
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(Theme.Font.control)
                .foregroundColor(Theme.textPrimary)
            content
            if let error {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(Theme.Font.caption)
                    .foregroundColor(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            } else if let help {
                Text(help)
                    .font(Theme.Font.caption)
                    .foregroundColor(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .animation(Motion.feedback, value: error)
        .accessibilityElement(children: .contain)
    }
}

/// Styled single-line field box used by every text input in the sidebar.
struct FieldBox: ViewModifier {
    var focused: Bool
    var invalid: Bool
    @Environment(\.isEnabled) private var isEnabled

    func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .font(Theme.Font.body)
            .foregroundColor(Theme.textPrimary)
            .padding(.horizontal, 10)
            .frame(height: 38)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
                    .fill(isEnabled ? Theme.surface : Theme.surface.opacity(0.6))
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
                    .stroke(borderColor, lineWidth: focused || invalid ? 2 : 1)
            )
            .animation(Motion.hover, value: focused)
    }

    private var borderColor: Color {
        if invalid { return Theme.danger }
        if focused { return Theme.focusRing }
        return Theme.controlBorder.opacity(isEnabled ? 1 : 0.5)
    }
}

extension View {
    func fieldBox(focused: Bool, invalid: Bool = false) -> some View {
        modifier(FieldBox(focused: focused, invalid: invalid))
    }
}

/// Equal-width segmented choice with a sliding selection plate.
struct SegmentedChoice<Value: Hashable>: View {
    let options: [(value: Value, title: String)]
    @Binding var selection: Value
    var compact = false
    var accessibilityName: String
    @Namespace private var plate
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.value) { option in
                let selected = option.value == selection
                Button {
                    guard isEnabled, selection != option.value else { return }
                    withAnimation(Motion.resolved(Motion.modeSwitch, reduceMotion: reduceMotion)) {
                        selection = option.value
                    }
                } label: {
                    Text(option.title)
                        .font(compact ? Theme.Font.caption.weight(.medium) : Theme.Font.control)
                        .foregroundColor(selected ? Theme.textPrimary : Theme.textSecondary)
                        .frame(maxWidth: .infinity, minHeight: compact ? 28 : 32)
                        .background {
                            if selected {
                                RoundedRectangle(cornerRadius: Theme.Radius.segment - 3, style: .continuous)
                                    .fill(Theme.surface)
                                    .shadow(color: .black.opacity(0.06), radius: 2, y: 1)
                                    .matchedGeometryEffect(id: "plate", in: plate)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(option.title)
                .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
                .accessibilityHint(isEnabled ? "" : "当前不可修改")
            }
        }
        .padding(3)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.segment, style: .continuous)
                .fill(Theme.surfaceHover)
        )
        // System dimming of disabled plain buttons makes the selection unreadable; keep the
        // buttons drawn as enabled, block input above, and signal the lock with a light fade.
        .environment(\.isEnabled, true)
        .allowsHitTesting(isEnabled)
        .opacity(isEnabled ? 1 : 0.75)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityName)
    }
}

struct Notice: View {
    let title: String
    let message: String
    let tone: StatusTone
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: tone == .danger ? "exclamationmark.triangle.fill" : tone == .warning ? "exclamationmark.circle.fill" : "info.circle.fill")
                .foregroundColor(tone.color)
                .font(.system(size: 14))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(Theme.Font.control)
                    .foregroundColor(Theme.textPrimary)
                Text(message)
                    .font(Theme.Font.caption)
                    .foregroundColor(Theme.textSecondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if let actionTitle, let action {
                    Button(actionTitle, action: action)
                        .buttonStyle(LinkButtonStyle())
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
                .fill(tone.color.opacity(0.08))
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
                .stroke(tone.color.opacity(0.35), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }
}
