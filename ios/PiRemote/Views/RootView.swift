import SwiftUI

public enum AppRoute: Hashable {
    case connect
    case newSession
    case conversation
}

public struct RootView: View {
    @State private var relayClient = RelayClient.shared
    @State private var route: AppRoute
    @State private var selectedSessionId: String?
    @State private var isSidebarOpen: Bool
    @State private var sidebarDrag: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(initialRoute: AppRoute = .connect) {
        _route = State(initialValue: Self.resolveInitialRoute(fallback: initialRoute))
        #if DEBUG
        _isSidebarOpen = State(initialValue: ProcessInfo.processInfo.environment["INITIAL_ROUTE"] == "sessions")
        #else
        _isSidebarOpen = State(initialValue: false)
        #endif
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
        case "sessions", "newSession": return .newSession
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
                    onConnected: { route = .newSession }
                )

            case .newSession, .conversation:
                mainContent
            }
        }
        .animation(.easeInOut(duration: 0.2), value: route)
        #if DEBUG
        .task { Self.autoConnectIfRequested(client: relayClient) }
        #endif
        .onChange(of: relayClient.isConnected) { _, isConnected in
            if case .failed = relayClient.state { return }
            if isConnected, route == .connect {
                route = .newSession
            }
        }
        .onChange(of: relayClient.activeSessionId) { _, id in
            if route == .conversation, let id { selectedSessionId = id }
        }
    }

    private var mainContent: some View {
        GeometryReader { proxy in
            let width = min(proxy.size.width * 0.86, 360)
            let offset = isSidebarOpen ? min(0, sidebarDrag) : -width
            let progress = 1 + offset / width

            ZStack(alignment: .leading) {
                Group {
                    if route == .conversation {
                        ConversationView(
                            client: relayClient,
                            session: relayClient.sessions.first { $0.id == selectedSessionId },
                            onSidebarTapped: { setSidebar(true) }
                        )
                    } else {
                        NewSessionView(
                            client: relayClient,
                            onSidebarTapped: { setSidebar(true) },
                            onStarted: { sessionId in
                                selectedSessionId = sessionId
                                route = .conversation
                            }
                        )
                    }
                }
                .accessibilityHidden(isSidebarOpen)

                Color.black
                    .opacity(0.28 * progress)
                    .ignoresSafeArea()
                    .allowsHitTesting(isSidebarOpen)
                    .onTapGesture { setSidebar(false) }
                    .accessibilityHidden(true)

                SessionsView(
                    client: relayClient,
                    onNewSessionTapped: {
                        route = .newSession
                        setSidebar(false)
                    },
                    onSessionSelected: { session in
                        relayClient.cancelSessionCreation()
                        relayClient.openSession(session)
                        selectedSessionId = session.id
                        route = .conversation
                        setSidebar(false)
                    },
                    onDisconnectTapped: {
                        setSidebar(false)
                        relayClient.disconnect()
                        route = .connect
                    },
                    onDeviceSwitched: {
                        selectedSessionId = nil
                        route = .newSession
                    }
                )
                .frame(width: width)
                .shadow(color: .black.opacity(isSidebarOpen ? 0.18 : 0), radius: 20, x: 4)
                .offset(x: offset)
                .allowsHitTesting(isSidebarOpen)
                .accessibilityHidden(!isSidebarOpen)
            }
            .simultaneousGesture(
                DragGesture(minimumDistance: 20)
                    .onChanged { value in
                        guard isSidebarOpen, abs(value.translation.width) > abs(value.translation.height) else { return }
                        sidebarDrag = value.translation.width
                    }
                    .onEnded { value in
                        guard isSidebarOpen else { return }
                        setSidebar(value.predictedEndTranslation.width > -width / 3)
                    },
                including: isSidebarOpen ? .all : .subviews
            )
        }
    }

    private func setSidebar(_ open: Bool) {
        withAnimation(reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.36, dampingFraction: 0.88)) {
            isSidebarOpen = open
            sidebarDrag = 0
        }
    }
}

#if DEBUG
#Preview("连接") {
    RootView()
}
#endif
