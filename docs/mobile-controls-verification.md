# 手机模型、权限与问题回应验证记录

日期：2026-10-19。

## 交付

Desktop 补丁：[pi-desktop-mobile-controls.patch](patches/pi-desktop-mobile-controls.patch)。基线 `589e5803a7a9f4ebf7ec1e8849c43e44b4a198f7`（v0.21.0-beta.4），15 个文件（12 修改、3 新增），70932 字节。

SHA-256：`acea2113cb830d2d5f90f37d5885a4fcf6870a51727d02beba148ad2ee9aa2c5`。

已在源码工作区完成 `git apply --reverse --check`；另将补丁涉及的基线文件导出到全新临时目录，完成正向 `git apply --check` 和实际应用，15 个结果文件均与候选源码逐字节一致。没有在真实 Desktop 安装目录应用补丁，没有改变源工作区或 Git index。

## 检查结果

| 检查 | 实际结果 |
| --- | --- |
| TypeScript 类型检查 | 功能接入阶段通过；最后 handler 小修后子任务报告本地 tsc 通过，npm 脚本被审批拒绝 |
| Node 相关测试 | 主会话集成版本 38/38 通过；最后能力故障修复后 handler 12/12 通过（子任务报告）；更大组合复跑被审批拒绝 |
| Swift 行为回归 | DesktopControls、DesktopControlsClient、SessionCreation、SessionParsing、TerminalCallbackGuard 五套通过；最后回应门禁修复后 Client 与 SessionCreation 再次通过 |
| iOS 模拟器 build-for-testing | 最终回应门禁与 UI 定位修改后通过 |
| Rust session_set_model | 最终 strict-fields 版本 5/5 通过，覆盖保留其他设置、非法参数零更新、不存在、运行中、待审批计划 |
| Desktop Node | MCP 13、模型 IPC 8、pending scope 3 通过（子任务报告） |
| iPhone 17 / iOS 26.5 UI | 最终复跑 2 通过、1 失败，见下文 |
| 补丁应用与反向检查 | 通过，15 文件内容一致 |
| 完整 Desktop TypeScript 构建/相关 restore 测试 | 未运行；缺 i18next 等工作区依赖 |
| 真实 Desktop 安装/启动/模型联调 | 未执行；没有触碰正在使用的实例或真实模型 |
| 独立审查 | 两子任务因 429 未完成；恢复被审批拒绝，主会话完成部分只读审查并修复两项问题，不能记为独立安全审查通过 |

## 已修复的收尾问题

1. 手机收到交互失败后统一使控制快照失效，先查询新状态，再允许用户手动重试。超时不能声称未送达；保留答案和 pending，不自动重发。回归验证查询前再次点击零写入、查询仍待处理后才能重试。
2. Desktop 能力目录查询失败时，controls 返回错误；不再返回成功空 pending。会话列表同样标记 pending 状态未知，保留手机先前状态。真正旧版目录仍正常降级。

## UI 验收边界

最终复跑已通过：模型菜单切换 provider/model 并验证只写一次；正文读取失败时仍显示只读权限和待回应，并能提交 allow-once。

问答测试仍失败：多行输入框获得焦点后，XCTest 无法再次按 identifier 找到该控件（先前还报告 TextField/TextView 类型变化）。测试停在输入环节，未到达多题答案提交和失败保留断言，因此不能把完整问答 UI 路径记为通过。定位已改为不限定控件类型，仍未解决；后续需要读取该次失败截图及层级，判断是自动化识别问题还是界面生命周期问题。当前不据此断言生产问答一定损坏。

失败证据位于本机 `/tmp/pi-remote-mobile-controls-ui-final.xcresult`。导出附件和读取隔离 fixture `/state` 被自动审批拒绝，未继续绕过。大字体场景未执行；普通深色截图已检查模型/权限入口可见。

临时 UI 夹具应在验收结束停止。无部署、提交、推送、真实 Desktop 替换或真实模型调用。
