#!/bin/bash
# Resolve Node without requiring npm install; works when launched from Finder.
quota_node=""
for candidate in "/Applications/Codex.app/Contents/Resources/cua_node/bin/node" "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -x "$candidate" ] && "$candidate" -e 'process.exit(typeof WebSocket === "function" && Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
    quota_node="$candidate"
    break
  fi
done
if [ -z "$quota_node" ] && command -v node >/dev/null 2>&1; then
  quota_node="$(command -v node)"
fi
if [ -z "$quota_node" ]; then
  echo "未找到 Node.js 22+，请安装 Node.js 或支持此运行时的 Codex 客户端。" >&2
  exit 1
fi
