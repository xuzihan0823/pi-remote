# pi-remote 复核记录

复核日期：2026-09-16。范围为 `PROGRESS.md` 中的安装器收尾要求、部署文档，以及工作区尚未提交的 iOS 客户端。基线提交为 `03d3428`。

结论：复核已完成，确认 10 个需要修复的问题，其中 P1 共 5 个、P2 共 5 个。正常构建和安装能够完成，当前版本尚未通过生产部署及 iOS MVP 行为验收。本轮仅调整部署说明和真机签名配置，以下功能问题仍待修复。

验证结果：

| 检查 | 结果与范围 |
| --- | --- |
| TypeScript | `npm run typecheck` 通过。 |
| 现有自动化测试 | `npm test`：92 通过、1 个 live pi 测试按配置跳过、0 失败。 |
| Shell | Bash 语法检查通过；真实 Debian 12 / arm64 / Bash 5.2.15 环境运行成功。 |
| Linux 安装 | 使用隔离 Docker 29.8.1，执行未修改的生产安装器；external-proxy 首装、升级、Token 保留、0600 权限和备份轮换通过。实际端口映射为 `127.0.0.1:19189 → 8789`，容器内 `/api/health` 检查通过。 |
| Linux 失败场景 | 复现下列 5 个安装器问题。复制、镜像恢复和解包失败使用临时命令包装注入；Docker 构建、Compose、容器和备份操作均实际执行。 |
| 备份解包失败 | 注入 `tar -xzf` 失败后，安装器以退出码 75 结束，没有打印恢复成功；此项失败返回符合预期。 |
| Xcode | Xcode 27.0 的新许可未确认曾导致构建失败；用户完成许可确认和首次初始化后，构建恢复。 |
| iOS 构建 | 模拟器编译通过；按用户后续要求改为真机，Debug iphoneos 签名构建通过，签名团队已写入工程，去掉命令行团队覆盖后再次构建通过。 |
| Swift 协议验证 | 使用原始 `RelayClient.swift`、`Models.swift` 和真实 Relay，在 Mac 上注入协议事件，复现下列 5 个 iOS 问题；没有发送真实 pi prompt。 |
| 真机安装 | `com.piremote.app` 已安装到用户的 iPhone 17（iOS 27.0）。本地签名验证通过，描述文件包含该设备；用户已完成开发者信任。2026-09-17 USB 连接恢复后，扫码与帮助修复版安装和启动成功，真机截图确认首页正常显示。 |

安装器问题：

1. **P1：目标目录内部的符号链接可使升级覆盖目录外文件。** 位置：[install-server.sh:299](/Users/mac/Desktop/pi-remote/scripts/install-server.sh:299)。预检只排除安装路径组件的符号链接，最终 `cp -r` 仍会跟随目标中的 `.env` 文件链接。真实 Linux 演练将受管目录的 `.env` 指向目录外测试文件，升级退出码为 0，目录外文件被覆盖，链接仍然存在。备份只保存链接，不能恢复被改写的外部文件。应在写入前检查目标文件及子目录的链接边界，或采用经过校验的整目录切换。

2. **P1：文件复制中途失败不会回滚。** 位置：[install-server.sh:298](/Users/mac/Desktop/pi-remote/scripts/install-server.sh:298)。暂存文件写入安装目录时受 `set -e` 控制，但退出处理仅清理暂存目录。模拟复制一个新文件后失败，安装器退出码为 73，目标保留新旧混合内容，没有触发回滚；新构建的 `latest` 标签也已生效。应将目录切换及之后的所有失败纳入统一恢复路径，恢复目录与镜像后明确报告结果。

3. **P1：旧镜像恢复失败被忽略，仍然报告恢复成功。** 位置：[install-server.sh:277](/Users/mac/Desktop/pi-remote/scripts/install-server.sh:277)。回滚中的 `docker tag ... || true` 吞掉失败，随后继续使用 `latest` 启动。演练先构建不同的新镜像，再注入恢复标签失败；最终容器仍使用新镜像，终端却打印“受管目录已恢复为更新前状态”。应检查镜像恢复结果，失败时停止后续启动并报告回滚失败，恢复成功后核对容器镜像与健康状态。

4. **P2：回滚遗漏新增加的隐藏文件。** 位置：[install-server.sh:274](/Users/mac/Desktop/pi-remote/scripts/install-server.sh:274)。`rm -rf "$INSTALL_DIR"/*` 不匹配隐藏项。用缺少 `.dockerignore` 的旧受管目录升级并触发健康检查失败，旧 `.env` 被还原，但新加入的 `.dockerignore` 仍然保留。应清理受管目录中的全部条目，恢复后确认不存在备份之外的残留。

5. **P2：已有本项目容器会让无关端口占用通过预检。** 位置：[server-preflight.sh:249](/Users/mac/Desktop/pi-remote/scripts/lib/server-preflight.sh:249)、[server-preflight.sh:259](/Users/mac/Desktop/pi-remote/scripts/lib/server-preflight.sh:259)。当前代码只检查本项目容器是否存在，没有确认它实际占用了被检查的端口。演练中 Relay 占用 19189，另一个独立进程占用 19190；升级指定 19190 的 dry-run 仍返回 0。实际升级会在修改镜像和目录后才遭遇端口冲突。应同时核对 Compose 项目、工作目录及该端口的实际绑定；其他进程占用必须拒绝。

iOS 问题：

6. **P1：重连后没有恢复当前会话订阅。** 位置：[RelayClient.swift:425](/Users/mac/Desktop/pi-remote/ios/PiRemote/Services/RelayClient.swift:425)、[ConversationView.swift:79](/Users/mac/Desktop/pi-remote/ios/PiRemote/Views/ConversationView.swift:79)。断线会使 Relay 清除旧连接订阅，客户端仍保留 `activeSessionId`。新握手只刷新列表，视图又因活动 ID 未变化而跳过订阅。实测自动重连后连接显示成功，但服务端订阅数为 0，新发送的事件也收不到。应在每次新握手后重新订阅活动会话，并确认订阅成功。这与已知的“断线期间事件不重放”是两个不同问题。

7. **P1：开始输出文字后停止按钮失效。** 位置：[RelayClient.swift:54](/Users/mac/Desktop/pi-remote/ios/PiRemote/Services/RelayClient.swift:54)、[RelayClient.swift:512](/Users/mac/Desktop/pi-remote/ios/PiRemote/Services/RelayClient.swift:512)。`isSessionRunning` 只根据思考状态和工具步骤判断，首个 `text_delta` 就将 `isThinking` 清为 false。实测尚未收到 `agent_settled`，`isSessionRunning` 已为 false；视图因此将停止按钮换成发送按钮，菜单的中止操作也被禁用。应单独维护整个回合的执行状态，直到 settled、退出或明确失败时再结束。

8. **P2：会话列表将空闲 pi 进程计为运行中的任务。** 位置：[Models.swift:77](/Users/mac/Desktop/pi-remote/ios/PiRemote/Models/Models.swift:77)、[SessionsView.swift:193](/Users/mac/Desktop/pi-remote/ios/PiRemote/Views/SessionsView.swift:193)。后端 `state=running` 表示进程存活，任务完成后进程仍常驻。实测客户端已经收到 `agent_settled`，列表仍显示 running，“进行中”计数不会归零。应区分进程状态与回合状态，按回合事件维护任务状态；无法恢复的历史状态应明确显示未知。

9. **P2：input/editor 对话框没有输入控件，确认响应缺少 value。** 位置：[ConversationView.swift:395](/Users/mac/Desktop/pi-remote/ios/PiRemote/Views/ConversationView.swift:395)、[RelayClient.swift:353](/Users/mac/Desktop/pi-remote/ios/PiRemote/Services/RelayClient.swift:353)。客户端接收 input/editor，但没有选项时统一显示确认按钮并发送 `confirmed: true`。实测 input 请求的响应没有 `value`，扩展无法取得用户输入。应按对话类型展示输入/编辑控件并发送相应文本；暂不支持的类型应明确提示并正确取消。

10. **P2：Agent 断开后仍显示 Mac 在线。** 位置：[RelayClient.swift:452](/Users/mac/Desktop/pi-remote/ios/PiRemote/Services/RelayClient.swift:452)。`agentConnected` 只在握手或 iOS 连接断开时更新，收到 `agent_disconnected` 仅设置错误文案。实测 Relay 的 `hasAgent=false`，客户端也收到断线错误，但 `agentConnected` 仍为 true。应处理 Agent 状态事件，并在刷新或恢复连接时同步实际在线状态。

既有待办仍包括 Keychain 安全存储、真实配对流程、会话历史恢复和真实模型端到端联调。standalone 的公网 TLS、外部 Docker 代理网络模式、其他发行版及 x86_64 未在本次真实 Linux 演练中覆盖。

后续根据真机反馈修复扫码与帮助入口：接入相机扫码、连接信息校验及确认页，并将帮助改为独立教程页。具体范围及验证状态见 [PROGRESS.md](PROGRESS.md) 第 9 节；上述 10 个复核问题的状态不受此次入口修复影响。

部署文档已收窄发行版列表，并移除“原子回滚”和保证保留日志的表述。真机产物位于 `/tmp/pi-remote-review-device-build/Build/Products/Debug-iphoneos/PiRemote.app`；当前开发描述文件有效期至 2026-09-23 19:30（北京时间）。验证日志、隔离复现脚本和结构化结果保留在 `/tmp/pi-remote-review.VubdFa/`，测试容器、测试卷及临时模拟设备已清理。
