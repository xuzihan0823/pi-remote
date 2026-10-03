#!/usr/bin/env bash
# scripts/lib/server-preflight.sh - Preflight verification library for pi-remote installer
# Must be sourced; does not execute checks on source.

preflight_check_os() {
  local os_release_file="${1:-/etc/os-release}"
  local target_arch="${2:-$(uname -m)}"

  if [[ ! -f "$os_release_file" ]]; then
    echo "错误: 预检失败，无法读取系统信息文件 ($os_release_file)。仅支持 Linux 系统。" >&2
    return 1
  fi

  local ID="" ID_LIKE=""
  while IFS='=' read -r key val; do
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
    case "$key" in
      ID) ID="$val" ;;
      ID_LIKE) ID_LIKE="$val" ;;
    esac
  done < "$os_release_file"

  local is_supported_os=false
  local distro_id
  distro_id="$(echo "$ID" | tr '[:upper:]' '[:lower:]')"
  local distro_like
  distro_like="$(echo "$ID_LIKE" | tr '[:upper:]' '[:lower:]')"

  if [[ "$distro_id" =~ ^(ubuntu|debian|rocky|almalinux|fedora)$ ]]; then
    is_supported_os=true

  fi

  if [[ "$is_supported_os" != true ]]; then
    echo "错误: 不支持的 Linux 发行版: ID='$ID', ID_LIKE='$ID_LIKE'。" >&2
    echo "支持的发行版: Ubuntu, Debian, Rocky Linux, AlmaLinux, Fedora。" >&2
    return 1
  fi

  case "$target_arch" in
    x86_64|amd64|aarch64|arm64) ;;
    *)
      echo "错误: 不支持的 CPU 架构: $target_arch。仅支持 x86_64/amd64 或 aarch64/arm64。" >&2
      return 1
      ;;
  esac

  return 0
}

preflight_print_docker_instructions() {
  local os_release_file="${1:-/etc/os-release}"
  local distro_id=""
  if [[ -f "$os_release_file" ]]; then
    while IFS='=' read -r key val; do
      val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
      if [[ "$key" == "ID" ]]; then
        distro_id="$(echo "$val" | tr '[:upper:]' '[:lower:]')"
        break
      fi
    done < "$os_release_file"
  fi

  echo "请参考以下步骤安装 Docker 与 Docker Compose 插件并启动服务：" >&2
  case "$distro_id" in
    ubuntu|debian)
      echo "  1. 卸载冲突包: sudo apt-get remove docker.io docker-doc docker-compose podman-docker containerd runc" >&2
      echo "  2. 安装官方 Docker: 参考 https://docs.docker.com/engine/install/$distro_id/" >&2
      echo "  3. 启动并启用服务: sudo systemctl enable --now docker" >&2
      ;;
    rocky|almalinux|fedora)
      echo "  1. 安装官方 Docker CE 与 Compose: 参考 https://docs.docker.com/engine/install/centos/ 或 fedora/" >&2
      echo "  2. 启动并启用服务: sudo systemctl enable --now docker" >&2
      ;;
    *)
      echo "  1. 安装 Docker Engine 与 Docker Compose: https://docs.docker.com/engine/install/" >&2
      echo "  2. 启动并启用 Docker 守护进程: sudo systemctl enable --now docker" >&2
      ;;
  esac
}

preflight_check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "错误: 未检测到 docker 命令。" >&2
    preflight_print_docker_instructions
    return 1
  fi

  if ! docker compose version >/dev/null 2>&1; then
    echo "错误: Docker Compose 未安装或无法运行 (需要 docker compose 插件)。" >&2
    preflight_print_docker_instructions
    return 1
  fi

  if ! docker info >/dev/null 2>&1; then
    echo "错误: Docker 守护进程未运行或当前用户无权限访问 Docker socket。" >&2
    preflight_print_docker_instructions
    return 1
  fi

  return 0
}

preflight_validate_domain() {
  local domain="$1"
  if [[ -z "$domain" ]]; then
    echo "错误: 域名不能为空。" >&2
    return 1
  fi

  if [[ "$domain" == *"://"* || "$domain" == *"/"* || "$domain" == *":"* ]]; then
    echo "错误: 域名格式不正确: '$domain'。请仅提供 FQDN 域名，不可包含协议头 (http://) 或路径/端口。" >&2
    return 1
  fi

  if [[ "$domain" =~ [[:space:]] || ${#domain} -gt 253 ]]; then
    echo "错误: 域名 '$domain' 格式不合法或超出长度限制。" >&2
    return 1
  fi

  local fqdn_regex='^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$'
  if ! [[ "$domain" =~ $fqdn_regex ]]; then
    echo "错误: 域名 '$domain' 不是合法的 FQDN 格式。" >&2
    return 1
  fi

  return 0
}

preflight_validate_mode() {
  local mode="$1"
  if [[ "$mode" != "standalone" && "$mode" != "external-proxy" ]]; then
    echo "错误: 部署模式 '$mode' 不受支持，必须为 'standalone' 或 'external-proxy'。" >&2
    return 1
  fi
  return 0
}

preflight_validate_port() {
  local port="$1"
  if ! [[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] || (( port > 65535 )); then
    echo "错误: 端口 '$port' 无效，必须在 1 到 65535 之间。" >&2
    return 1
  fi
  return 0
}

preflight_validate_install_dir() {
  local dir="$1"
  if [[ -z "$dir" || "$dir" != /* ]]; then
    echo "错误: 安装目录 '$dir' 必须是非空绝对路径。" >&2
    return 1
  fi

  if [[ "$dir" =~ [[:space:]] || "$dir" == *"/../"* || "$dir" == */.. || "$dir" == *"/./"* || "$dir" == */. || "$dir" == *"//"* ]]; then
    echo "错误: 安装路径必须规范化" >&2; return 1
  fi
  local clean_dir="$dir"
  while [[ "$clean_dir" != "/" && "$clean_dir" == */ ]]; do
    clean_dir="${clean_dir%/}"
  done

  case "$clean_dir" in
    /|/opt|/usr|/etc|/var|/tmp|/home|/root|/bin|/sbin|/lib|/lib64|/sys|/proc|/dev|/boot)
      echo "错误: 不允许使用系统保留目录 '$clean_dir' 作为安装目录。" >&2
      return 1
      ;;
  esac

  local current=""
  IFS='/' read -r -a parts <<< "$clean_dir"
  for part in "${parts[@]}"; do
    [[ -z "$part" ]] && continue
    current="${current}/${part}"
    if [[ -L "$current" ]]; then
      echo "错误: 路径组件 '$current' 是符号链接，拒绝使用符号链接作为安装路径。" >&2
      return 1
    fi
  done

  if [[ -d "$clean_dir" ]]; then
    local is_empty=true
    if [[ -n "$(ls -A "$clean_dir" 2>/dev/null)" ]]; then
      is_empty=false
    fi

    if [[ "$is_empty" == false ]]; then
      local marker_file="${clean_dir}/.pi-remote-managed"
      if [[ ! -f "$marker_file" ]]; then
        echo "错误: 目标目录 '$clean_dir' 已存在且非空，但未包含受管标记文件 (.pi-remote-managed)，拒绝覆盖。" >&2
        return 1
      fi
      local marker_content
      marker_content="$(cat "$marker_file" 2>/dev/null || true)"
      if [[ "$marker_content" != "pi-remote-installer-v1" ]]; then
        echo "错误: 目标目录受管标记不匹配: '$marker_content'，拒绝操作。" >&2
        return 1
      fi
    fi
  fi

  return 0
}

preflight_is_port_occupied() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    if ss -tulnH 2>/dev/null | grep -E -q "(^|[[:space:]:])${port}[[:space:]]"; then
      return 0
    fi
  elif command -v netstat >/dev/null 2>&1; then
    if netstat -tuln 2>/dev/null | grep -E -q "[:.]${port}\b"; then
      return 0
    fi
  elif command -v lsof >/dev/null 2>&1; then
    if lsof -iTCP:"$port" -sTCP:LISTEN -P -n >/dev/null 2>&1; then
      return 0
    fi
  fi
  return 1
}

preflight_own_container_publishes() {
  local container_name="$1"
  local port="$2"
  if ! command -v docker >/dev/null 2>&1; then
    return 1
  fi
  local project_label
  project_label="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$container_name" 2>/dev/null || true)"
  [[ "$project_label" == "pi-remote" ]] || return 1
  docker port "$container_name" 2>/dev/null | grep -E -q ":${port}\$"
}

preflight_check_ports() {
  local mode="$1"
  local port="$2"
  local install_dir="$3"

  local is_managed_upgrade=false
  local marker="${install_dir}/.pi-remote-managed"
  if [[ -d "$install_dir" && -f "$marker" ]]; then
    if [[ "$(cat "$marker" 2>/dev/null || true)" == "pi-remote-installer-v1" ]]; then
      is_managed_upgrade=true
    fi
  fi

  if [[ "$mode" == "standalone" ]]; then
    for p in 80 443; do
      if preflight_is_port_occupied "$p"; then
        if [[ "$is_managed_upgrade" == true ]] && preflight_own_container_publishes "pi-remote-caddy" "$p"; then
          :
        else
          echo "错误: 端口 $p 已被占用。standalone 模式需要 80 和 443 端口。" >&2
          return 1
        fi
      fi
    done
  elif [[ "$mode" == "external-proxy" ]]; then
    if [[ -n "$port" ]] && preflight_is_port_occupied "$port"; then
      if [[ "$is_managed_upgrade" == true ]] && preflight_own_container_publishes "pi-remote-relay" "$port"; then
        :
      else
        echo "错误: 端口 $port 已被占用。external-proxy 模式指定端口已被使用。" >&2
        return 1
      fi
    fi
  fi

  return 0
}

preflight_check_proxy_network() {
  local mode="$1"
  local proxy_network="$2"

  if [[ "$mode" != "external-proxy" && -n "$proxy_network" ]]; then
    echo "错误: proxy-network 仅在 external-proxy 模式下可用。" >&2
    return 1
  fi

  if [[ "$mode" == "external-proxy" && -n "$proxy_network" ]]; then
    if ! [[ "$proxy_network" =~ ^[a-zA-Z0-9_.-]+$ ]]; then
      echo "错误: Docker 网络名称 '$proxy_network' 格式不合法。" >&2
      return 1
    fi
    if ! docker network inspect "$proxy_network" >/dev/null 2>&1; then
      echo "错误: Docker 网络 '$proxy_network' 不存在。请先创建该外部网络。" >&2
      return 1
    fi
  fi

  return 0
}

preflight_check() {
  local domain="${1:-}"
  local mode="${2:-standalone}"
  local install_dir="${3:-/opt/pi-remote}"
  local port="${4:-8789}"
  local proxy_network="${5:-}"

  preflight_validate_domain "$domain" || return 1
  preflight_validate_mode "$mode" || return 1
  preflight_validate_port "$port" || return 1
  preflight_validate_install_dir "$install_dir" || return 1

  [[ "$(uname -s)" == Linux ]] || { echo "错误: 服务端安装仅支持 Linux" >&2; return 1; }
  preflight_check_os || return 1
  preflight_check_docker || return 1
  for name in pi-remote-relay pi-remote-caddy; do
    if docker inspect "$name" >/dev/null 2>&1; then
      local wd
      wd="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$name")"
      [[ "$wd" == "$install_dir" && -f "$install_dir/.pi-remote-managed" ]] || { echo "错误: 容器 $name 属于其他安装目录，拒绝覆盖" >&2; return 1; }
    fi
  done
  preflight_check_proxy_network "$mode" "$proxy_network" || return 1
  preflight_check_ports "$mode" "$port" "$install_dir" || return 1

  return 0
}
