#!/usr/bin/env bash
set -euo pipefail

# scripts/install-server.sh - pi-remote 服务端一键安装/升级脚本

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 预检合约路径
PREFLIGHT_LIB="${SOURCE_DIR}/scripts/lib/server-preflight.sh"

show_help() {
  cat <<'EOF'
用法:
  install-server.sh --domain <domain> [选项]

选项:
  --domain <domain>           [必填] 服务绑定的域名
  --mode <mode>               部署模式: standalone (默认) | external-proxy
  --install-dir <dir>         安装目录 (默认: /opt/pi-remote)
  --port <port>               Relay 端口 (默认: 8789)
  --proxy-network <network>   外部 Docker 代理网络 (仅 external-proxy 模式可选)
  --dry-run                   仅演练并验证参数与环境，不修改系统、不写入文件、不构建
  --help                      显示帮助信息
EOF
}

DOMAIN=""
MODE="standalone"
INSTALL_DIR="/opt/pi-remote"
PORT="8789"
PROXY_NETWORK=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain|--mode|--install-dir|--port|--proxy-network)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || { echo "错误: $1 缺少参数" >&2; exit 1; } ;;
  esac
  case "$1" in
    --domain)
      DOMAIN="${2:-}"
      shift 2
      ;;
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="${2:-}"
      shift 2
      ;;
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --proxy-network)
      PROXY_NETWORK="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --help|-h)
      show_help
      exit 0
      ;;
    *)
      echo "错误: 未知参数 $1" >&2
      show_help
      exit 1
      ;;
  esac
done

if [[ -z "$DOMAIN" ]]; then
  echo "错误: 必须指定 --domain 参数" >&2
  show_help
  exit 1
fi

if [[ "$MODE" != "standalone" && "$MODE" != "external-proxy" ]]; then
  echo "错误: --mode 必须为 standalone 或 external-proxy (当前: $MODE)" >&2
  exit 1
fi

if [[ -n "$PROXY_NETWORK" && "$MODE" != "external-proxy" ]]; then
  echo "错误: --proxy-network 仅在 --mode external-proxy 模式下有效" >&2
  exit 1
fi

[[ -f "$PREFLIGHT_LIB" ]] || { echo "错误: 缺少预检模块" >&2; exit 1; }
source "$PREFLIGHT_LIB"
declare -F preflight_check >/dev/null || exit 1
preflight_check "$DOMAIN" "$MODE" "$INSTALL_DIR" "$PORT" "$PROXY_NETWORK" || exit 1

if [[ "$DRY_RUN" = true ]]; then
  echo "=== [DRY-RUN] 预检及演练计划 ==="
  echo "源码目录:     $SOURCE_DIR"
  echo "目标安装目录: $INSTALL_DIR"
  echo "域名:         $DOMAIN"
  echo "模式:         $MODE"
  echo "服务端口:     $PORT"
  if [[ -n "$PROXY_NETWORK" ]]; then
    echo "代理网络:     $PROXY_NETWORK"
  fi
  echo "状态说明:     --dry-run 模式下未修改系统、未创建目录、未写入文件。"
  exit 0
fi

umask 077

# 真实安装必须为 root (EUID == 0)
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "错误: 执行真实安装需要 root 权限，请使用 sudo 运行" >&2
  exit 1
fi

# 再次校验目标目录与符号链接（防御深度）
if [[ -L "$INSTALL_DIR" ]]; then
  echo "错误: 目标路径 $INSTALL_DIR 为符号链接，拒绝安装" >&2
  exit 1
fi

IS_UPGRADE=false
EXISTING_TOKEN=""
BACKUP_TAR=""

if [[ -d "$INSTALL_DIR" ]]; then
  MARKER_FILE="$INSTALL_DIR/.pi-remote-managed"
  if [[ ! -f "$MARKER_FILE" ]]; then
    echo "错误: 目标目录已存在但未发现管理标记 $MARKER_FILE，拒绝修改非本程序目录" >&2
    exit 1
  fi
  MARKER_VAL="$(cat "$MARKER_FILE" 2>/dev/null || true)"
  if [[ "$MARKER_VAL" != "pi-remote-installer-v1" ]]; then
    echo "错误: 目标目录管理标记不合法: '$MARKER_VAL'，拒绝操作" >&2
    exit 1
  fi
  IS_UPGRADE=true
  if [[ -f "$INSTALL_DIR/.env" ]]; then
    # 提取现有 RELAY_TOKEN
    EXISTING_TOKEN="$(grep -E '^RELAY_TOKEN=' "$INSTALL_DIR/.env" | cut -d'=' -f2- | tr -d '\r"' || true)"
  fi
fi

# 防止源码目录就是安装目录或源码被嵌套覆盖
CANONICAL_SRC="$(cd "$SOURCE_DIR" && pwd -P)"
if [[ "$IS_UPGRADE" = true ]]; then
  CANONICAL_DEST="$(cd "$INSTALL_DIR" && pwd -P)"
  if [[ "$CANONICAL_SRC" == "$CANONICAL_DEST" ]]; then
    echo "错误: 源码目录与安装目录相同 ($CANONICAL_SRC)，请在独立目录安装" >&2
    exit 1
  fi
fi

# 如果是升级，执行备份及校验
BACKUP_DIR="${PI_REMOTE_BACKUP_DIR:-/var/backups/pi-remote}"
PREV_BACKUP_MARKER="${BACKUP_DIR}/pi-remote-latest-backup.txt"
if [[ "$IS_UPGRADE" = true ]]; then
  [[ "$BACKUP_DIR" = /* && ! -L "$BACKUP_DIR" && "$BACKUP_DIR" != "$INSTALL_DIR"* ]] || exit 1
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  TIMESTAMP="$(date +%Y%m%d%H%M%S)"
  NEW_BACKUP="$(mktemp "${BACKUP_DIR}/pi-remote-backup-${TIMESTAMP}-XXXXXX").tar.gz"
  rm -f "${NEW_BACKUP%.tar.gz}"
  NEW_CHECKSUM="${NEW_BACKUP}.sha256"
  echo "正在对已有受管环境进行完整备份: $NEW_BACKUP ..."
  tar -czf "$NEW_BACKUP" -C "$INSTALL_DIR" .

  # 计算校验和并验证 tar 完整性
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$NEW_BACKUP" > "$NEW_CHECKSUM"
    if ! sha256sum -c "$NEW_CHECKSUM" >/dev/null 2>&1 || ! tar -tzf "$NEW_BACKUP" >/dev/null 2>&1; then
      echo "错误: 备份包校验失败，终止升级操作以保护现有系统" >&2
      rm -f "$NEW_BACKUP" "$NEW_CHECKSUM"
      exit 1
    fi
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$NEW_BACKUP" > "$NEW_CHECKSUM"
    if ! shasum -a 256 -c "$NEW_CHECKSUM" >/dev/null 2>&1 || ! tar -tzf "$NEW_BACKUP" >/dev/null 2>&1; then
      echo "错误: 备份包校验失败，终止升级操作以保护现有系统" >&2
      rm -f "$NEW_BACKUP" "$NEW_CHECKSUM"
      exit 1
    fi
  else
    if ! tar -tzf "$NEW_BACKUP" >/dev/null 2>&1; then
      echo "错误: 备份包校验失败，终止升级操作以保护现有系统" >&2
      rm -f "$NEW_BACKUP"
      exit 1
    fi
  fi
  BACKUP_TAR="$NEW_BACKUP"

  # 只有在新备份创建并验证成功后，才安全清理属于本项目的旧备份
  if [[ -f "$PREV_BACKUP_MARKER" ]]; then
    OLD_BACKUP_PATH="$(cat "$PREV_BACKUP_MARKER" 2>/dev/null || true)"
    if [[ "$OLD_BACKUP_PATH" == "$BACKUP_DIR"/pi-remote-backup-*.tar.gz && "${OLD_BACKUP_PATH%/*}" == "$BACKUP_DIR" && ! -L "$OLD_BACKUP_PATH" && -f "$OLD_BACKUP_PATH" && "$OLD_BACKUP_PATH" != "$NEW_BACKUP" ]]; then
      rm -f "$OLD_BACKUP_PATH" "${OLD_BACKUP_PATH}.sha256"
    fi
  fi
  echo "$NEW_BACKUP" > "$PREV_BACKUP_MARKER"
fi

if [[ "$IS_UPGRADE" = true && ( ${#EXISTING_TOKEN} -lt 32 || "$EXISTING_TOKEN" == *$'\n'* ) ]]; then
  echo "错误: 现有 Token 无效，拒绝自动轮换" >&2; exit 1
fi
# 决定 Token
FINAL_TOKEN=""
if [[ -n "$EXISTING_TOKEN" && ${#EXISTING_TOKEN} -ge 32 ]]; then
  FINAL_TOKEN="$EXISTING_TOKEN"
else
  if command -v openssl >/dev/null 2>&1; then
    FINAL_TOKEN="$(openssl rand -hex 32)"
  else
    FINAL_TOKEN="$(head -c 32 /dev/urandom | xxd -p -c 32)"
  fi
fi

# 暂存准备 stage 目录，避免在原地直接破坏
STAGE_DIR="$(mktemp -d "/tmp/pi-remote-stage.XXXXXX")"
cleanup_stage() {
  rm -rf "$STAGE_DIR"
}
trap cleanup_stage EXIT

echo "准备安装文件到暂存目录..."
mkdir -p "$STAGE_DIR/src"
cp -r "${SOURCE_DIR}/src/." "$STAGE_DIR/src/"
cp "${SOURCE_DIR}/package.json" "$STAGE_DIR/"
cp "${SOURCE_DIR}/package-lock.json" "$STAGE_DIR/"
cp "${SOURCE_DIR}/Dockerfile" "$STAGE_DIR/"
if [[ -f "${SOURCE_DIR}/.dockerignore" ]]; then
  cp "${SOURCE_DIR}/.dockerignore" "$STAGE_DIR/"
fi

# 生成目标 Compose 与配置
if [[ "$MODE" == "standalone" ]]; then
  cp "${SOURCE_DIR}/deploy/docker-compose.standalone.yml" "$STAGE_DIR/docker-compose.yml"
  sed "s/__DOMAIN__/${DOMAIN}/g" "${SOURCE_DIR}/deploy/Caddyfile.standalone" > "$STAGE_DIR/Caddyfile"
else
  if [[ -n "$PROXY_NETWORK" ]]; then
    sed "s/__PROXY_NETWORK__/${PROXY_NETWORK}/g" "${SOURCE_DIR}/deploy/docker-compose.external-proxy-network.yml" > "$STAGE_DIR/docker-compose.yml"
  else
    sed "s/__RELAY_PORT__/${PORT}/g" "${SOURCE_DIR}/deploy/docker-compose.external-proxy.yml" > "$STAGE_DIR/docker-compose.yml"
  fi
fi

# 写入 .env 文件
cat > "$STAGE_DIR/.env" <<EOF
RELAY_HOST=0.0.0.0
RELAY_PORT=8789
RELAY_TOKEN=${FINAL_TOKEN}
EOF
chmod 600 "$STAGE_DIR/.env"

# 写入受管标记
echo "pi-remote-installer-v1" > "$STAGE_DIR/.pi-remote-managed"

# 回滚函数定义
OLD_IMAGE_TAGGED=false
if docker image inspect pi-remote-relay:latest >/dev/null 2>&1; then
  docker tag pi-remote-relay:latest pi-remote-relay:rollback-backup
  OLD_IMAGE_TAGGED=true
fi

rollback() {
  echo "警告: 安装或健康检查未通过，正在触发安全回滚..." >&2
  if [[ "$IS_UPGRADE" = true && -n "$BACKUP_TAR" && -f "$BACKUP_TAR" ]]; then
    echo "正在还原受管目录文件..." >&2
    # 停止可能有问题的当前服务
    docker compose -p pi-remote -f "$INSTALL_DIR/docker-compose.yml" down || true
    rm -rf "${INSTALL_DIR:?}"/*
    tar -xzf "$BACKUP_TAR" -C "$INSTALL_DIR"
    if [[ "$OLD_IMAGE_TAGGED" = true ]]; then
      docker tag pi-remote-relay:rollback-backup pi-remote-relay:latest || true
    fi
    # 尝试恢复原服务
    docker compose -p pi-remote -f "$INSTALL_DIR/docker-compose.yml" up -d --remove-orphans || { echo "错误: 旧服务恢复失败，请人工恢复" >&2; return 1; }
    echo "受管目录已恢复为更新前状态。" >&2
  else
    echo "初次安装失败，停止运行容器并保留安装目录供故障诊断。" >&2
    if [[ -f "$INSTALL_DIR/docker-compose.yml" ]]; then
      docker compose -p pi-remote -f "$INSTALL_DIR/docker-compose.yml" down || true
    fi
  fi
}

# 镜像构建（在 stage 目录先构建，避免直接弄脏安装目录）
echo "正在构建 Docker 镜像 pi-remote-relay:latest ..."
if ! docker build -t pi-remote-relay:latest "$STAGE_DIR"; then
  echo "错误: Docker 镜像构建失败" >&2
  exit 1
fi

# 将暂存文件同步到目标目录
mkdir -p "$INSTALL_DIR"
cp -r "$STAGE_DIR/." "$INSTALL_DIR/"

# 启动 Docker Compose 服务
echo "正在启动服务 (Docker Compose 项目: pi-remote)..."
if ! docker compose -p pi-remote -f "$INSTALL_DIR/docker-compose.yml" up -d --remove-orphans; then
  rollback
  echo "错误: 服务启动失败" >&2
  exit 1
fi

# 健康检查验证
echo "正在等待服务就绪并执行健康检查..."
HEALTH_CHECK_CMD="fetch('http://127.0.0.1:8789/api/health',{signal:AbortSignal.timeout(3000)}).then(async r=>{if(!r.ok||(await r.json()).status!=='ok')process.exit(1)}).catch(()=>process.exit(1))"
MAX_RETRIES="${PI_REMOTE_HEALTH_RETRIES:-15}"
RETRY_INTERVAL="${PI_REMOTE_HEALTH_INTERVAL:-2}"
HEALTH_OK=false
for ((i=1; i<=MAX_RETRIES; i++)); do
  sleep "$RETRY_INTERVAL"
  if docker exec pi-remote-relay node -e "$HEALTH_CHECK_CMD" >/dev/null 2>&1; then
    HEALTH_OK=true
    break
  fi
done

if [[ "$HEALTH_OK" != true ]]; then
  echo "错误: 健康检查失败 (等待超时或 /api/health 未响应 200 OK)" >&2
  rollback
  exit 1
fi

echo "=================================================="
echo "🎉 pi-remote 服务端部署成功！"
echo "=================================================="
echo "安装目录:     $INSTALL_DIR"
echo "源码来源:     $SOURCE_DIR"
echo "运行模式:     $MODE"
echo "环境变量位置: $INSTALL_DIR/.env (权限: 0600, 请妥善保护)"
echo "常用运维命令:"
echo "  查看状态:   docker compose -p pi-remote -f $INSTALL_DIR/docker-compose.yml ps"
echo "  查看日志:   docker compose -p pi-remote -f $INSTALL_DIR/docker-compose.yml logs -f"
echo "  重启服务:   docker compose -p pi-remote -f $INSTALL_DIR/docker-compose.yml restart"
echo "  停止服务:   docker compose -p pi-remote -f $INSTALL_DIR/docker-compose.yml down"
echo "--------------------------------------------------"
if [[ "$MODE" == "standalone" ]]; then
  echo "对外服务地址: https://${DOMAIN}/"
  echo "提示: 请确保域名 ${DOMAIN} 的 DNS 已经正确解析到当前服务器的公网 IP，否则 Let's Encrypt / ZeroSSL 无法颁发证书。"
else
  if [[ -n "$PROXY_NETWORK" ]]; then
    echo "外部代理配置提示:"
    echo "  请将下列配置合并至现有 Docker 反代 (如 Caddy):"
    echo "  ${DOMAIN} {"
    echo "      encode zstd gzip"
    echo "      reverse_proxy pi-remote-relay:8789"
    echo "  }"
  else
    echo "外部代理配置提示:"
    echo "  请将下列配置合并至现有宿主机反代 (如 Caddy):"
    echo "  ${DOMAIN} {"
    echo "      encode zstd gzip"
    echo "      reverse_proxy 127.0.0.1:${PORT}"
    echo "  }"
  fi
  echo "提示: 本地健康检查成功仅代表内部服务运行正常，公网访问与 TLS 依赖您的外部反向代理及 DNS 解析正确性。"
fi
echo "=================================================="
