# pi-remote 服务端部署指南

本文档介绍 `pi-remote` 服务端（Relay）的部署架构、使用方式以及注意事项。

## 部署模式

`scripts/install-server.sh` 提供了两种安装模式：

1. **standalone（独立模式，默认/推荐全托管模式）**
   - 自动启动包含 `pi-remote-relay` 和 `pi-remote-caddy` 容器的 Docker Compose 栈。
   - Caddy 绑定宿主机 `80` 与 `443` 端口，自动申请并管理 Let's Encrypt / ZeroSSL 证书。
   - Caddy 与 Relay 运行在独立的容器网络 `pi_remote_net` 中，Caddy 内部代理至 `relay:8789`（非容器内部 localhost）。
   - 证书与状态由 Docker 命名卷 `caddy_data` 和 `caddy_config` 持久化管理，升级服务或容器时证书状态不会丢失。

2. **external-proxy（外部反向代理模式）**
   - 仅启动 `pi-remote-relay` 容器。
   - 默认模式：Relay 暴露端口映射到宿主机 `127.0.0.1:<PORT>`（默认 8789），供宿主机上的反向代理（如已有的 Nginx / Caddy）转发：
     ```caddy
     <domain> {
         encode zstd gzip
         reverse_proxy 127.0.0.1:8789
     }
     ```
   - 若指定了 `--proxy-network <network_name>`：Relay 加入该外部 Docker 网络并通过服务名暴露端口，外部 Docker 反代容器可通过容器名访问：
     ```caddy
     <domain> {
         encode zstd gzip
         reverse_proxy pi-remote-relay:8789
     }
     ```
   - 安装脚本**绝不会**主动覆盖宿主机已有的 Caddy/Nginx 配置，反代配置需由管理员自行添加到现有代理配置中。

## 命令行安装参数

安装脚本直接在源码目录下运行（不依赖虚构的远程 curl 管道）：

```bash
sudo ./scripts/install-server.sh --domain <域名> [选项]
```

参数列表：
- `--domain <domain>`: **必填**。用于反向代理配置和证书绑定的域名。
- `--mode <standalone|external-proxy>`: 运行模式，默认为 `standalone`。
- `--install-dir <path>`: 目标安装路径，默认为 `/opt/pi-remote`。
- `--port <port>`: 宿主机暴露端口（在 external-proxy 无外部网络模式下映射至宿主机该端口，默认 8789）。
- `--proxy-network <network>`: 可选。指定外部 Docker 网络名称（仅 external-proxy 模式支持）。
- `--dry-run`: 预检与配置演练，打印执行计划，**不创建目录、不写文件、不执行构建与启动**。
- `--help`: 打印帮助信息。

## 目录所有权与管理标记

安装程序会在安装目录下维护 `.pi-remote-managed` 标记文件，其内容严格为：
```
pi-remote-installer-v1
```
- 若目标目录已存在但缺少此文件或标记不符，安装脚本会拒绝修改该目录以防误覆写非本程序的数据。
- 目标路径不允许为符号链接。

## 升级、备份与回滚机制

- **备份**：对已有的受管安装目录执行更新时，安装脚本在变更前会使用 `tar` 打包该目录内的配置与源码并计算 SHA256 校验和。只有在当前项目的新备份通过完整性校验后，才会清理旧备份文件。Docker 命名卷不包含在此目录备份中。
- **Token 保持**：`RELAY_TOKEN`（32字符以上）在首次安装时由 `openssl rand -hex 32` 随机生成并写入 `.env`（权限 `0600`）。在升级时，脚本自动读取并保留既有 Token，且终端输出绝不打印 Token 密钥本身。
- **构建与镜像隔离**：构建新镜像前，原有的 `pi-remote-relay:latest` 会被标记为备份标签 `pi-remote-relay:rollback-backup`。
- **目录整体替换**：新版本先在安装目录的同级暂存目录中完整生成，镜像构建成功后再用 `mv` 整体替换旧目录。安装器不会向旧目录写入文件，因此不会跟随其中的符号链接���受管目录中的 `.env` 若为符号链接，安装器直接拒绝。
- **健康检查与失败恢复**：服务以 `--force-recreate` 启动后，通过容器内 Node.js 探测 `http://127.0.0.1:8789/api/health`。替换目录后任何一步失败（包括目录替换、Compose 启动、健康检查）都会进入统一回滚：
  - 停止新服务，把旧目录整体换回（不会残留新版本新增的文件，包括隐藏文件）；
  - 把更新前的镜像 ID 重新标记为 `latest`，失败则不启动服务并报告回滚失败；
  - 启动旧服务，核对容器镜像确为更新前镜像并重新做健康检查，全部通过才报告恢复成功，否则以退出码 76 结束并提示人工处理；
  - 初次安装若启动失败，则停止新创建的服务并保留目录诊断现场。

2026-09-16 复核记录中的安装器问题 1–5 已按上述机制修复，并有对应回归测试（`tests/server-install.test.ts`、`tests/server-preflight.test.ts`，使用 Docker 桩）。真实 Linux + Docker 环境下的失败回滚尚未重新演练。

## 操作系统支持

- 预检接受 Ubuntu、Debian、Rocky Linux、AlmaLinux、Fedora，CPU 架构为 x86_64/amd64 或 aarch64/arm64。本次真实安装演练覆盖 Debian 12 / arm64，其余环境仍需验证。
- 需预先安装 Docker 与 Docker Compose（脚本不会擅自执行全局系统软件源更新或全自动全局 prune）。
- DNS 说明：安装脚本仅检查本地环境与健康检查接口，不自动配置公共 DNS。用户必须保证所用域名已正确解析到本机公网 IP。本地健康检查成功并不代表公共 DNS 或公网 TLS 已经立即可达。
