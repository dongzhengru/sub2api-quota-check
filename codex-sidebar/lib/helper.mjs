import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { open } from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);

export function proxyEnvironment(environment) {
  return { ...environment, NODE_USE_ENV_PROXY: '1',
    NO_PROXY: `localhost,127.0.0.1,::1,${environment.NO_PROXY || environment.no_proxy || ''}`,
    no_proxy: `localhost,127.0.0.1,::1,${environment.no_proxy || environment.NO_PROXY || ''}` };
}

// Launch directly: LaunchServices/open does not preserve the safe terminal context.
export async function ensureDlpHelper({ bundle, log, stopDaemon, run = exec, launch = spawn }) {
  const executable = path.join(bundle, 'Contents/MacOS/CodexQuota');
  const { stdout: id } = await run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleIdentifier', path.join(bundle, 'Contents/Info.plist')]);
  if (id.trim() !== 'top.zhengru.codex-quota') throw new Error('未识别的额度助手应用');
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,comm=']);
  const old = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match || match[2] !== executable) continue;
    const pid = Number(match[1]);
    const result = await run('/bin/ps', ['-p', String(pid), '-o', 'command=']);
    if (/\s--dlp-context(?:\s|$)/.test(result.stdout)) return { reused: true, pid };
    old.push(pid);
  }
  for (const pid of old) {
    // Recheck the executable immediately before signalling this application's PID.
    const current = await run('/bin/ps', ['-p', String(pid), '-o', 'comm=']);
    if (current.stdout.trim() !== executable) throw new Error('额度助手进程已变化，请重试');
    process.kill(pid, 'SIGTERM');
    let exited = false;
    for (let i = 0; i < 40; i++) {
      try {
        const next = await run('/bin/ps', ['-p', String(pid), '-o', 'comm=']);
        if (next.stdout.trim() !== executable) { exited = true; break; }
      } catch { exited = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!exited) throw new Error('旧额度助手尚未退出，未启动第二个助手');
  }
  await stopDaemon();
  const output = await open(log, 'a', 0o600);
  try {
    const child = launch(executable, ['--attach-existing', '--dlp-context'], {
      detached: true, stdio: ['ignore', output.fd, output.fd], env: proxyEnvironment(process.env),
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { reused: false, pid: child.pid };
  } finally { await output.close(); }
}
