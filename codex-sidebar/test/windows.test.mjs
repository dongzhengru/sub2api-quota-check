import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { assertWindowsListener, isWindowsAppExecutable, findWindowsApp, matchesWindowsDaemon } from '../lib/windows.mjs';

const exe = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1103.4239.0_x64__test\\app\\ChatGPT.exe';
const snapshot = () => ({ listeners: [{ LocalAddress: '127.0.0.1', OwningProcess: 123 }],
  processes: [{ ProcessId: 123, ParentProcessId: 1, ExecutablePath: exe }] });
const runWith = value => async (file, args, options) => {
  assert.match(file, /powershell\.exe$/i);
  assert.equal(options.windowsHide, true);
  assert.ok(args.includes('-NoProfile'));
  return { stdout: JSON.stringify(value) };
};

test('Windows executable trust accepts packaged Codex but rejects unrelated executables', () => {
  assert.equal(isWindowsAppExecutable(exe), true);
  assert.equal(isWindowsAppExecutable('C:\\Users\\me\\AppData\\Local\\Programs\\Codex\\Codex.exe'), true);
  for (const value of ['C:\\Temp\\ChatGPT.exe', 'C:\\Codex.exe', exe.replace('ChatGPT.exe', 'node.exe'), exe + '.old']) {
    assert.equal(isWindowsAppExecutable(value), false);
  }
});

test('Windows listener requires a loopback socket belonging to the real client', async () => {
  await assertWindowsListener(9341, runWith(snapshot()));
  const publicSocket = snapshot(); publicSocket.listeners[0].LocalAddress = '0.0.0.0';
  await assert.rejects(assertWindowsListener(9341, runWith(publicSocket)), /127.0.0.1/);
  const foreign = snapshot(); foreign.processes[0].ExecutablePath = 'C:\\Temp\\ChatGPT.exe';
  await assert.rejects(assertWindowsListener(9341, runWith(foreign)), /不属于/);
  await assert.rejects(assertWindowsListener(9341, runWith({ listeners: [], processes: [] })), /127.0.0.1/);
});

test('Windows listener accepts descendants but rejects foreign socket holders and cycles', async () => {
  const value = snapshot();
  value.listeners.push({ LocalAddress: '127.0.0.1', OwningProcess: 456 });
  value.processes.push({ ProcessId: 456, ParentProcessId: 123, ExecutablePath: 'C:\\Tools\\helper.exe' });
  await assertWindowsListener(9341, runWith(value));
  value.processes[1].ParentProcessId = 456;
  await assert.rejects(assertWindowsListener(9341, runWith(value)), /不属于客户端/);
});

test('Windows daemon identity respects quoted paths and exact instance arguments', async () => {
  const cli = 'D:\\My Projects\\额度查询\\cli.mjs';
  const state = { pid: 123, instance: 'abc-123' };
  const commandLine = `"C:\\Program Files\\nodejs\\node.exe" "${cli}" run --port 9341 --instance abc-123 --selector "aside .sidebar"`;
  const query = CommandLine => runWith({ ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe', CommandLine });
  assert.equal(await matchesWindowsDaemon(state, cli, query(commandLine)), true);
  assert.equal(await matchesWindowsDaemon({ ...state, instance: 'abc' }, cli, query(commandLine)), false);
  assert.equal(await matchesWindowsDaemon(state, cli + '.old', query(commandLine)), false);
  assert.equal(await matchesWindowsDaemon(state, cli, query(commandLine.replace(' run ', ' status '))), false);
  assert.equal(await matchesWindowsDaemon(state, cli, query(null)), false);
});

test('Windows application discovery prefers running packaged clients and validates explicit paths', async () => {
  const run = runWith({ running: [exe], installed: [] });
  assert.equal((await findWindowsApp({ run, exists: async () => true })).exe, exe);
  assert.equal((await findWindowsApp({ run: runWith({ running: [], installed: [exe] }), exists: async () => true })).exe, exe);
  await assert.rejects(findWindowsApp({ explicit: 'C:\\Temp\\ChatGPT.exe', run, exists: async () => true }), /不支持/);
  await assert.rejects(findWindowsApp({ run: runWith({ running: [], installed: [] }), exists: async () => false }), /未找到/);
});

test('real Windows background lifecycle reuses the daemon and stops it cleanly', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'quota lifecycle 中文 '));
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const invoke = (...args) => promisify(execFile)(process.execPath, [cli, ...args, '--port', String(port)], {
    env: { ...process.env, CODEX_QUOTA_STATE_DIR: stateDir }, windowsHide: true, timeout: 25000,
  });
  try {
    await invoke('start', '--watch');
    const first = JSON.parse(await readFile(path.join(stateDir, 'daemon.json'), 'utf8'));
    assert.equal(await matchesWindowsDaemon(first, cli), true);
    await invoke('start', '--watch');
    assert.equal(JSON.parse(await readFile(path.join(stateDir, 'daemon.json'), 'utf8')).pid, first.pid);
    // --attach-only must verify the client even when a waiting daemon exists.
    await assert.rejects(invoke('start', '--attach-only'), /127\.0\.0\.1/);
    await invoke('stop');
    assert.equal(await matchesWindowsDaemon(first, cli), false);
    await assert.rejects(readFile(path.join(stateDir, 'daemon.json')), { code: 'ENOENT' });
  } finally {
    await invoke('stop').catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});
