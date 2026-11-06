#!/bin/bash
set -euo pipefail
quota_root="$(cd "$(dirname "$0")" && pwd -P)"
source "$quota_root/codex-sidebar/runtime.sh"
if ! "$quota_node" "$quota_root/codex-sidebar/cli.mjs" stop; then
  read -r -p "按回车关闭窗口…"
  exit 1
fi
