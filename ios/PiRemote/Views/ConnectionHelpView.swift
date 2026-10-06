import SwiftUI

struct ConnectionHelpView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Image(systemName: "book.closed")
                    .font(.system(size: 36, weight: .medium))
                    .foregroundStyle(DesignTokens.Colors.accentGreen)
                    .frame(width: 84, height: 84)
                    .glassCard(cornerRadius: 24)

                Text("教程即将上线")
                    .font(DesignTokens.Fonts.notoBold(22))
                    .foregroundStyle(DesignTokens.Colors.textPrimary)

                Text("连接设置、使用技巧和常见问题\n将在这里陆续更新。")
                    .font(DesignTokens.Fonts.notoRegular(15))
                    .foregroundStyle(DesignTokens.Colors.textSecondary)
                    .multilineTextAlignment(.center)
                    .lineSpacing(5)
            }
            .padding(28)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(DesignTokens.Colors.background)
            .navigationTitle("使用帮助")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }
}
