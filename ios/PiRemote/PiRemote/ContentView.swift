import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "terminal")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)

            Text("Pi Remote")
                .font(.largeTitle.bold())

            Text("远程连接你的 pi 会话")
                .font(.headline)

            Text("客户端准备中")
                .foregroundStyle(.secondary)
        }
        .padding(32)
    }
}
