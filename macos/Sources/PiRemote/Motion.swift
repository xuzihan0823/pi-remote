import AppKit
import SwiftUI

enum Motion {
    static let entrance = Animation.easeOut(duration: 0.24)
    static let modeSwitch = Animation.easeInOut(duration: 0.18)
    static let press = Animation.easeOut(duration: 0.09)
    static let release = Animation.easeOut(duration: 0.14)
    static let hover = Animation.easeOut(duration: 0.12)
    static let success = Animation.easeOut(duration: 0.22)
    static let crossfade = Animation.easeInOut(duration: 0.16)
    static let disclosure = Animation.easeInOut(duration: 0.2)
    static let feedback = Animation.easeOut(duration: 0.12)
    static let routeCycle: TimeInterval = 1.4

    /// Reduce Motion keeps only short fades; movement and scaling are dropped.
    static func resolved(_ animation: Animation, reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeOut(duration: 0.1) : animation
    }
}

/// Reports whether the hosting window is actually visible (not closed, minimised or fully occluded),
/// so looping animations can pause. `scenePhase` alone does not track window occlusion on macOS.
struct WindowVisibilityReader: NSViewRepresentable {
    @Binding var isVisible: Bool

    func makeNSView(context: Context) -> NSView {
        let view = TrackingView()
        view.onChange = { visible in
            DispatchQueue.main.async {
                if isVisible != visible { isVisible = visible }
            }
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}

    final class TrackingView: NSView {
        var onChange: ((Bool) -> Void)?
        private var observers: [NSObjectProtocol] = []

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            observers.forEach(NotificationCenter.default.removeObserver)
            observers.removeAll()
            guard let window else {
                onChange?(false)
                return
            }
            let names: [Notification.Name] = [
                NSWindow.didChangeOcclusionStateNotification,
                NSWindow.didMiniaturizeNotification,
                NSWindow.didDeminiaturizeNotification,
                NSWindow.willCloseNotification,
            ]
            for name in names {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] note in
                    if note.name == NSWindow.willCloseNotification {
                        self?.onChange?(false)
                    } else {
                        self?.report()
                    }
                })
            }
            report()
        }

        private func report() {
            guard let window else { return }
            onChange?(window.occlusionState.contains(.visible) && !window.isMiniaturized)
        }

        deinit {
            observers.forEach(NotificationCenter.default.removeObserver)
        }
    }
}
