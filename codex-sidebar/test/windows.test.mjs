import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
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
  const trayLauncher = fileURLToPath(new URL('../windows/tray.vbs', import.meta.url));
  const run = promisify(execFile);
  try {
    const desktop = path.join(dir, 'Desktop');
    const programs = path.join(dir, 'Programs');
    const backup = path.join(dir, 'Backup');
    const invoke = () => run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-DesktopDirectory', desktop, '-ProgramsDirectory', programs, '-TaskbarDirectory', path.join(dir, 'TaskBar'),
      '-BackupDirectory', backup], { windowsHide: true });
    // Legacy duplicate entries that the installer must retire with a backup.
    const legacyCodex = path.join(desktop, 'Codex.lnk');
    const legacyAssistant = path.join(desktop, 'Codex 额度助手.lnk');
    await mkdir(desktop, { recursive: true });
    await run('powershell.exe', ['-NoProfile', '-Command',
      `$w = New-Object -ComObject WScript.Shell; $s = $w.CreateShortcut('${legacyCodex}'); ` +
      `$s.TargetPath = 'D:\\WindowsApps\\OpenAI.Codex_26.1106.6628.0_x64__test\\app\\ChatGPT.exe'; $s.Save(); ` +
      `$s = $w.CreateShortcut('${legacyAssistant}'); $s.TargetPath = 'C:\\Windows\\System32\\wscript.exe'; ` +
      `$s.Arguments = '"${trayLauncher}"'; $s.Save()`], { windowsHide: true });
    const legacyBytes = await readFile(legacyCodex);
    const assistantBytes = await readFile(legacyAssistant);
    await invoke();
    const inspect = `& { $wsh = New-Object -ComObject WScript.Shell; $link = $wsh.CreateShortcut('${path.join(desktop, 'Codex 额度侧栏.lnk').replaceAll("'", "''")}'); $link | Select-Object TargetPath,Arguments,WorkingDirectory,IconLocation | ConvertTo-Json -Compress }`;
    const readLink = async () => JSON.parse((await run('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from('[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' + inspect, 'utf16le').toString('base64')], { windowsHide: true })).stdout);
    const first = await readLink();
    assert.match(first.TargetPath, /wscript\.exe$/i);
    assert.match(first.Arguments, /launch\.vbs"$/);
    assert.doesNotMatch(first.Arguments, /WindowsApps/);
    await assert.rejects(readFile(legacyCodex), /ENOENT/);
    await assert.rejects(readFile(legacyAssistant), /ENOENT/);
    assert.deepEqual(await readFile(path.join(backup, 'Desktop-Codex.lnk')), legacyBytes);
    assert.deepEqual(await readFile(path.join(backup, 'Desktop-Assistant.lnk')), assistantBytes);
    await invoke();
    assert.deepEqual(await readLink(), first);
    await readFile(path.join(programs, 'Codex 额度侧栏.lnk'));
    await readFile(path.join(desktop, 'Codex 额度侧栏.lnk'));
    // The second install backs up the first shortcut instead of discarding it.
    await readFile(path.join(backup, 'Desktop-Quota.lnk'));
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

// ---- Tray assistant (Windows counterpart of the macOS menu bar helper) ----

const trayRun = promisify(execFile);
const trayEncoded = source => trayRun('powershell.exe', ['-NoProfile', '-EncodedCommand',
  Buffer.from('[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = "Stop"; ' + source, 'utf16le').toString('base64')],
  { windowsHide: true, timeout: 25000 });
const trayFakeCli = callsPath => `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
if (args[0] === 'status' && args.includes('--json')) {
  console.log(JSON.stringify({ running: false, connected: false, pages: 0, endpoints: [{ port: 9341, connected: false, pages: 0, error: '等待客户端开启调试连接' }], port: 9341, pid: null, log: 'test.log', error: null }));
} else { console.log('ok'); }
`;
const trayReadCalls = async callsPath => (await readFile(callsPath, 'utf8').catch(() => ''))
  .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const trayWaitFor = async (probe, timeout) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('tray test timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
};
const trayProcessCount = dir => trayEncoded(
  `@(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -like '*tray.ps1*' -and $_.CommandLine -like '*${dir.replaceAll("'", "''")}*' }).Count | ConvertTo-Json`
).then(({ stdout }) => JSON.parse(stdout));
const traySignalQuit = instance => trayEncoded(
  `[System.Threading.EventWaitHandle]::OpenExisting('Local\\CodexQuotaTrayQuit-${instance}').Set() | Out-Null; $true | ConvertTo-Json`);
const trayKillLeftovers = async (dir, instance) => {
  await traySignalQuit(instance).catch(() => {});
  await trayWaitFor(async () => (await trayProcessCount(dir).catch(() => 1)) === 0, 8000).catch(() => {});
  await trayEncoded(`Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -like '*tray.ps1*' -and $_.CommandLine -like '*${dir.replaceAll("'", "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; $true | ConvertTo-Json`).catch(() => {});
};

test('Windows tray assistant generates a multi-size gauge icon without Node', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quota tray icon '));
  const script = fileURLToPath(new URL('../windows/tray.ps1', import.meta.url));
  try {
    const ico = path.join(dir, 'quota.ico');
    await trayRun('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-MakeIcon', ico], { windowsHide: true, timeout: 25000 });
    const bytes = await readFile(ico);
    assert.equal(bytes.readUInt16LE(0), 0);
    assert.equal(bytes.readUInt16LE(2), 1);
    const count = bytes.readUInt16LE(4);
    assert.ok(count >= 4, 'icon must cover several DPI sizes');
    const sizes = [];
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16;
      const size = bytes[entry] || 256;
      sizes.push(size);
      const length = bytes.readUInt32LE(entry + 8);
      const offset = bytes.readUInt32LE(entry + 12);
      assert.ok(offset + length <= bytes.length, 'image payload must stay inside the file');
      // BMP-in-ICO: BITMAPINFOHEADER with doubled height and 32bpp BGRA.
      assert.equal(bytes.readUInt32LE(offset), 40);
      assert.equal(bytes.readUInt32LE(offset + 8), size * 2);
      assert.equal(bytes.readUInt16LE(offset + 14), 32);
    }
    assert.ok(sizes.includes(16) && sizes.includes(32));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Windows tray launcher hides the console and targets tray.ps1', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const vbs = fileURLToPath(new URL('../windows/tray.vbs', import.meta.url));
  const { stdout } = await trayRun('cscript.exe', ['//nologo', vbs, '--print-command'], { windowsHide: true, timeout: 15000 });
  assert.match(stdout, /powershell\.exe/);
  assert.match(stdout, /-STA/);
  assert.match(stdout, /-WindowStyle Hidden/);
  assert.match(stdout, /tray\.ps1/);
});

test('Windows tray assistant runs hidden, keeps a single instance and quits through the stop request', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quota tray 中文 '));
  const windows = path.join(dir, 'codex-sidebar', 'windows');
  const stateDir = path.join(dir, 'state');
  const calls = path.join(dir, 'calls.jsonl');
  const instance = randomUUID();
  const children = [];
  try {
    await mkdir(windows, { recursive: true });
    for (const name of ['tray.ps1', 'tray.vbs']) {
      await copyFile(fileURLToPath(new URL('../windows/' + name, import.meta.url)), path.join(windows, name));
    }
    await writeFile(path.join(dir, 'codex-sidebar', 'cli.mjs'), trayFakeCli(calls));
    const env = { ...process.env, CODEX_QUOTA_STATE_DIR: stateDir, CODEX_QUOTA_TRAY_INSTANCE: instance, QUOTA_TEST_CALLS: calls };
    const psArgs = ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', path.join(windows, 'tray.ps1')];
    const first = spawn('powershell.exe', psArgs, { env, windowsHide: true, stdio: 'ignore' });
    children.push(first);
    await trayWaitFor(async () => (await trayReadCalls(calls)).some(args => args[0] === 'status' && args.includes('--json')), 45000);
    // A second launch must exit instead of creating another tray process.
    const second = spawn('powershell.exe', psArgs, { env, windowsHide: true, stdio: 'ignore' });
    children.push(second);
    const secondCode = await new Promise(resolve => second.once('exit', resolve));
    assert.equal(secondCode, 0);
    assert.equal(await trayProcessCount(dir), 1);
    // External quit request: the assistant stops the quota daemon before exiting.
    await trayWaitFor(() => traySignalQuit(instance).then(() => true).catch(() => false), 10000);
    await trayWaitFor(async () => first.exitCode !== null, 30000);
    assert.equal(first.exitCode, 0);
    assert.ok((await trayReadCalls(calls)).some(args => args[0] === 'stop'), 'quit must stop the quota daemon');
    const trayState = JSON.parse(await readFile(path.join(stateDir, 'tray.json'), 'utf8'));
    assert.equal(trayState.quotaEnabled, false);
  } finally {
    for (const child of children) { if (child.exitCode === null) child.kill(); }
    await trayKillLeftovers(dir, instance);
    await rm(dir, { recursive: true, force: true });
  }
});

test('Windows start launcher attaches the tray assistant after a successful start', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quota tray attach '));
  const windows = path.join(dir, 'codex-sidebar', 'windows');
  const stateDir = path.join(dir, 'state');
  const calls = path.join(dir, 'calls.jsonl');
  const instance = randomUUID();
  try {
    await mkdir(windows, { recursive: true });
    for (const name of ['sidebar.ps1', 'tray.ps1', 'tray.vbs']) {
      await copyFile(fileURLToPath(new URL('../windows/' + name, import.meta.url)), path.join(windows, name));
    }
    await writeFile(path.join(dir, 'codex-sidebar', 'cli.mjs'), trayFakeCli(calls));
    const env = { ...process.env, CODEX_QUOTA_STATE_DIR: stateDir, CODEX_QUOTA_TRAY_INSTANCE: instance, QUOTA_TEST_CALLS: calls };
    const { stdout } = await trayRun('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(windows, 'sidebar.ps1'), '-Action', 'start'],
      { env, windowsHide: true, timeout: 60000 });
    assert.match(stdout, /ok/);
    // The attached tray polls status and persists the enabled intent.
    await trayWaitFor(async () => {
      try { return JSON.parse(await readFile(path.join(stateDir, 'tray.json'), 'utf8')).quotaEnabled === true; }
      catch { return false; }
    }, 45000);
    await trayWaitFor(async () => (await trayReadCalls(calls)).some(args => args[0] === 'status' && args.includes('--json')), 30000);
    await trayWaitFor(() => traySignalQuit(instance).then(() => true).catch(() => false), 10000);
    await trayWaitFor(async () => (await trayReadCalls(calls)).some(args => args[0] === 'stop'), 30000);
    await trayWaitFor(async () => (await trayProcessCount(dir)) === 0, 30000);
  } finally {
    await trayKillLeftovers(dir, instance);
    await rm(dir, { recursive: true, force: true });
  }
});
