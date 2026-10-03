#!/usr/bin/env bash
# Builds "Pi Remote.app" locally: SwiftPM release build + app bundle + ad-hoc signature.
# No Apple Developer account, no real device, no network access required.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="Pi Remote"
DIST_DIR="$SCRIPT_DIR/dist"
APP_DIR="$DIST_DIR/$APP_NAME.app"
CONTENTS="$APP_DIR/Contents"
RUNTIME="$CONTENTS/Resources/runtime"
SERVER_BUNDLE="$CONTENTS/Resources/server-bundle"

NODE_SRC="/usr/local/bin/node"
CLOUDFLARED_SRC="/opt/homebrew/bin/cloudflared"
ICON_SRC="$REPO_ROOT/assets/branding/pi-remote-app-icon.png"

fail() { echo "错误：$*" >&2; exit 1; }

for command in swift sips iconutil codesign plutil lipo xattr; do
	command -v "$command" >/dev/null 2>&1 || fail "缺少命令：$command"
done

for file in "$NODE_SRC" "$CLOUDFLARED_SRC" "$ICON_SRC" "$REPO_ROOT/package.json" \
	"$REPO_ROOT/node_modules/ws/package.json" "$SCRIPT_DIR/runtime-supervisor.mjs"; do
	[[ -e "$file" ]] || fail "缺少文件：$file"
done
[[ -d "$REPO_ROOT/src" ]] || fail "缺少目录：$REPO_ROOT/src"

if [[ "$(uname -m)" != "arm64" ]]; then
	echo "警告：当前主机为 $(uname -m)，产物可能不是 arm64" >&2
fi

echo "==> 核对运行时依赖架构"
for tool in "$NODE_SRC" "$CLOUDFLARED_SRC"; do
	archs="$(lipo -archs "$tool" 2>/dev/null || true)"
	[[ "$archs" == *arm64* ]] || fail "$tool 不含 arm64 架构（检测到：${archs:-未知}）"
	echo "    $tool → $archs"
done

echo "==> swift build -c release"
swift build --package-path "$SCRIPT_DIR" -c release
BIN_DIR="$(swift build --package-path "$SCRIPT_DIR" -c release --show-bin-path)"
BIN_PATH="$BIN_DIR/PiRemote"
[[ -x "$BIN_PATH" ]] || fail "找不到可执行文件：$BIN_PATH"
lipo -archs "$BIN_PATH" | grep -q arm64 || fail "主程序不含 arm64 架构"

echo "==> 组装 $APP_NAME.app"
rm -rf "$APP_DIR"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources" "$RUNTIME/node_modules"
cp "$BIN_PATH" "$CONTENTS/MacOS/PiRemote"
cp "$SCRIPT_DIR/Resources/Info.plist" "$CONTENTS/Info.plist"
plutil -lint "$CONTENTS/Info.plist" >/dev/null

echo "==> 生成 AppIcon.icns"
ICONSET="$DIST_DIR/AppIcon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
while read -r size name; do
	[[ -n "$size" ]] || continue
	sips -z "$size" "$size" "$ICON_SRC" --out "$ICONSET/$name" >/dev/null
done <<'SPEC'
16 icon_16x16.png
32 icon_16x16@2x.png
32 icon_32x32.png
64 icon_32x32@2x.png
128 icon_128x128.png
256 icon_128x128@2x.png
256 icon_256x256.png
512 icon_256x256@2x.png
512 icon_512x512.png
1024 icon_512x512@2x.png
SPEC
iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/AppIcon.icns"
rm -rf "$ICONSET"

echo "==> 复制运行时（node、cloudflared、src、ws）"
cp -L "$NODE_SRC" "$RUNTIME/node"
cp -L "$CLOUDFLARED_SRC" "$RUNTIME/cloudflared"
chmod 755 "$RUNTIME/node" "$RUNTIME/cloudflared"
cp "$SCRIPT_DIR/runtime-supervisor.mjs" "$RUNTIME/runtime-supervisor.mjs"
cp "$REPO_ROOT/package.json" "$RUNTIME/package.json"
cp -R "$REPO_ROOT/src" "$RUNTIME/src"
cp -R "$REPO_ROOT/node_modules/ws" "$RUNTIME/node_modules/ws"

echo "==> 复制独立 Claude 后端运行时"
"$NODE_SRC" "$REPO_ROOT/backend/claude/scripts/package-runtime.mjs" "$RUNTIME/claude"

echo "==> 复制服务器安装包"
mkdir -p "$SERVER_BUNDLE/deploy" "$SERVER_BUNDLE/scripts/lib"
cp -R "$REPO_ROOT/src" "$SERVER_BUNDLE/src"
for file in package.json package-lock.json Dockerfile .dockerignore; do
    cp "$REPO_ROOT/$file" "$SERVER_BUNDLE/$file"
done
cp "$REPO_ROOT/deploy/docker-compose.standalone.yml" "$REPO_ROOT/deploy/Caddyfile.standalone" "$SERVER_BUNDLE/deploy/"
cp "$REPO_ROOT/scripts/install-server.sh" "$SERVER_BUNDLE/scripts/"
cp -R "$REPO_ROOT/scripts/lib/." "$SERVER_BUNDLE/scripts/lib/"

env_files="$(find "$RUNTIME" "$SERVER_BUNDLE" \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' \) -print; find "$SERVER_BUNDLE" \( -name 'node_modules' -o -iname '*TOKYO*' \) -print)"
[[ -z "$env_files" ]] || fail "应用不应包含凭据或私有部署文件：$env_files"

echo "==> ad-hoc 签名"
if ! xattr -cr "$APP_DIR"; then
	echo "警告：清理扩展属性失败，继续签名" >&2
fi
for tool in "$RUNTIME/node" "$RUNTIME/cloudflared"; do
	if ! codesign --verify "$tool" >/dev/null 2>&1; then
		codesign --force --sign - "$tool"
	fi
done
codesign --force --sign - "$APP_DIR" >/dev/null
codesign --verify --verbose=2 "$APP_DIR" >/dev/null

echo "==> 完成"
echo "    产物：$APP_DIR"
echo "    主程序架构：$(lipo -archs "$CONTENTS/MacOS/PiRemote")"
echo "    应用体积：$(du -sh "$APP_DIR" | cut -f1)"
