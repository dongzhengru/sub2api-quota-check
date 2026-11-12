import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, readFile, writeFile, copyFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const artifactRoot = path.join(homedir(), '.codex/share/codexNoProject/codex-quota-update');

async function git(repository, args, allowFailure = false) {
  try {
    return (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', repository, ...args], {
      timeout: 60000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    })).stdout.trim();
  } catch (error) {
    if (allowFailure && error.code === 1) return null;
    // Git's stderr may contain a private remote URL. Keep it out of status/logs.
    throw new Error(`Git ${args[0]} 失败，请检查网络、Git 权限或仓库配置后重试。`);
  }
}

export async function updateSource(engine) {
  try { return JSON.parse(await readFile(path.resolve(engine, '../update-source.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const repository = path.resolve(engine, '..');
    return { repository, branch: await git(repository, ['symbolic-ref', '--short', 'HEAD']),
      revision: await git(repository, ['rev-parse', 'HEAD']) };
  }
}

export async function inspectUpdate(source) {
  const { repository, branch, revision } = source;
  const blocked = message => ({ status: 'blocked', message });
  if (!repository || !branch || !revision) return blocked('缺少更新来源，请从 Git 仓库重新安装助手。');
  if (path.resolve(await git(repository, ['rev-parse', '--show-toplevel'])) !== path.resolve(repository)) return blocked('源码位置已变化，请从新的 Git 仓库重新安装助手。');
  if (await git(repository, ['symbolic-ref', '--short', 'HEAD'], true) !== branch) return blocked('源码分支已切换，请切回安装时的分支后更新。');
  if (await git(repository, ['status', '--porcelain', '--untracked-files=normal'])) return blocked('源码有未提交修改，请提交或移走修改后重试。');
  const remote = await git(repository, ['config', '--get', `branch.${branch}.remote`], true);
  const merge = await git(repository, ['config', '--get', `branch.${branch}.merge`], true);
  if (!remote || remote === '.' || !/^[\w.-]+$/.test(remote) || remote.startsWith('-') || !merge?.startsWith('refs/heads/')) {
    return blocked('当前分支未配置远端跟踪分支，请配置后重试。');
  }
  const tracking = `refs/remotes/${remote}/${merge.slice('refs/heads/'.length)}`;
  await git(repository, ['fetch', '--no-tags', '--', remote, `+${merge}:${tracking}`]);
  const target = await git(repository, ['rev-parse', '--verify', `${tracking}^{commit}`]);
  const head = await git(repository, ['rev-parse', 'HEAD']);
  if (await git(repository, ['merge-base', '--is-ancestor', head, target], true) === null) {
    return blocked('本地分支有未推送提交或已分叉，已暂停自动更新。');
  }
  const available = head !== target || revision !== target;
  return { status: available ? 'available' : 'current', head, target,
    message: available ? `发现新版 ${target.slice(0, 7)}，准备拉取并编译。` : '当前已是最新版本。' };
}

async function acquireLock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, 'update.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      return async () => { await handle.close(); await unlink(lockPath); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(lockPath, 'utf8'));
      if (pid > 0) {
        try { process.kill(pid, 0); }
        catch (failure) {
          if (failure.code === 'ESRCH') { await unlink(lockPath); continue; }
        }
      }
      throw new Error('已有更新任务正在运行。');
    }
  }
  throw new Error('无法取得更新锁，请稍后重试。');
}

export async function applyUpdate({ source, install, log = () => {} }) {
  const plan = await inspectUpdate(source);
  log(plan.message);
  if (plan.status !== 'available') return plan;
  // Recheck after the network request; never stash, reset or merge local edits.
  if (await git(source.repository, ['status', '--porcelain', '--untracked-files=normal']) ||
      await git(source.repository, ['rev-parse', 'HEAD']) !== plan.head ||
      await git(source.repository, ['symbolic-ref', '--short', 'HEAD']) !== source.branch) {
    throw new Error('检查期间源码发生变化，已暂停更新。');
  }
  await git(source.repository, ['merge', '--ff-only', plan.target]);
  await install({ repository: source.repository, revision: plan.target });
  return { ...plan, status: 'updated', message: `已更新至 ${plan.target.slice(0, 7)}。` };
}

// Copy the runner outside the .app and source tree so replacing either cannot
// terminate the installation or make the worker load mixed module versions.
export async function startUpdate(options) {
  if (process.platform !== 'darwin') throw new Error('自动编译安装适用于 macOS 额度助手。');
  const directory = options.directory || artifactRoot;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const runner = path.join(directory, `runner-${process.pid}-${Date.now()}.mjs`);
  await copyFile(fileURLToPath(import.meta.url), runner);
  const output = await open(path.join(directory, 'update.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [runner, '--worker', JSON.stringify(options)], {
      detached: true, stdio: ['ignore', output.fd, output.fd], env: process.env,
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { status: 'started', message: '正在检查、拉取并编译更新…', log: path.join(directory, 'update.log') };
  } finally { await output.close(); }
}

async function worker(options) {
  const directory = options.directory || artifactRoot;
  const release = await acquireLock(directory);
  const statusPath = path.join(options.state, 'update-status.json');
  const log = message => console.log(`${new Date().toISOString()} ${message}`);
  async function save(status, message) {
    await mkdir(options.state, { recursive: true, mode: 0o700 });
    await writeFile(statusPath, JSON.stringify({ status, message, pid: process.pid, checkedAt: new Date().toISOString() }), { mode: 0o600 });
    log(message);
  }
  try {
    await save('updating', '正在检查远端更新…');
    const result = await applyUpdate({ source: options.source, log, install: async ({ repository, revision }) => {
      await save('updating', '正在编译并安装新版…');
      // install.sh builds successfully before stopping or replacing the old app.
      await exec('/bin/bash', [path.join(repository, 'codex-sidebar/macos/install.sh')], {
        timeout: 600000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, CODEX_QUOTA_INSTALL_DIR: path.dirname(options.bundle),
          CODEX_QUOTA_BUILD_DIR: path.join(directory, 'build'), CODEX_QUOTA_NO_LAUNCH: '1',
          CODEX_QUOTA_EXPECTED_REVISION: revision },
      });
    } });
    await save(result.status, result.message);
    if (result.status === 'updated') {
      const arguments_ = [options.enabled ? '--attach-existing' : '--quota-disabled'];
      if (options.dlp) arguments_.push('--dlp-context');
      const child = spawn(path.join(options.bundle, 'Contents/MacOS/CodexQuota'), arguments_, {
        detached: true, stdio: 'ignore', env: process.env,
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    }
  } catch (error) {
    await save('error', error.message.startsWith('Command failed') ? '编译或安装失败，详情请查看更新日志。' : error.message);
    // Build output contains compiler diagnostics; no account data is requested.
    if (error.stdout) log(error.stdout);
    if (error.stderr) log(error.stderr);
    process.exitCode = 1;
  } finally { await release(); }
}

if (process.argv[2] === '--worker' && import.meta.url === pathToFileURL(process.argv[1]).href) {
  worker(JSON.parse(process.argv[3])).catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => unlink(fileURLToPath(import.meta.url)).catch(() => {}));
}
