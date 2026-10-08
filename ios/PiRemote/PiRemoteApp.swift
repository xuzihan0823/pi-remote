import SwiftUI

@main
struct PiRemoteApp: App {
    @AppStorage(AppAppearance.storageKey) private var appearance = AppAppearance.system

    var body: some Scene {
        WindowGroup {
            RootView()
                .preferredColorScheme(appearance.colorScheme)
                .onReceive(NotificationCenter.default.publisher(for: RelayClient.historyCacheReset)) { _ in
                    Task { await MarkdownRenderCache.shared.clear() }
                }
        }
    }
}
