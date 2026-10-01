#!/usr/bin/env bash
set -euo pipefail

SMOKE_TEST=false
if [[ "${1:-}" == "--smoke-test" && $# -eq 1 ]]; then
  SMOKE_TEST=true
elif [[ $# -ne 0 ]]; then
  echo "Usage: bash scripts/build-ios.sh [--smoke-test]" >&2
  exit 1
fi

if [[ "$(uname -s)" != Darwin ]]; then
  echo "iOS builds require macOS and Xcode. Use the iOS Build GitHub Actions workflow." >&2
  exit 1
fi
for tool in xcodebuild xcrun python3; do
  command -v "$tool" >/dev/null || { echo "Missing build prerequisite: $tool" >&2; exit 1; }
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_ROOT="${IOS_BUILD_DIR:-$REPO_ROOT/.build/ios}"
mkdir -p "$BUILD_ROOT"
RUN_DIR="$(mktemp -d "$BUILD_ROOT/run.XXXXXX")"
SIMULATOR_ID=""
cleanup() {
  if [[ -n "$SIMULATOR_ID" ]]; then
    xcrun simctl shutdown "$SIMULATOR_ID" >/dev/null 2>&1 || true
    xcrun simctl delete "$SIMULATOR_ID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

xcodebuild -version
xcodebuild \
  -project "$REPO_ROOT/ios/PiRemote/PiRemote.xcodeproj" \
  -scheme PiRemote \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$RUN_DIR/DerivedData" \
  -resultBundlePath "$RUN_DIR/Build.xcresult" \
  CODE_SIGNING_ALLOWED=NO \
  build 2>&1 | tee "$RUN_DIR/build.log"

APP_PATH="$RUN_DIR/DerivedData/Build/Products/Debug-iphonesimulator/PiRemote.app"
[[ -d "$APP_PATH" && -f "$APP_PATH/PiRemote" ]] || { echo "Build did not produce PiRemote.app" >&2; exit 1; }
COPYFILE_DISABLE=1 tar -czf "$RUN_DIR/PiRemote-simulator.tar.gz" -C "$(dirname "$APP_PATH")" PiRemote.app

if [[ "$SMOKE_TEST" == true ]]; then
  xcrun simctl list --json > "$RUN_DIR/simulators.json"
  read -r RUNTIME_ID DEVICE_TYPE < <(python3 - "$RUN_DIR/simulators.json" <<'PY'
import json
import sys

with open(sys.argv[1]) as stream:
    data = json.load(stream)
types = {item["name"]: item["identifier"] for item in data["devicetypes"]}
for runtime, devices in data["devices"].items():
    if ".iOS-" not in runtime:
        continue
    for device in devices:
        if device.get("isAvailable") and device["name"].startswith("iPhone"):
            device_type = device.get("deviceTypeIdentifier") or types.get(device["name"])
            if device_type:
                print(runtime, device_type)
                sys.exit(0)
sys.exit("No available iPhone simulator runtime. Install one in Xcode Settings > Components.")
PY
  )
  SIMULATOR_ID="$(xcrun simctl create 'Pi Remote Build Check' "$DEVICE_TYPE" "$RUNTIME_ID")"
  xcrun simctl boot "$SIMULATOR_ID"
  xcrun simctl bootstatus "$SIMULATOR_ID" -b
  xcrun simctl install "$SIMULATOR_ID" "$APP_PATH"
  LAUNCH_OUTPUT="$(xcrun simctl launch "$SIMULATOR_ID" com.xuzihan0823.PiRemote)"
  printf '%s\n' "$LAUNCH_OUTPUT" | tee "$RUN_DIR/launch.log"
  APP_PID="${LAUNCH_OUTPUT##*: }"
  [[ "$APP_PID" =~ ^[0-9]+$ ]] || { echo "Simulator did not return an app PID" >&2; exit 1; }
  sleep 2
  xcrun simctl spawn "$SIMULATOR_ID" launchctl list | awk -v app_pid="$APP_PID" '$1 == app_pid { found = 1 } END { exit !found }'
  xcrun simctl io "$SIMULATOR_ID" screenshot "$RUN_DIR/PiRemote-simulator.png"
  echo "PASS: PiRemote installed, launched and remained running in the iPhone simulator."
fi

echo "Simulator app archive: $RUN_DIR/PiRemote-simulator.tar.gz"
