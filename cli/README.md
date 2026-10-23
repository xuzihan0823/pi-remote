# Pi Remote CLI

独立于 macOS 控制面板的启动器。首次配置后，执行 `pi-remote start`，自动启动所选后端、建立 Cloudflare Quick Tunnel，连接检查通过后显示手机配对二维码。

## 安装

需要 Node.js 24+。安装 `cloudflared` 并确保其在 PATH 中；Pi 也支持连接已有 Relay，此模式无需 cloudflared。Pi 模式需要 PATH 中可用的 `pi` 命令；Claude 模式需要已安装并登录的 Claude CLI。第一版支持 macOS 和 Linux，Windows 使用 WSL。

在仓库目录安装构建依赖：

```bash
npm --prefix cli install
```

生成独立安装包：

```bash
npm --prefix cli pack --pack-destination .
```

安装生成的包后，不再需要在仓库目录执行命令：

```bash
npm install -g ./pi-remote-cli-0.1.0.tgz
```

安装包包含编译后的启动器、Pi Relay/Agent 和 Claude 后端；不需要 Swift、Xcode 或 Pi Remote.app。不会发布到 npm。

## 使用

```bash
pi-remote start
```

首次选择 `pi`、`claude` 或 `all`，填写必要路径及端口，配置自动保存。两种服务使用各自的手机端扫码连接。

```bash
pi-remote configure
```

```bash
pi-remote start --service claude
```

```bash
pi-remote start --config /绝对路径/config.json
```

```bash
pi-remote --help
```

CLI 在前台运行，Ctrl+C 停止本次启动的后端和隧道。关闭终端也会触发清理。不会停止占用端口的其他服务。运行前请先退出仍在使用同一端口的旧 Pi Remote 控制面板。

Quick Tunnel 每次重启地址都会改变，需要重新扫码；连接凭据在配置中保持不变。只在交互终端显示二维码，重定向日志时不会输出二维码或带凭据的链接。若已有固定 Relay，可以在 `configure` 中选择 `relay` 并输入 `wss://服务器/ws/agent` 和服务器凭据。

### Pi

Pi Agent 通过本机 `pi` 命令管理会话（RPC 托管会话、终端共享会话与历史恢复）。CLI 启动前会检查 `pi` 是否在 PATH 中。

### 配置与数据

macOS 配置位于 `~/Library/Application Support/Pi Remote/CLI/config.json`，其他平台位于 `${XDG_CONFIG_HOME:-~/.config}/pi-remote/config.json`。配置目录新建时使用 700，文件使用 600；文件包含凭据，请勿分享或提交。显式 `--config` 指定的已有父目录不会被修改权限。CLI 不自动读取当前目录的 `.env`，也不覆盖 macOS App 配置。

Claude 默认继续使用原来的会话目录及 Remote 数据目录；不迁移会话数据。不要让两个 Claude 后端同时使用同一个数据目录。

`PI_REMOTE_CLOUDFLARED` 可指定 cloudflared 的路径。代理使用当前终端环境；CLI 不自动读取 macOS 系统代理设置。

## 开发验证

```bash
npm --prefix cli run build
```

```bash
npm --prefix cli run typecheck
```

```bash
npm --prefix cli test
```

测试使用临时配置、本机假 HTTP/WS 服务及假子进程，不调用真实模型或建立公网隧道。

独立安装验证会在临时目录安装本地 tgz，从仓库外运行命令，并检查真实 Claude 后端的健康端点和退出；不发送模型任务：

```bash
npm --prefix cli run verify:package
```

