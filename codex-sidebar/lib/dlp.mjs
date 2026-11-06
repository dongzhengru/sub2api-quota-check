// Preserve the existing safe-terminal checks, profile, proxy and process ancestry.
const HOOK = `
# CODEX_QUOTA_DLP_HELPER: inherit this safe terminal's context and existing proxy.
for quota_app in "/Applications/Codex 额度助手.app" "$HOME/Applications/Codex 额度助手.app"; do
  quota_cli="$quota_app/Contents/Resources/engine/cli.mjs"
  quota_node="\${CHATGPT_BIN%/Contents/MacOS/ChatGPT}/Contents/Resources/cua_node/bin/node"
  if [[ -x "$quota_app/Contents/MacOS/CodexQuota" && -f "$quota_cli" && -x "$quota_node" ]]; then
    NODE_USE_ENV_PROXY=1 "$quota_node" "$quota_cli" dlp-helper </dev/null >>"$LOG_FILE" 2>&1 &
    break
  fi
done
`;

export function adaptDlpLauncher(source) {
  const flag = '--remote-debugging-port=9342';
  if (!source.includes(flag) && source.includes('--remote-debugging-port')) throw new Error('DLP 启动器已有其他调试端口，请人工确认');
  const launch = '"$CHATGPT_BIN" "--user-data-dir=$USER_DATA" "--proxy-server=$APP_PROXY"';
  if (source.split(launch).length !== 2 || !source.includes('SAFE_SANDBOX') || !source.includes('CODEX_ELECTRON_USER_DATA_PATH')) {
    throw new Error('未识别的 DLP 启动器结构，未修改');
  }
  let updated = source.includes(flag) ? source : source.replace(launch, `${launch} "--remote-debugging-address=127.0.0.1" "${flag}"`);
  if (!updated.includes('# CODEX_QUOTA_DLP_HELPER:')) updated = updated.trimEnd() + '\n' + HOOK;
  return updated;
}
