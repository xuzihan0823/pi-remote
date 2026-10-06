import AVFoundation
import SwiftUI
import VisionKit

struct ConnectionScannerView: View {
    let deviceName: String
    var onScanned: (ConnectionConfig) -> Void
    var onManualConnection: () -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @State private var cameraState = CameraState.checking
    @State private var scanError: String?
    @State private var isFinished = false

    private enum CameraState {
        case checking, ready, denied, restricted, unsupported, unavailable
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if cameraState == .ready {
                QRCodeCamera(
                    isActive: scenePhase == .active && !isFinished,
                    onPayload: readPayload,
                    onUnavailable: { cameraState = .unavailable }
                )
                .ignoresSafeArea()
            }

            VStack(spacing: 24) {
                HStack {
                    Text("扫码连接 Mac")
                        .font(DesignTokens.Fonts.notoBold(20))
                    Spacer()
                    Button {
                        isFinished = true
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 16, weight: .semibold))
                            .frame(width: 44, height: 44)
                            .glassCircle()
                    }
                    .accessibilityLabel("关闭扫码器")
                }

                Spacer()

                if cameraState == .ready {
                    Image(systemName: "viewfinder")
                        .font(.system(size: 220, weight: .ultraLight))
                        .foregroundStyle(.white.opacity(0.85))
                        .accessibilityHidden(true)
                        .allowsHitTesting(false)
                } else {
                    cameraStatus
                }

                Spacer()

                VStack(spacing: 18) {
                    if cameraState == .ready {
                        Text(scanError ?? "将镜头对准 Mac 上的连接二维码")
                            .font(DesignTokens.Fonts.notoRegular(15))
                            .multilineTextAlignment(.center)
                            .accessibilityAddTraits(.updatesFrequently)
                    }
                    Button {
                        isFinished = true
                        onManualConnection()
                    } label: {
                        Text("手动连接")
                            .font(DesignTokens.Fonts.notoBold(15))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 16)
                            .glassCapsule()
                    }
                }
                .padding(20)
                .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 24))
            }
            .padding(24)
            .foregroundStyle(.white)
        }
        .preferredColorScheme(.dark)
        .task {
            if DataScannerViewController.isSupported,
               AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
                _ = await AVCaptureDevice.requestAccess(for: .video)
            }
            guard !Task.isCancelled else { return }
            refreshCameraState()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { refreshCameraState() }
        }
    }

    @ViewBuilder
    private var cameraStatus: some View {
        VStack(spacing: 18) {
            if cameraState == .checking {
                ProgressView("正在准备相机…")
                    .tint(.white)
            } else {
                Image(systemName: "camera")
                    .font(.system(size: 40, weight: .light))
                Text(cameraMessage)
                    .font(DesignTokens.Fonts.notoRegular(16))
                    .multilineTextAlignment(.center)

                if cameraState == .denied {
                    Button("前往设置开启相机") {
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            openURL(url)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(DesignTokens.Colors.accentGreen)
                } else if cameraState == .unavailable {
                    Button("重试") { refreshCameraState() }
                        .buttonStyle(.bordered)
                }
            }
        }
    }

    private var cameraMessage: String {
        switch cameraState {
        case .denied:
            return "需要相机权限才能扫描连接二维码。\n你也可以手动输入连接信息。"
        case .restricted:
            return "此设备的相机使用受到限制，\n请手动输入连接信息。"
        case .unsupported:
            return "此设备暂不支持相机扫码，\n请手动输入连接信息。"
        case .unavailable:
            return "暂时无法打开相机，\n请重试或手动输入连接信息。"
        case .checking, .ready:
            return ""
        }
    }

    private func refreshCameraState() {
        guard DataScannerViewController.isSupported else {
            cameraState = .unsupported
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            cameraState = DataScannerViewController.isAvailable ? .ready : .unavailable
        case .denied:
            cameraState = .denied
        case .restricted:
            cameraState = .restricted
        case .notDetermined:
            cameraState = .checking
        @unknown default:
            cameraState = .unavailable
        }
    }

    private func readPayload(_ payload: String) -> Bool {
        guard !isFinished, scenePhase == .active else { return false }
        do {
            let config = try ConnectionQRCode.parse(payload, deviceName: deviceName)
            isFinished = true
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onScanned(config)
            return true
        } catch {
            scanError = error.localizedDescription
            return false
        }
    }
}

private struct QRCodeCamera: UIViewControllerRepresentable {
    var isActive: Bool
    var onPayload: (String) -> Bool
    var onUnavailable: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isGuidanceEnabled: false,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        context.coordinator.parent = self
        guard isActive else {
            scanner.stopScanning()
            context.coordinator.lastPayload = nil
            return
        }
        guard !scanner.isScanning, !context.coordinator.hasFinished else { return }
        do {
            try scanner.startScanning()
        } catch {
            DispatchQueue.main.async { onUnavailable() }
        }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
        scanner.delegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var parent: QRCodeCamera
        var lastPayload: String?
        var hasFinished = false

        init(parent: QRCodeCamera) {
            self.parent = parent
        }

        func dataScanner(_ scanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            read(addedItems, scanner: scanner)
        }

        func dataScanner(_ scanner: DataScannerViewController, didUpdate updatedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            read(updatedItems, scanner: scanner)
        }

        func dataScanner(_ scanner: DataScannerViewController, didRemove removedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            if allItems.isEmpty { lastPayload = nil }
        }

        func dataScanner(_ scanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
            scanner.stopScanning()
            parent.onUnavailable()
        }

        private func read(_ items: [RecognizedItem], scanner: DataScannerViewController) {
            guard parent.isActive, scanner.isScanning, !hasFinished else { return }
            for item in items {
                guard case .barcode(let barcode) = item,
                      let payload = barcode.payloadStringValue,
                      payload != lastPayload else { continue }
                lastPayload = payload
                if parent.onPayload(payload) {
                    hasFinished = true
                    scanner.stopScanning()
                    return
                }
            }
        }
    }
}
