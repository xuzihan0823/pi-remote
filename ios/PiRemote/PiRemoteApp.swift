import SwiftUI

@main
struct PiRemoteApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
                .onReceive(NotificationCenter.default.publisher(for: RelayClient.historyCacheReset)) { _ in
                    Task { await MarkdownRenderCache.shared.clear() }
                }
        }
    }
}
