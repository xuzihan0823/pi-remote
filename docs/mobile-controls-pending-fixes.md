# 手机控制收尾状态（2026-10-19）

先前记录的两项可靠性问题均已修复并有定向回归：

- `RelayClient.swift`：所有交互失败先使 controls 确认失效并重新读取，失败前的旧快照不能解锁重试；保留 pending 与答案。
- `desktop-agent-handler.ts`：能力目录读取故障返回错误，不能用成功的空待处理快照撤销手机卡片；列表标记 pending 状态未知。

`docs/patches/response-reconcile-proposed.patch` 和 `controls-discovery-proposed.patch` 是修复前保存的历史提案。对应改动已并入源码，请勿再次应用。

Desktop 主补丁已导出并验证，见 [验证记录](mobile-controls-verification.md)。Rust 最终五项测试、Swift 定向回归和模拟器构建通过。

剩余未完成项是问答 UI 验收：最终三条测试中两条通过，问答测试在多行输入获得焦点后无法再次定位控件，尚未到达提交断言。修正为按 identifier 查询后仍失败；下一步需要检查 `/tmp/pi-remote-mobile-controls-ui-final.xcresult` 的截图与层级，确定是 XCTest 识别还是实际界面状态问题。附件导出与夹具状态读取被自动审批拒绝，未绕过。大字体验收未运行。

独立正确性/安全审查因 429 与后续调用拒绝未完成；完整 Desktop 构建缺依赖，真实 Desktop 联调未执行。
