import SwiftUI

public enum AppRoute: Hashable {
    case connect
    case sessions
    case newSession
    case conversation
}

public struct RootView: View {
    @State private var relayClient = RelayClient.shared
    @State private var route: AppRoute
    @State private var selectedSessionId: String?

    public init(initialRoute: AppRoute = .connect) {
        _route = State(initialValue: Self.resolveInitialRoute(fallback: initialRoute))
        #if DEBUG
        _selectedSessionId = State(initialValue: ProcessInfo.processInfo.environment["SESSION_ID"])
        Self.seedDemoDataIfRequested(client: RelayClient.shared)
        #endif
    }

    #if DEBUG
    private static func autoConnectIfRequested(client: RelayClient) {
        let env = ProcessInfo.processInfo.environment
        guard env["AUTO_CONNECT"] == "1" else { return }
        let config = ConnectionConfig(
            serverUrl: env["RELAY_URL"] ?? client.config.serverUrl,
            token: env["RELAY_TOKEN"] ?? client.config.token,
            deviceName: env["RELAY_DEVICE"] ?? client.config.deviceName
        )
        guard !config.token.isEmpty else { return }
        client.connect(config: config)
    }
    #endif

    private static func resolveInitialRoute(fallback: AppRoute) -> AppRoute {
        #if DEBUG
        switch ProcessInfo.processInfo.environment["INITIAL_ROUTE"] {
        case "sessions": return .sessions
        case "newSession": return .newSession
        case "running", "approval", "done": return .conversation
        default: return fallback
        }
        #else
        return fallback
        #endif
    }

    #if DEBUG
    private static func seedDemoDataIfRequested(client: RelayClient) {
        guard let demo = ProcessInfo.processInfo.environment["DEMO_DATA"] else { return }
        let state: SessionStatus = demo == "approval" ? .approval : (demo == "done" ? .done : .running)
        client.seedDemoData(state: state, connected: true)
    }
    #endif

    public var body: some View {
        Group {
            switch route {
            case .connect:
                ConnectView(
                    client: relayClient,
                    onConnected: { route = .sessions }
                )

            case .sessions:
                SessionsView(
                    client: relayClient,
                    onNewSessionTapped: { route = .newSession },
                    onSessionSelected: { session in
                        relayClient.openSession(session)
                        selectedSessionId = session.id
                        route = .conversation
                    },
                    onDisconnectTapped: {
                        relayClient.disconnect()
                        route = .connect
                    }
                )

            case .newSession:
                NewSessionView(
                    client: relayClient,
                    onBackTapped: { route = .sessions },
                    onStarted: { sessionId in
                        selectedSessionId = sessionId
                        route = .conversation
                    }
                )

            case .conversation:
                ConversationView(
                    client: relayClient,
                    session: relayClient.sessions.first { $0.id == selectedSessionId },
                    onBackTapped: { route = .sessions }
                )
            }
        }
        .animation(.easeInOut(duration: 0.2), value: route)
        #if DEBUG
        .task { Self.autoConnectIfRequested(client: relayClient) }
        #endif
        .onChange(of: relayClient.isConnected) { _, isConnected in
            if case .failed = relayClient.state { return }
            if isConnected, route == .connect {
                route = .sessions
            }
        }
    }
}

#if DEBUG
#Preview("连接") {
    RootView()
}
#endif
