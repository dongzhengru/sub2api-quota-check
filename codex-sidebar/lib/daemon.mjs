import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CDP, isAppTarget, listTargets } from './cdp.mjs';
import { UsagePoller, fetchUserBreakdown, fetchTokenActivity } from './usage.mjs';
import { assertWindowsListener } from './windows.mjs';

const exec = promisify(execFile);
export const DISPOSE = 'window.__zhengruQuotaSidebarV1?.dispose(); true';
const TRUSTED_PAGE = `location.protocol === 'app:' && ['-', 'codex', 'localhost'].includes(location.hostname)`;
const BINDING = '__zhengruQuotaDispatch';

export function isAppExecutable(value) {
  return /\/(?:Codex|ChatGPT)\.app\/Contents\/(?:MacOS\/(?:Codex|ChatGPT)|Frameworks\/.*\/MacOS\/(?:Codex|ChatGPT)(?: Helper)?(?: \([^)]+\))?)$/.test(value.trim());
}

export async function assertAppListener(port, run = exec, platform = process.platform) {
  if (platform === 'win32') return assertWindowsListener(port, run);
  const { stdout } = await run('/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], { timeout: 3000 });
  const pids = [...stdout.matchAll(/^p(\d+)$/gm)].map(m => m[1]);
  const addresses = [...stdout.matchAll(/^n(.+)$/gm)].map(m => m[1]);
  if (!pids.length || addresses.some(a => a !== `127.0.0.1:${port}`)) {
    throw new Error('CDP 必须仅监听 127.0.0.1');
  }
  const verified = new Set();
  for (const pid of pids) {
    // Chromium can change its process title after startup. Use the executable
    // mapped by the OS instead of trusting the mutable ps comm/process title.
    const { stdout: files } = await run('/usr/sbin/lsof', ['-a', '-p', pid, '-d', 'txt', '-Fn'], { timeout: 3000 });
    const executables = [...files.matchAll(/^n(.+)$/gm)].map(m => m[1]);
    if (executables.some(isAppExecutable)) verified.add(pid);
  }
  if (!verified.size) throw new Error('CDP 端口不属于 Codex / ChatGPT 客户端');
  // The native computer-use service inherits the main process's listening FD.
  // Require every other holder to descend from a verified application holder.
  // Do not reject a legitimate inherited socket or trust an unrelated listener.
  for (const pid of pids) {
    let ancestor = pid;
    const seen = new Set();
    while (!verified.has(ancestor) && ancestor !== '1' && !seen.has(ancestor) && seen.size < 32) {
      seen.add(ancestor);
      const { stdout: parent } = await run('/bin/ps', ['-p', ancestor, '-o', 'ppid='], { timeout: 3000 });
      ancestor = parent.trim();
      if (!/^\d+$/.test(ancestor)) break;
    }
    if (!verified.has(ancestor)) throw new Error('CDP 端口存在不属于客户端的监听进程');
  }
}

export async function removeWidgets(port) {
  await assertAppListener(port);
  let removed = 0;
  for (const target of (await listTargets(port)).filter(isAppTarget)) {
    let client;
    try {
      client = await CDP.connect(target.webSocketDebuggerUrl, { port });
      await client.evaluate(`if (${TRUSTED_PAGE}) { ${DISPOSE} }`);
      removed++;
    } finally { client?.close(); }
  }
  return removed;
}

export async function runDaemon({ ports, port, poller = new UsagePoller(), ...options }) {
  // Both instances share the same quota request/cache, but reconnect independently.
  await Promise.all((ports || [port]).map(port => runEndpoint({ ...options, port, poller,
    log: message => (options.log || console.log)(`[${port}] ${message}`) })));
}

async function runEndpoint({ port, selector, theme = async () => 'auto', costEstimation = async () => false, signal, poller, log, dependencies = {} }) {
  const verify = dependencies.verify || assertAppListener;
  const targetsForPort = dependencies.targets || listTargets;
  const connect = dependencies.connect || ((url, port) => CDP.connect(url, { port }));
  const widget = await readFile(fileURLToPath(new URL('./widget.js', import.meta.url)), 'utf8');
  // The appearance choice lives in the state file, so the menu can switch a running
  // card without restarting the daemon.
  const inject = async (client, snapshot) => client.evaluate(`if (${TRUSTED_PAGE}) { (${widget})(${JSON.stringify(snapshot)}, ${JSON.stringify({ selector, theme: await theme() }) }) }`);
  const usageFetch = dependencies.usageFetch || fetchUserBreakdown;
  const activityFetch = dependencies.activityFetch || fetchTokenActivity;
  const sessions = new Map();
  // Binding events and the polling fallback deliver the same requests; per-session
  // cursors deduplicate them, and busy flags bound concurrent upstream fetches.
  const meta = new Map();
  const drop = id => { sessions.delete(id); meta.delete(id); };
  const runUsage = (id, client, request) => {
    const state = meta.get(id); state.usage = request.id; state.usageBusy = true;
    void costEstimation().then(enabled => usageFetch({ ...request, include_estimates: enabled })).then(
      data => ({id:request.id,data}), error => ({id:request.id,error:error.message || '用量查询失败'})
    ).then(result => client.evaluate(`if (${TRUSTED_PAGE}) window.__zhengruQuotaSidebarV1?.receiveUsage?.(${JSON.stringify(result)})`))
      .catch(() => {}).finally(() => { if (meta.get(id) === state) state.usageBusy = false; });
  };
  const runActivity = (id, client, request) => {
    const state = meta.get(id); state.activity = request.id; state.activityBusy = true;
    void activityFetch(request).then(
      data => ({id:request.id,data}), error => ({id:request.id,error:error.message || 'Token Activity 查询失败'})
    ).then(result => client.evaluate(`if (${TRUSTED_PAGE}) window.__zhengruQuotaSidebarV1?.receiveActivity?.(${JSON.stringify(result)})`))
      .catch(() => {}).finally(() => { if (meta.get(id) === state) state.activityBusy = false; });
  };
  const accept = (kind, id, client, request) => {
    const state = meta.get(id);
    if (!state || sessions.get(id) !== client || !request || !Number.isInteger(request.id) || request.id <= state[kind] || state[kind + 'Busy']) return;
    (kind === 'usage' ? runUsage : runActivity)(id, client, request);
  };
  const forceRefresh = (id, client, refreshId) => {
    const state = meta.get(id);
    if (!state || sessions.get(id) !== client) return;
    if (Number.isInteger(refreshId)) { if (refreshId <= state.refresh) return; state.refresh = refreshId; }
    nextUsage = poller.refresh({ force: true });
    // Push the finished snapshot right away; waiting for the next tick adds seconds of latency.
    void nextUsage.then(snapshot => Promise.allSettled([...sessions.values()].map(session => inject(session, snapshot)))).catch(() => {});
  };
  let previousError = '';
  let nextUsage = Promise.resolve();
  try {
    while (!signal.aborted) {
      try {
        const targets = (await targetsForPort(port)).filter(isAppTarget);
        if (!targets.length) throw new Error('CDP 已连接，等待 Codex 主界面');
        // Poll in parallel with UI maintenance, so slow requests don't delay mounting.
        nextUsage = poller.refresh();
        const alive = new Set(targets.map(t => t.id));
        for (const [id, client] of sessions) {
          if (!alive.has(id) || client.closed) { client.close(); drop(id); }
        }
        let verified = false;
        for (const target of targets) {
          let client = sessions.get(target.id);
          let fresh = false;
          try {
            if (!client) {
              // Live sessions keep the trust chain established at connect time;
              // re-verify the listener only when a new connection is made.
              if (!verified) { await verify(port); verified = true; }
              client = await connect(target.webSocketDebuggerUrl, port);
              sessions.set(target.id, client);
              meta.set(target.id, { usage: 0, activity: 0, refresh: 0, usageBusy: false, activityBusy: false });
              await client.call('Runtime.enable');
              await client.call('Runtime.addBinding', { name: BINDING });
              client.on('Runtime.bindingCalled', event => {
                if (event?.name !== BINDING || typeof event.payload !== 'string' || event.payload.length > 4096) return;
                let message; try { message = JSON.parse(event.payload); } catch { return; }
                if (message?.kind === 'usage') accept('usage', target.id, client, message);
                else if (message?.kind === 'activity') accept('activity', target.id, client, message);
                else if (message?.kind === 'refresh') forceRefresh(target.id, client, message.id);
              });
              fresh = true;
            }
            const state = await client.evaluate(`(${TRUSTED_PAGE}) ? ({ installed: !!window.__zhengruQuotaSidebarV1, refresh: window.__zhengruQuotaSidebarV1?.takeRefreshRequest?.() || false, usage: window.__zhengruQuotaSidebarV1?.takeUsageRequest?.() || null, activity: window.__zhengruQuotaSidebarV1?.takeActivityRequest?.() || null }) : null`);
            if (state?.usage) accept('usage', target.id, client, state.usage);
            if (state?.activity) accept('activity', target.id, client, state.activity);
            if (state?.refresh) forceRefresh(target.id, client, state.refresh);
            if (state) {
              const result = await inject(client, poller.snapshot);
              if (fresh) log(result?.mounted ? '额度卡片已挂载' : '已连接界面，等待侧栏出现');
            }
          } catch (error) {
            client?.close(); drop(target.id);
            log(`页面连接暂不可用：${error.message}`);
          }
        }
        if (previousError) log('CDP 连接已恢复');
        previousError = '';
      } catch (error) {
        const message = error.code === 1 || error.code === 'ENOENT' ? '等待本机 Codex CDP 端口' : error.message;
        if (message !== previousError) log(message);
        previousError = message;
        for (const client of sessions.values()) client.close();
        sessions.clear(); meta.clear();
      }
      if (!signal.aborted) await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, 3000);
        signal.addEventListener('abort', finish, { once: true });
      });
    }
  } finally {
    await Promise.allSettled([...sessions.values()].map(async client => {
      try { await client.evaluate(`if (${TRUSTED_PAGE}) { ${DISPOSE} }`); }
      finally { client.close(); }
    }));
    // Consume any in-flight poll without keeping shutdown dependent on the network.
    void nextUsage.catch(() => {});
  }
}
