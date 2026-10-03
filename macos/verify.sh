#!/usr/bin/env bash
# Acceptance verification for the macOS client:
#   1. SwiftPM unit tests (URL/token contract, QR payload, config store, job construction, .env import)
#   2. runtime-supervisor lifecycle (split job write, cancel, force-quit parent cleanup)
#   3. app bundle build + bundle layout / signature / arm64 assertions
# Set PI_REMOTE_SKIP_BUILD=1 to skip step 3.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/dist/Pi Remote.app"
CONTENTS="$APP_DIR/Contents"
RUNTIME="$CONTENTS/Resources/runtime"
SERVER_BUNDLE="$CONTENTS/Resources/server-bundle"

echo "==> 1/3 SwiftPM 单元测试"
swift test --package-path "$SCRIPT_DIR"

echo "==> 2/3 runtime-supervisor 生命周期验证"
node "$SCRIPT_DIR/tests/supervisor-lifecycle.mjs"
node "$SCRIPT_DIR/tests/claude-backend-lifecycle.mjs"

if [[ "${PI_REMOTE_SKIP_BUILD:-0}" == "1" ]]; then
	echo "==> 3/3 已跳过构建（PI_REMOTE_SKIP_BUILD=1）"
	exit 0
fi

echo "==> 3/3 构建应用并校验产物"
"$SCRIPT_DIR/build.sh"

for path in \
	"$CONTENTS/MacOS/PiRemote" \
	"$CONTENTS/Info.plist" \
	"$CONTENTS/Resources/AppIcon.icns" \
	"$RUNTIME/node" \
	"$RUNTIME/cloudflared" \
	"$RUNTIME/runtime-supervisor.mjs" \
	"$RUNTIME/package.json" \
	"$RUNTIME/src/agent/run.ts" \
	"$RUNTIME/src/index.ts" \
	"$RUNTIME/node_modules/ws/package.json" \
    "$RUNTIME/claude/package.json" \
    "$RUNTIME/claude/src/index.ts" \
    "$RUNTIME/claude/node_modules/@anthropic-ai/claude-agent-sdk/package.json" \
    "$RUNTIME/claude/node_modules/ws/package.json" \
    "$RUNTIME/claude/node_modules/qrcode/package.json" \
    "$SERVER_BUNDLE/package.json" \
    "$SERVER_BUNDLE/package-lock.json" \
    "$SERVER_BUNDLE/Dockerfile" \
    "$SERVER_BUNDLE/.dockerignore" \
    "$SERVER_BUNDLE/src/index.ts" \
    "$SERVER_BUNDLE/deploy/docker-compose.standalone.yml" \
    "$SERVER_BUNDLE/deploy/Caddyfile.standalone" \
    "$SERVER_BUNDLE/scripts/install-server.sh" \
    "$SERVER_BUNDLE/scripts/lib/server-preflight.sh"; do
	[[ -e "$path" ]] || { echo "缺少产物：$path" >&2; exit 1; }
done

lipo -archs "$CONTENTS/MacOS/PiRemote" | grep -q arm64 || { echo "主程序不是 arm64" >&2; exit 1; }
lipo -archs "$RUNTIME/node" | grep -q arm64 || { echo "runtime/node 不是 arm64" >&2; exit 1; }
lipo -archs "$RUNTIME/cloudflared" | grep -q arm64 || { echo "runtime/cloudflared 不是 arm64" >&2; exit 1; }

identifier="$(plutil -extract CFBundleIdentifier raw "$CONTENTS/Info.plist")"
[[ "$identifier" == "com.piremote.mac" ]] || { echo "CFBundleIdentifier 异常：$identifier" >&2; exit 1; }

leaked="$(find "$RUNTIME" "$SERVER_BUNDLE" \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' \) -print; find "$SERVER_BUNDLE" \( -name 'node_modules' -o -iname '*TOKYO*' \) -print)"
[[ -z "$leaked" ]] || { echo "运行时包含凭据文件：$leaked" >&2; exit 1; }
[[ ! -d "$RUNTIME/claude/test" && ! -d "$RUNTIME/claude/node_modules/typescript" && ! -d "$RUNTIME/claude/node_modules/@types" ]] || { echo "Claude 运行时不应包含测试或开发依赖" >&2; exit 1; }

codesign --verify --verbose=2 "$APP_DIR" >/dev/null || { echo "签名校验失败" >&2; exit 1; }
PI_REMOTE_TEST_RUNTIME="$RUNTIME" "$RUNTIME/node" "$SCRIPT_DIR/tests/claude-backend-lifecycle.mjs"

echo "全部验证通过：$APP_DIR"
