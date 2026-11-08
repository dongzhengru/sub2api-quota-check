#!/bin/bash
set -euo pipefail
if [ "$(uname -s)" != "Darwin" ]; then
  echo "请在 macOS 上构建额度助手。" >&2
  exit 1
fi
quota_source="$(cd "$(dirname "$0")" && pwd -P)"
quota_engine="$(dirname "$quota_source")"
quota_build="${CODEX_QUOTA_BUILD_DIR:-$HOME/.codex/share/codexNoProject/codex-quota-build}"
quota_app="$quota_build/Codex 额度助手.app"
mkdir -p "$quota_build/module-cache"
if [ -d "$quota_app" ]; then /bin/rm -rf "$quota_app"; fi
mkdir -p "$quota_app/Contents/MacOS" "$quota_app/Contents/Resources/engine"
xcrun swiftc -O -target "$(uname -m)-apple-macos13.0" -module-cache-path "$quota_build/module-cache" \
  "$quota_source/main.swift" -o "$quota_app/Contents/MacOS/CodexQuota"
cp "$quota_source/Info.plist" "$quota_app/Contents/Info.plist"
cp "$quota_engine/cli.mjs" "$quota_engine/package.json" "$quota_app/Contents/Resources/engine/"
/usr/bin/ditto "$quota_engine/lib" "$quota_app/Contents/Resources/engine/lib"
xcrun swiftc -O -module-cache-path "$quota_build/module-cache" "$quota_source/icon.swift" -o "$quota_build/make-icon"
"$quota_build/make-icon" "$quota_build/icon.png"
mkdir -p "$quota_build/Quota.iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$quota_build/icon.png" --out "$quota_build/Quota.iconset/icon_${size}x${size}.png" >/dev/null
  quota_double=$((size * 2))
  sips -z "$quota_double" "$quota_double" "$quota_build/icon.png" --out "$quota_build/Quota.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$quota_build/Quota.iconset" -o "$quota_app/Contents/Resources/Quota.icns"
codesign --force --sign - "$quota_app"
echo "$quota_app"
