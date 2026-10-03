import SwiftUI

enum RouteState: Equatable {
    case idle, waiting, done, broken
}

/// "本机 Mac → 中转服务" route. Only the waiting state animates, and only while the window is visible.
struct ConnectionRouteView: View {
    let relayTitle: String
    let relaySymbol: String
    let state: RouteState
    let windowVisible: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showCheck = false

    var body: some View {
        HStack(spacing: 0) {
            node(symbol: "laptopcomputer", title: "本机 Mac", active: state != .idle)
            track
                .frame(height: 40)
                .padding(.horizontal, 12)
            node(symbol: relaySymbol, title: relayTitle, active: state == .done)
        }
        .frame(maxWidth: 440)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .onAppear { showCheck = state == .done }
        .onChange(of: state) { newValue in
            withAnimation(Motion.resolved(Motion.success, reduceMotion: reduceMotion)) {
                showCheck = newValue == .done
            }
        }
    }

    private func node(symbol: String, title: String, active: Bool) -> some View {
        VStack(spacing: 8) {
            ZStack {
                Circle()
                    .fill(active ? Theme.accent.opacity(0.14) : Theme.surfaceHover)
                Image(systemName: symbol)
                    .font(.system(size: 17, weight: .medium))
                    .foregroundColor(active ? Theme.accent : Theme.textSecondary)
            }
            .frame(width: 40, height: 40)
            Text(title)
                .font(Theme.Font.caption)
                .foregroundColor(Theme.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: 140)
        }
    }

    private var track: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let midY = 20.0
            ZStack(alignment: .leading) {
                Path { path in
                    path.move(to: CGPoint(x: 0, y: midY))
                    path.addLine(to: CGPoint(x: width, y: midY))
                }
                .stroke(lineColor, style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: state == .done ? [] : [4, 5]))

                if state == .waiting && windowVisible {
                    if reduceMotion {
                        Image(systemName: "ellipsis")
                            .foregroundColor(Theme.accent)
                            .position(x: width / 2, y: midY)
                    } else {
                        TimelineView(.animation) { context in
                            let t = context.date.timeIntervalSinceReferenceDate
                            let progress = t.truncatingRemainder(dividingBy: Motion.routeCycle) / Motion.routeCycle
                            Circle()
                                .fill(Theme.accent)
                                .frame(width: 8, height: 8)
                                .position(x: width * progress, y: midY)
                        }
                    }
                }

                if showCheck {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 18))
                        .foregroundColor(Theme.accent)
                        .background(Circle().fill(Theme.canvas).padding(-2))
                        .position(x: width / 2, y: midY)
                        .transition(.opacity)
                }
                if state == .broken {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundColor(Theme.danger)
                        .background(Circle().fill(Theme.canvas).padding(-2))
                        .position(x: width / 2, y: midY)
                }
            }
        }
    }

    private var lineColor: Color {
        switch state {
        case .idle: return Theme.border
        case .waiting: return Theme.accent.opacity(0.45)
        case .done: return Theme.accent
        case .broken: return Theme.danger.opacity(0.5)
        }
    }

    private var accessibilityText: String {
        switch state {
        case .idle: return "本机 Mac 到\(relayTitle)：未连接"
        case .waiting: return "本机 Mac 到\(relayTitle)：正在等待"
        case .done: return "本机 Mac 到\(relayTitle)：已确认"
        case .broken: return "本机 Mac 到\(relayTitle)：未完成"
        }
    }
}
