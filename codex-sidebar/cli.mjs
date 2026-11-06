#!/usr/bin/env node
import { mkdir, readFile, writeFile, unlink, open, access, realpath } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertAppListener, removeWidgets, runDaemon } from './lib/daemon.mjs';
import { listTargets, isAppTarget } from './lib/cdp.mjs';
import { matchesDaemonProcess, processOptions } from './lib/process.mjs';

const exec = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE = process.env.CODEX_QUOTA_STATE_DIR ? path.resolve(process.env.CODEX_QUOTA_STATE_DIR) : path.join(ROOT, '.state');
const STATE_FILE = path.join(STATE, 'daemon.json');
const LOG = path.join(STATE, 'sidebar.log');
const CLI = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const command = args.shift() || 'help';
function option(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
}
const port = Number(option('port', '9341'));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须为 1024–65535');

async function readState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const matchesProcess = state => matchesDaemonProcess(state, CLI);
async function clearState(pid) {
  if ((await readState())?.pid === pid) await unlink(STATE_FILE).catch(() => {});
}
async function appBundle() {
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
  try { await assertAppListener(port); return; } catch { /* Not already listening. */ }
  const app = await appBundle();
  const { stdout } = await exec('/bin/ps', ['-ww', '-axo', 'comm='], processOptions());
  if (stdout.split('\n').some(line => line.trim() === app.exe)) {
    throw new Error('客户端正在运行但未开启调试连接。请先用 ⌘Q 完全退出客户端，再从额度助手菜单点击「启动客户端与额度」。程序不会强制结束聊天。');
  }
  await exec('/usr/bin/open', ['-na', app.bundle, '--args', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`]);
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    try { await assertAppListener(port); return; } catch { /* Wait for startup. */ }
  }
  throw new Error('客户端已启动，但 CDP 端口未就绪。请检查此版本是否支持 remote-debugging-port。');
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
    if (await matchesProcess(state)) { console.log(`额度侧栏已运行（PID ${state.pid}，端口 ${state.port}）`); return; }
    if (args.includes('--attach-only')) await assertAppListener(port);
    else await launch();
    const log = await open(LOG, 'a', 0o600);
    const instance = randomUUID();
    const childArgs = [CLI, 'run', '--port', String(port), '--instance', instance];
    if (option('selector')) childArgs.push('--selector', option('selector'));
    const child = spawn(process.execPath, childArgs, { detached: true, stdio: ['ignore', log.fd, log.fd], cwd: ROOT });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    await writeFile(STATE_FILE, JSON.stringify({ pid: child.pid, port, instance, startedAt: new Date().toISOString() }), { mode: 0o600 });
    child.unref();
    await log.close();
    console.log(`额度侧栏已启动。日志：${LOG}`);
  } finally { await lock.close(); await unlink(lockPath); }
}
async function stop() {
  const state = await readState();
  if (!await matchesProcess(state)) {
    console.log('额度侧栏后台未运行。');
    try { await removeWidgets(state?.port || port); console.log('已清理页面卡片。'); } catch { /* App may be closed. */ }
    if (state) await clearState(state.pid);
    return;
  }
  process.kill(state.pid, 'SIGTERM');
  for (let i = 0; i < 40; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (!await matchesProcess(state)) {
      await clearState(state.pid);
      console.log('额度侧栏已停止，注入卡片已移除。');
      return;
    }
  }
  throw new Error('后台尚未退出，请查看日志后重试；未强制终止进程。');
}

async function main() {
  switch (command) {
    case 'start': await start(); break;
    case 'launch': await launch(); console.log('客户端 CDP 已就绪'); break;
    case 'run': {
      const controller = new AbortController();
      process.once('SIGTERM', () => controller.abort());
      process.once('SIGINT', () => controller.abort());
      const log = message => console.log(`${new Date().toISOString()} ${message}`);
      log(`额度侧栏后台已启动，CDP 127.0.0.1:${port}`);
      try { await runDaemon({ port, selector: option('selector'), signal: controller.signal, log }); }
      finally { await clearState(process.pid); }
      // fetch() may still have an outstanding network timeout when quitting.
      process.exit(0);
      break;
    }
    case 'stop': case 'remove': await stop(); break;
    case 'status': case 'doctor': {
      const state = await readState();
      const running = await matchesProcess(state);
      const activePort = state?.port || port;
      let connected = false;
      let pages = 0;
      let error = null;
      try {
        await assertAppListener(activePort);
        const targets = (await listTargets(activePort)).filter(isAppTarget);
        connected = true;
        pages = targets.length;
      } catch (failure) { error = failure.message; }
      if (args.includes('--json')) {
        console.log(JSON.stringify({ running, connected, pages, port: activePort, pid: running ? state.pid : null, log: LOG, error }));
      } else {
        console.log(running ? `后台运行中（PID ${state.pid}）` : '后台未运行');
        console.log(connected ? `CDP 本机端口 ${activePort} 正常；可连接的应用页面：${pages}` : `CDP 未就绪：${error}`);
        console.log(`日志：${LOG}`);
      }
      break;
    }
    default: console.log('用法：node cli.mjs start|stop|status|doctor|run|launch [--port 9341] [--app /Applications/ChatGPT.app] [--selector CSS选择器] [--attach-only] [--json]');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
