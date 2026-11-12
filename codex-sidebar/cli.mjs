#!/usr/bin/env node
import { mkdir, readFile, writeFile, unlink, open, access, realpath } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { ensureDlpHelper, proxyEnvironment } from './lib/helper.mjs';
import { assertAppListener, removeWidgets, runDaemon } from './lib/daemon.mjs';
import { parsePorts, endpointStatus } from './lib/endpoints.mjs';
import { matchesDaemonProcess, processOptions } from './lib/process.mjs';
import { findWindowsApp, windowsAppRunning } from './lib/windows.mjs';
import { inspectUpdate, startUpdate, updateSource } from './lib/update.mjs';

const exec = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const bundled = path.basename(path.resolve(ROOT, '../../..')) === 'Codex 额度助手.app';
const STATE = process.env.CODEX_QUOTA_STATE_DIR ? path.resolve(process.env.CODEX_QUOTA_STATE_DIR) :
  bundled ? path.join(homedir(), 'Library/Application Support/CodexQuotaSidebar') : path.join(ROOT, '.state');
const STATE_FILE = path.join(STATE, 'daemon.json');
const LOG = path.join(STATE, 'sidebar.log');
const CLI = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const command = args.shift() || 'help';
function option(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
}
const ports = parsePorts(option('port'));
const port = ports[0];

async function readState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const matchesProcess = state => matchesDaemonProcess(state, CLI);
async function clearState(pid) {
  if ((await readState())?.pid === pid) await unlink(STATE_FILE).catch(() => {});
}
async function appBundle() {
  if (process.platform === 'win32') return findWindowsApp({ explicit: option('app') });
  for (const candidate of [option('app', ''), '/Applications/Codex.app', '/Applications/ChatGPT.app']) {
    if (!candidate) continue;
    const full = path.resolve(candidate);
    if (!['Codex.app', 'ChatGPT.app'].includes(path.basename(full))) continue;
    const exe = path.join(full, 'Contents/MacOS', path.basename(full, '.app'));
    try { await access(exe); return { bundle: await realpath(full), exe }; } catch { /* try next */ }
  }
  throw new Error('未找到 Codex / ChatGPT.app；可用 --app 指定应用路径');
}
async function launch() {
  if ((await endpointStatus(ports)).some(value => value.connected)) return;
  const app = await appBundle();
  if (process.platform === 'win32') {
    if (await windowsAppRunning(app.exe)) {
      throw new Error('客户端正在运行但未开启调试连接。请从托盘或客户端菜单完全退出 Codex，再双击「启动额度侧栏.cmd」；关闭窗口可能仅隐藏到托盘。');
    }
    const child = spawn(app.exe, ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`],
      { detached: true, stdio: 'ignore', windowsHide: false });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } else {
    const { stdout } = await exec('/bin/ps', ['-axww', '-o', 'command='], processOptions());
    if (stdout.split('\n').some(line => line.trim().startsWith(app.exe))) {
      throw new Error('客户端正在运行但未开启调试连接。普通实例请先用 ⌘Q 退出再从助手启动；DLP 实例请从原 DLP 安全终端重新运行 gpt-safe，并点击「连接 DLP 客户端额度」。程序不会强制结束聊天。');
    }
    await exec('/usr/bin/open', ['-na', app.bundle, '--args', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`]);
  }
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    try { await assertAppListener(port); return; } catch { /* Wait for startup. */ }
  }
  throw new Error('客户端已启动，但 CDP 端口未就绪。请检查此版本是否支持 remote-debugging-port。');
}
async function requireClient() {
  const endpoints = await endpointStatus(ports);
  if (!endpoints.some(value => value.connected)) {
    throw new Error(`未发现可连接的客户端：${endpoints.map(value => `${value.port}: ${value.error}`).join('；')}`);
  }
}
async function start() {
  await mkdir(STATE, { recursive: true, mode: 0o700 });
  // Serialize double-clicks without ever overwriting an existing daemon state.
  const lockPath = path.join(STATE, 'start.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('另一个启动操作正在进行；若上次启动被强制结束，请删除 codex-sidebar/.state/start.lock 后重试。');
    throw error;
  }
  try {
    const state = await readState();
    if (await matchesProcess(state)) {
      const activePorts = state.ports || [state.port];
      if (activePorts.length !== ports.length || ports.some(value => !activePorts.includes(value))) {
        throw new Error('后台正在使用其他端口，请先 stop 再启动');
      }
      if (args.includes('--attach-only')) await requireClient();
      else if (!args.includes('--watch')) await launch();
      console.log(`额度侧栏已运行（PID ${state.pid}，端口 ${activePorts.join(',')}）`);
      return;
    }
    if (args.includes('--attach-only')) await requireClient();
    else if (!args.includes('--watch')) await launch();
    const log = await open(LOG, 'a', 0o600);
    const instance = randomUUID();
    const childArgs = [CLI, 'run', '--port', ports.join(','), '--instance', instance];
    if (option('selector')) childArgs.push('--selector', option('selector'));
    const child = spawn(process.execPath, childArgs, { detached: true, windowsHide: true, env: proxyEnvironment(process.env), stdio: ['ignore', log.fd, log.fd], cwd: ROOT });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    await writeFile(STATE_FILE, JSON.stringify({ pid: child.pid, port, ports, instance, startedAt: new Date().toISOString() }), { mode: 0o600 });
    child.unref();
    await log.close();
    console.log(`额度侧栏已启动。日志：${LOG}`);
  } finally { await lock.close(); await unlink(lockPath); }
}
async function cleanWidgets(state) {
  const results = await Promise.allSettled((state?.ports || (state?.port ? [state.port] : ports)).map(removeWidgets));
  if (results.some(result => result.status === 'fulfilled')) console.log('已清理页面卡片。');
}
async function stop() {
  const state = await readState();
  if (!await matchesProcess(state)) {
    console.log('额度侧栏后台未运行。');
    await cleanWidgets(state);
    if (state) await clearState(state.pid);
    return;
  }
  // Windows SIGTERM forcibly kills Node and skips widget disposal. A local
  // request file lets the daemon abort and clean up in its own event loop.
  const stopFile = path.join(STATE, `stop-${state.instance}`);
  if (process.platform === 'win32') await writeFile(stopFile, 'stop');
  else process.kill(state.pid, 'SIGTERM');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (!await matchesProcess(state)) {
      await clearState(state.pid);
      await unlink(stopFile).catch(() => {});
      // Recheck through CDP as a fallback if the client was reconnecting.
      await cleanWidgets(state);
      console.log('额度侧栏已停止，注入卡片已移除。');
      return;
    }
  }
  throw new Error('后台尚未退出，请查看日志后重试；未强制终止进程。');
}

async function main() {
  switch (command) {
    case 'check-update': {
      const result = await inspectUpdate(await updateSource(ROOT));
      console.log(args.includes('--json') ? JSON.stringify(result) : result.message);
      if (result.status === 'blocked') process.exitCode = 1;
      break;
    }
    case 'update': {
      if (!bundled) throw new Error('请在已安装的额度助手中使用更新功能；首次安装请运行 bash codex-sidebar/macos/install.sh。');
      const result = await startUpdate({ source: await updateSource(ROOT), state: STATE,
        bundle: path.resolve(ROOT, '../../..'), enabled: !args.includes('--quota-disabled'),
        dlp: args.includes('--dlp-context') });
      console.log(JSON.stringify(result));
      break;
    }
    case 'dlp-helper': {
      if (!bundled) throw new Error('请通过已安装额度助手的 DLP 启动器调用此命令');
      await mkdir(STATE, { recursive: true, mode: 0o700 });
      let lock;
      const lockPath = path.join(STATE, 'helper-start.lock');
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') return; throw error; }
      try {
        const result = await ensureDlpHelper({ bundle: path.resolve(ROOT, '../../..'), log: LOG, stopDaemon: stop });
        console.log(result.reused ? 'DLP 额度助手已在运行' : '已从 DLP 上下文启动额度助手');
      } finally { await lock.close(); await unlink(lockPath); }
      break;
    }
    case 'start': await start(); break;
    case 'launch': await launch(); console.log('客户端 CDP 已就绪'); break;
    case 'run': {
      const controller = new AbortController();
      const instance = option('instance');
      const stopFile = instance ? path.join(STATE, `stop-${instance}`) : null;
      const stopTimer = stopFile ? setInterval(() => {
        void access(stopFile).then(() => controller.abort()).catch(() => {});
      }, 250) : null;
      process.once('SIGTERM', () => controller.abort());
      process.once('SIGINT', () => controller.abort());
      const log = message => console.log(`${new Date().toISOString()} ${message}`);
      log(`额度侧栏后台已启动，CDP 127.0.0.1 端口 ${ports.join(', ')}`);
      try { await runDaemon({ ports, selector: option('selector'), signal: controller.signal, log }); }
      finally {
        if (stopTimer) clearInterval(stopTimer);
        if (stopFile) await unlink(stopFile).catch(() => {});
        await clearState(process.pid);
      }
      // fetch() may still have an outstanding network timeout when quitting.
      process.exit(0);
      break;
    }
    case 'stop': case 'remove': await stop(); break;
    case 'status': case 'doctor': {
      const state = await readState();
      const running = await matchesProcess(state);
      const endpoints = await endpointStatus(state?.ports || (state?.port ? [state.port] : ports));
      const connected = endpoints.some(value => value.connected);
      const pages = endpoints.reduce((total, value) => total + value.pages, 0);
      const activePort = endpoints.find(value => value.connected)?.port || port;
      const error = connected ? null : endpoints.map(value => `${value.port}: ${value.error}`).join('；');
      if (args.includes('--json')) {
        console.log(JSON.stringify({ running, connected, pages, endpoints, port: activePort, pid: running ? state.pid : null, log: LOG, error }));
      } else {
        console.log(running ? `后台运行中（PID ${state.pid}）` : '后台未运行');
        console.log(connected ? `CDP 本机端口 ${activePort} 正常；可连接的应用页面：${pages}` : `CDP 未就绪：${error}`);
        console.log(`日志：${LOG}`);
      }
      break;
    }
    default: console.log('用法：node cli.mjs start|stop|status|doctor|run|launch|check-update|update [--port 9341,9342] [--app 客户端路径] [--selector CSS选择器] [--attach-only|--watch] [--json]');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
