#!/usr/bin/env bash
set -euo pipefail

# scripts/install-terminal-bridge.sh - 安装 pi-remote 终端桥接扩展

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SOURCE_EXT="${SOURCE_DIR}/src/terminal/extension.ts"
EXTENSION_NAME="pi-remote-bridge"
MARKER="pi-remote terminal bridge extension"

show_help() {
  cat <<'EOF'
用法:
  install-terminal-bridge.sh [选项]

选项:
  --runtime pi|omp|all   安装目标运行时（默认 pi）
  --dir <extensions-dir> 指定一个运行时的 extensions 目录（不能与 --runtime all 同时使用）
  --dry-run              仅演练，不写入任何文件
  --force                目标文件已存在且不是本桥接时仍覆盖
  --help                 显示帮助信息

默认目录: ${PI_AGENT_DIR:-$HOME/.pi/agent}/extensions（pi）或
          ${OMP_AGENT_DIR:-$HOME/.omp/agent}/extensions（omp）。
安装完成后，在正在运行的交互式会话空闲时执行 /reload。
EOF
}

RUNTIME=pi
EXTENSIONS_DIR=""
DRY_RUN=false
FORCE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || { echo "错误: --runtime 缺少参数" >&2; exit 1; }
      RUNTIME="$2"
      shift 2
      ;;
    --dir)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || { echo "错误: --dir 缺少参数" >&2; exit 1; }
      EXTENSIONS_DIR="$2"
      shift 2
      ;;
    --dry-run) DRY_RUN=true; shift ;;
    --force) FORCE=true; shift ;;
    --help|-h) show_help; exit 0 ;;
    *) echo "错误: 未知参数 $1" >&2; show_help >&2; exit 1 ;;
  esac
done

case "${RUNTIME}" in
  pi|omp) ;;
  all)
    [[ -z "${EXTENSIONS_DIR}" ]] || { echo "错误: --runtime all 不能与 --dir 同时使用" >&2; exit 1; }
    ;;
  *) echo "错误: --runtime 必须是 pi、omp 或 all" >&2; exit 1 ;;
esac

if [[ ! -f "${SOURCE_EXT}" ]]; then
  echo "错误: 未找到扩展源文件 ${SOURCE_EXT}" >&2
  exit 1
fi

if grep -nE 'from "\.{1,2}/' "${SOURCE_EXT}" >/dev/null 2>&1; then
  echo "错误: ${SOURCE_EXT} 包含本地依赖，安装器需要同步复制对应文件" >&2
  exit 1
fi

runtimes=("${RUNTIME}")
[[ "${RUNTIME}" == all ]] && runtimes=(pi omp)
targets=()
for runtime in "${runtimes[@]}"; do
  if [[ -n "${EXTENSIONS_DIR}" ]]; then
    extensions="${EXTENSIONS_DIR}"
  elif [[ "${runtime}" == pi ]]; then
    extensions="${PI_AGENT_DIR:-${HOME:-}/.pi/agent}/extensions"
  else
    extensions="${OMP_AGENT_DIR:-${HOME:-}/.omp/agent}/extensions"
  fi
  if [[ -z "${extensions}" || "${extensions}" == "/.pi/agent/extensions" || "${extensions}" == "/.omp/agent/extensions" ]]; then
    echo "错误: 无法确定目标 extensions 目录，请用 --dir 指定" >&2
    exit 1
  fi
  target_dir="${extensions}/${EXTENSION_NAME}"
  target_file="${target_dir}/index.ts"
  if [[ -L "${target_dir}" ]]; then
    echo "错误: 目标目录 ${target_dir} 是符号链接，拒绝写入" >&2
    exit 1
  fi
  if [[ -e "${target_file}" || -L "${target_file}" ]]; then
    if [[ -L "${target_file}" ]]; then
      echo "错误: 目标文件 ${target_file} 是符号链接，拒绝写入" >&2
      exit 1
    fi
    if [[ "${FORCE}" != true ]] && ! grep -qF "${MARKER}" "${target_file}"; then
      echo "错误: ${target_file} 已存在且不是 pi-remote 桥接扩展，使用 --force 才会覆盖" >&2
      exit 1
    fi
  fi
  targets+=("${target_file}")
done

for target_file in "${targets[@]}"; do
  if [[ "${DRY_RUN}" == true ]]; then
    echo "[DRY-RUN] 将安装扩展: ${SOURCE_EXT} -> ${target_file}"
    continue
  fi
  mkdir -p "$(dirname "${target_file}")"
  cp "${SOURCE_EXT}" "${target_file}"
  chmod 0644 "${target_file}"
  echo "已安装终端桥接扩展: ${target_file}"
done
if [[ "${DRY_RUN}" == true ]]; then
  echo "[DRY-RUN] 未写入任何文件"
else
  echo "下一步: 在交互式会话空闲时执行 /reload。桥接 socket 位于各运行时的 agent/pi-remote-bridge 目录，可用 PI_REMOTE_BRIDGE_DIR 覆盖。"
fi
