#!/bin/bash
set -euo pipefail
quota_source="$(cd "$(dirname "$0")" && pwd -P)"
quota_repo="$(cd "$quota_source/../.." && pwd -P)"
quota_bundle="$quota_source/build/Codex 额度助手.app"
quota_dest="$HOME/Applications/Codex 额度助手.app"
if [ ! -x "$quota_bundle/Contents/MacOS/CodexQuota" ]; then
  "$quota_source/build.sh"
fi
source "$quota_repo/codex-sidebar/runtime.sh"
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
const expected = process.argv[2];
const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,comm=']);
for (const line of stdout.split('\n')) {
  const match = line.match(/^\s*(\d+)\s+(.+)$/);
  if (!match || match[2] !== expected) continue;
  const pid = Number(match[1]);
  process.kill(pid, 'SIGTERM');
  let exited = false;
  for (let i = 0; i < 40; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      const result = await exec('/bin/ps', ['-p', String(pid), '-o', 'comm=']);
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
mkdir -p "$HOME/Applications"
/usr/bin/ditto "$quota_bundle" "$quota_dest"
/usr/bin/open "$quota_dest" --args --attach-existing
echo "已安装：$quota_dest"
echo "菜单栏中可启动或停止额度；未添加开机登录项。"
