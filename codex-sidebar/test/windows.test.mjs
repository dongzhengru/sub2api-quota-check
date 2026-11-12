import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { assertWindowsListener, isWindowsAppExecutable, findWindowsApp, matchesWindowsDaemon } from '../lib/windows.mjs';

test('Windows explicit restart stops only the matching main process, allowing for CIM timestamp precision', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const { restartWindowsApp } = await import('../lib/windows.mjs');
  const base = path.join(process.env.LOCALAPPDATA, 'Codex');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'app-quota-test-'));
  const fixture = path.join(dir, 'Codex.exe');
  const children = [];
  try {
    await copyFile(process.execPath, fixture);
    for (const extra of [[], ['--', '--type=renderer']]) {
      const child = spawn(fixture, ['-e', 'setInterval(()=>{},1000)', ...extra], { stdio: 'ignore', windowsHide: true });
      children.push(child);
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    }
    await restartWindowsApp(fixture);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.notEqual(children[0].exitCode, null);
    assert.equal(children[1].exitCode, null, 'renderer must not be selected as an application main process');
    await assert.rejects(restartWindowsApp('C:\\Temp\\Codex.exe'), /不支持/);
  } finally {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve); child.kill();
    })));
    await rm(dir, { recursive: true, force: true });
  }
});

test('Windows shortcut installation replaces ordinary entries with a hidden, version-independent launcher', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quota shortcuts 中文 '));
  const script = fileURLToPath(new URL('../windows/install.ps1', import.meta.url));
  const run = promisify(execFile);
  try {
    const desktop = path.join(dir, 'Desktop');
    const programs = path.join(dir, 'Programs');
    const backup = path.join(dir, 'Backup');
    const invoke = () => run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-DesktopDirectory', desktop, '-ProgramsDirectory', programs, '-TaskbarDirectory', path.join(dir, 'TaskBar'),
      '-BackupDirectory', backup], { windowsHide: true });
    await invoke();
    const inspect = `& { $wsh = New-Object -ComObject WScript.Shell; $link = $wsh.CreateShortcut('${path.join(desktop, 'Codex.lnk').replaceAll("'", "''")}'); $link | Select-Object TargetPath,Arguments,WorkingDirectory,IconLocation | ConvertTo-Json -Compress }`;
    const readLink = async () => JSON.parse((await run('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from('[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' + inspect, 'utf16le').toString('base64')], { windowsHide: true })).stdout);
    const first = await readLink();
    assert.match(first.TargetPath, /wscript\.exe$/i);
    assert.match(first.Arguments, /launch\.vbs"$/);
    assert.doesNotMatch(first.Arguments, /WindowsApps/);
    await invoke();
    assert.deepEqual(await readLink(), first);
    await readFile(path.join(programs, 'Codex.lnk'));
    await readFile(path.join(desktop, 'Codex 额度侧栏.lnk'));
    // The second install backs up the first shortcut instead of discarding it.
    await readFile(path.join(backup, 'Desktop-Codex.lnk'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Windows installer repairs the pinned Codex entry and its real hidden launch chain', { skip: process.platform !== 'win32', timeout: 40000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quota pinned 中文 '));
  const windows = path.join(dir, 'codex-sidebar', 'windows');
  const taskbar = path.join(dir, 'TaskBar');
  const backup = path.join(dir, 'Backup');
  const marker = path.join(dir, 'launched.json');
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const run = promisify(execFile);
  const ps = source => run('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = "Stop"; ' + source,
    'utf16le').toString('base64')], { windowsHide: true, timeout: 30000 });
  try {
    await mkdir(windows, { recursive: true });
    await mkdir(taskbar);
    for (const name of ['install.ps1', 'sidebar.ps1', 'launch.vbs']) {
      await copyFile(fileURLToPath(new URL('../windows/' + name, import.meta.url)), path.join(windows, name));
    }
    // A real shortcut launch traverses WScript -> PowerShell -> Node, without
    // touching the user's running client, quota daemon, or actual taskbar.
    await writeFile(path.join(dir, 'codex-sidebar', 'cli.mjs'),
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));`);
    const pinned = path.join(taskbar, 'Codex.lnk');
    const unrelated = path.join(taskbar, 'Other.lnk');
    await ps(`$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut(${quote(pinned)}); ` +
      `$s.TargetPath='D:\\WindowsApps\\OpenAI.Codex_26.1106.6628.0_x64__test\\app\\ChatGPT.exe'; $s.Save(); ` +
      `$s=$w.CreateShortcut(${quote(unrelated)}); $s.TargetPath='C:\\Windows\\notepad.exe'; $s.Save()`);
    const original = await readFile(pinned);
    const other = await readFile(unrelated);
    const install = () => run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(windows, 'install.ps1'),
      '-DesktopDirectory', path.join(dir, 'Desktop'), '-ProgramsDirectory', path.join(dir, 'Programs'),
      '-TaskbarDirectory', taskbar, '-BackupDirectory', backup], { windowsHide: true, timeout: 30000 });
    await install();
    const { stdout } = await ps(`$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut(${quote(pinned)}); ` +
      `$s | Select-Object TargetPath,Arguments | ConvertTo-Json -Compress`);
    const link = JSON.parse(stdout);
    assert.match(link.TargetPath, /wscript\.exe$/i);
    assert.equal(link.Arguments, '"' + path.join(windows, 'launch.vbs') + '"');
    assert.deepEqual(await readFile(path.join(backup, 'TaskBar-Codex.lnk')), original);
    assert.deepEqual(await readFile(unrelated), other);
    await ps(`Start-Process -FilePath ${quote(pinned)}`);
    let launched;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      try { launched = JSON.parse(await readFile(marker, 'utf8')); break; } catch { /* hidden startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual(launched, ['start']);
    await install();
    assert.deepEqual(await readFile(path.join(backup, 'TaskBar-Codex.lnk')), original);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Windows start reports a distinct restart-needed status without terminating the running client', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const { windowsAppRunning, findWindowsApp } = await import('../lib/windows.mjs');
  const app = await findWindowsApp().catch(() => null);
  if (!app || !await windowsAppRunning(app.exe)) return t.skip('Requires a running desktop client');
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const dir = await mkdtemp(path.join(tmpdir(), 'quota restart check '));
  try {
    await assert.rejects(promisify(execFile)(process.execPath, [cli, 'start', '--port', '65534'], {
      env: { ...process.env, CODEX_QUOTA_STATE_DIR: dir }, windowsHide: true, timeout: 25000,
    }), error => error.code === 2 && /未开启调试连接/.test(error.stderr));
    assert.equal(await windowsAppRunning(app.exe), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const exe = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1103.4239.0_x64__test\\app\\ChatGPT.exe';
const snapshot = () => ({ listeners: [{ LocalAddress: '127.0.0.1', OwningProcess: 123 }],
  processes: [{ ProcessId: 123, ParentProcessId: 1, ExecutablePath: exe }] });
const runWith = value => async (file, args, options) => {
  assert.match(file, /powershell\.exe$/i);
  assert.equal(options.windowsHide, true);
  assert.ok(args.includes('-NoProfile'));
  return { stdout: JSON.stringify(value) };
};

test('Windows launcher renders native diagnostics as plain text rather than PowerShell error records', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const script = fileURLToPath(new URL('../windows/sidebar.ps1', import.meta.url));
  const dir = await mkdtemp(path.join(tmpdir(), 'quota diagnostics '));
  try {
    const { stdout, stderr } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'status'], {
      windowsHide: true, timeout: 25000, env: { ...process.env, CODEX_QUOTA_STATE_DIR: dir, HTTP_PROXY: 'http://127.0.0.1:1' },
    });
    assert.doesNotMatch(stdout + stderr, /CategoryInfo|FullyQualifiedErrorId/);
    assert.match(stdout, /后台未运行/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

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
