#!/bin/bash
set -euo pipefail
if [ "$(uname -s)" != "Darwin" ]; then
  echo "请在 macOS 上运行额度助手安装器。" >&2
  exit 1
fi
quota_source="$(cd "$(dirname "$0")" && pwd -P)"
quota_repo="$(cd "$quota_source/../.." && pwd -P)"
quota_build="${CODEX_QUOTA_BUILD_DIR:-$HOME/.codex/share/codexNoProject/codex-quota-build}"
quota_bundle="$quota_build/Codex 额度助手.app"
quota_install_dir="${CODEX_QUOTA_INSTALL_DIR:-$HOME/Applications}"
quota_dest="$quota_install_dir/Codex 额度助手.app"
# Update the existing bundle so the menu bar never runs two helpers.
if [ -z "${CODEX_QUOTA_INSTALL_DIR:-}" ]; then
  for candidate in "/Applications/Codex 额度助手.app" "$quota_dest"; do
    if [ -d "$candidate" ] && [ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$candidate/Contents/Info.plist" 2>/dev/null)" = "top.zhengru.codex-quota" ]; then
      quota_dest="$candidate"
      break
    fi
  done
fi
quota_install_dir="$(dirname "$quota_dest")"
# Rebuild before stopping the installed helper to avoid reinstalling stale code.
"$quota_source/build.sh"
source "$quota_repo/codex-sidebar/runtime.sh"
if [ -n "${CODEX_QUOTA_EXPECTED_REVISION:-}" ]; then
  "$quota_node" --input-type=module - "$quota_repo" "$quota_bundle/Contents/Resources/update-source.json" "$CODEX_QUOTA_EXPECTED_REVISION" <<'JS'
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const git = args => execFileSync('git', ['-C', process.argv[2], ...args], { encoding: 'utf8' }).trim();
const built = JSON.parse(readFileSync(process.argv[3], 'utf8'));
if (git(['rev-parse', 'HEAD']) !== process.argv[4] || built.revision !== process.argv[4] ||
    git(['status', '--porcelain', '--untracked-files=normal'])) {
  throw new Error('编译期间源码发生变化，保留现有助手，请稍后重试。');
}
JS
fi
if [ -e "$quota_dest" ]; then
  quota_id=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$quota_dest/Contents/Info.plist")
  if [ "$quota_id" != "top.zhengru.codex-quota" ]; then
    echo "目标路径不是本额度助手，已停止安装。" >&2
    exit 1
  fi
  # Stop this application's backend, then terminate only its verified executable.
  CODEX_QUOTA_STATE_DIR="$HOME/Library/Application Support/CodexQuotaSidebar" \
    "$quota_node" "$quota_dest/Contents/Resources/engine/cli.mjs" stop
  "$quota_node" --input-type=module - "$quota_dest/Contents/MacOS/CodexQuota" <<'JS'
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const processOptions = { env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } };
const expected = process.argv[2];
const { stdout } = await exec('/bin/ps', ['-ww', '-axo', 'pid=,comm='], processOptions);
for (const line of stdout.split('\n')) {
  const match = line.match(/^\s*(\d+)\s+(.+)$/);
  if (!match || match[2] !== expected) continue;
  const pid = Number(match[1]);
  process.kill(pid, 'SIGTERM');
  let exited = false;
  for (let i = 0; i < 40; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      const result = await exec('/bin/ps', ['-ww', '-p', String(pid), '-o', 'comm='], processOptions);
      if (result.stdout.trim() !== expected) { exited = true; break; }
    } catch { exited = true; break; }
  }
  if (!exited) throw new Error('额度助手尚未退出，已停止更新应用。');
}
JS
fi
if [ -f "$quota_repo/codex-sidebar/.state/daemon.json" ]; then
  "$quota_node" "$quota_repo/codex-sidebar/cli.mjs" stop
fi
mkdir -p "$quota_install_dir"
/usr/bin/ditto "$quota_bundle" "$quota_dest"
if [ "${CODEX_QUOTA_NO_LAUNCH:-0}" = "1" ]; then
  : # The independent update worker relaunches with the previous context/state.
elif [ "${CODEX_QUOTA_DLP:-${SAFE_SANDBOX:-0}}" = "1" ]; then
  # Preserve the safe terminal context during manual installs and updates.
  "$quota_node" "$quota_dest/Contents/Resources/engine/cli.mjs" dlp-helper
else
  /usr/bin/open "$quota_dest" --args --attach-existing
fi
echo "已安装：$quota_dest"
echo "菜单栏中可启动或停止额度；未添加开机登录项。"
