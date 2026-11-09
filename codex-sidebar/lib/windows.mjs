// Windows client discovery and OS-backed process/listener verification.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);
const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

async function query(script, run) {
  // PowerShell 5.1 needs encoded source and explicit UTF-8 output for Chinese paths.
  const source = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $ErrorActionPreference = 'Stop'; ${script}`;
  const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || 'null');
}

export function isWindowsAppExecutable(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.replaceAll('/', '\\');
  return /^[A-Z]:\\Program Files\\WindowsApps\\OpenAI\.(?:Codex|ChatGPT)_[^\\]+\\app\\(?:Codex|ChatGPT)\.exe$/i.test(normalized) ||
    /^[A-Z]:\\Users\\[^\\]+\\AppData\\Local\\(?:Programs\\)?(?:Codex|ChatGPT|OpenAI\\(?:Codex|ChatGPT))\\(?:app-[^\\]+\\)?(?:Codex|ChatGPT)\.exe$/i.test(normalized) ||
    /^[A-Z]:\\Program Files(?: \(x86\))?\\(?:Codex|ChatGPT)\\(?:Codex|ChatGPT)\.exe$/i.test(normalized);
}

export async function assertWindowsListener(port, run = exec) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('CDP 端口无效');
  const value = await query(`$sockets = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object LocalAddress,OwningProcess); ` +
    `$processes = @(); if ($sockets.Count) { $processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath) }; ` +
    `@{listeners=$sockets;processes=$processes} | ConvertTo-Json -Depth 4 -Compress`, run);
  const listeners = value?.listeners || [];
  if (!listeners.length || listeners.some(item => item.LocalAddress !== '127.0.0.1')) throw new Error('CDP 必须仅监听 127.0.0.1');
  const processes = new Map((value.processes || []).map(item => [item.ProcessId, item]));
  const verified = new Set(listeners.map(item => item.OwningProcess).filter(pid => isWindowsAppExecutable(processes.get(pid)?.ExecutablePath)));
  if (!verified.size) throw new Error('CDP 端口不属于 Codex / ChatGPT 客户端');
  for (const listener of listeners) {
    let pid = listener.OwningProcess;
    const seen = new Set();
    while (!verified.has(pid) && pid > 1 && !seen.has(pid) && seen.size < 32) {
      seen.add(pid);
      pid = processes.get(pid)?.ParentProcessId;
    }
    if (!verified.has(pid)) throw new Error('CDP 端口存在不属于客户端的监听进程');
  }
}

// Parse CommandLineToArgvW quoting, including quoted paths and escaped quotes.
export function windowsArguments(command) {
  const result = [];
  let current = '', quoted = false, started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === '\\') {
      let end = i;
      while (command[end] === '\\') end++;
      const count = end - i;
      if (command[end] === '"') {
        current += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) current += '"'; else quoted = !quoted;
        i = end;
      } else { current += '\\'.repeat(count); i = end - 1; }
      started = true;
    } else if (char === '"') { quoted = !quoted; started = true; }
    else if (/\s/.test(char) && !quoted) {
      if (started) result.push(current);
      current = ''; started = false;
    } else { current += char; started = true; }
  }
  if (started) result.push(current);
  return result;
}

export async function matchesWindowsDaemon(state, cli, run = exec) {
  if (!state || !Number.isInteger(state.pid) || state.pid <= 1 || typeof state.instance !== 'string' || !state.instance) return false;
  try {
    const value = await query(`Get-CimInstance Win32_Process -Filter 'ProcessId = ${state.pid}' | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress`, run);
    if (!value?.CommandLine || !/\\node\.exe$/i.test(value.ExecutablePath || '')) return false;
    const args = windowsArguments(value.CommandLine);
    const instance = args.indexOf('--instance');
    return args[1]?.toLowerCase() === cli.toLowerCase() && args[2] === 'run' && instance > 2 && args[instance + 1] === state.instance;
  } catch { return false; }
}

export async function findWindowsApp({ explicit, run = exec, exists = async file => { try { await access(file); return true; } catch { return false; } } } = {}) {
  if (explicit) {
    const exe = path.win32.resolve(explicit);
    if (!isWindowsAppExecutable(exe)) throw new Error('不支持的客户端路径；请指定已安装 Codex / ChatGPT 的 exe');
    if (!await exists(exe)) throw new Error('指定的客户端文件不存在');
    return { exe, running: false };
  }
  const value = await query(`$running = @(Get-CimInstance Win32_Process -Filter "Name = 'Codex.exe' OR Name = 'ChatGPT.exe'" | Select-Object -ExpandProperty ExecutablePath -ErrorAction SilentlyContinue); ` +
    `$installed = @(Get-AppxPackage -Name OpenAI.Codex; Get-AppxPackage -Name OpenAI.ChatGPT) | ForEach-Object { Join-Path $_.InstallLocation 'app\\ChatGPT.exe'; Join-Path $_.InstallLocation 'app\\Codex.exe' }; ` +
    `@{running=@($running);installed=@($installed)} | ConvertTo-Json -Compress`, run);
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [...(value?.running || []), ...(value?.installed || []),
    ...['Codex', 'ChatGPT'].map(name => path.win32.join(local, 'Programs', name, `${name}.exe`))];
  for (const exe of candidates) {
    if (isWindowsAppExecutable(exe) && await exists(exe)) return { exe, running: (value?.running || []).includes(exe) };
  }
  throw new Error('未找到 Windows Codex / ChatGPT 客户端；可用 --app 指定已安装的 exe 路径');
}

export async function windowsAppRunning(exe, run = exec) {
  const value = await query(`@(Get-CimInstance Win32_Process -Filter "Name = 'Codex.exe' OR Name = 'ChatGPT.exe'" | Select-Object -ExpandProperty ExecutablePath -ErrorAction SilentlyContinue) | ConvertTo-Json -Compress`, run);
  return [value].flat().some(item => typeof item === 'string' && item.toLowerCase() === exe.toLowerCase());
}
