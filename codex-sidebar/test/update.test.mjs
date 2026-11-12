import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { inspectUpdate, applyUpdate, startUpdate } from '../lib/update.mjs';

const exec = promisify(execFile);
const artifacts = path.join(homedir(), '.codex/share/codexNoProject/codex-quota-update-tests');

async function fixture(t, installer) {
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(artifacts, 'git 中文 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const publisher = path.join(root, 'publisher');
  const repository = path.join(root, 'client');
  const git = async (dir, ...args) => (await exec('git', ['-C', dir, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'aye', GIT_AUTHOR_EMAIL: 'aye@example.invalid',
      GIT_COMMITTER_NAME: 'aye', GIT_COMMITTER_EMAIL: 'aye@example.invalid' },
  })).stdout.trim();
  await git(root, 'init', '--bare', '--initial-branch=main', remote);
  await git(root, 'clone', remote, publisher);
  await writeFile(path.join(publisher, 'version'), 'one');
  if (installer) {
    await mkdir(path.join(publisher, 'codex-sidebar/macos'), { recursive: true });
    await writeFile(path.join(publisher, 'codex-sidebar/macos/install.sh'), installer);
  }
  await git(publisher, 'add', '.');
  await git(publisher, 'commit', '-m', 'initial');
  await git(publisher, 'push', 'origin', 'main');
  await git(root, 'clone', remote, repository);
  const source = { repository, branch: 'main', revision: await git(repository, 'rev-parse', 'HEAD') };
  const publish = async value => {
    await writeFile(path.join(publisher, 'version'), value);
    await git(publisher, 'commit', '-am', value);
    await git(publisher, 'push', 'origin', 'main');
    return git(publisher, 'rev-parse', 'HEAD');
  };
  return { root, source, git, repository, remote, publish };
}

test('detects a real remote commit and fast-forwards before installing', async t => {
  const { source, git, repository, publish } = await fixture(t);
  assert.equal((await inspectUpdate(source)).status, 'current');
  const target = await publish('two');
  assert.equal((await inspectUpdate(source)).status, 'available');
  assert.equal(await readFile(path.join(repository, 'version'), 'utf8'), 'one');
  let installations = 0;
  const result = await applyUpdate({ source, install: async details => {
    installations++;
    assert.equal(details.revision, target);
    assert.equal(await git(repository, 'rev-parse', 'HEAD'), target);
    assert.equal(await readFile(path.join(repository, 'version'), 'utf8'), 'two');
  } });
  assert.equal(result.status, 'updated');
  assert.equal(installations, 1);
  assert.equal((await inspectUpdate({ ...source, revision: target })).status, 'current');
});

test('dirty and untracked files block updates without touching local work', async t => {
  const { source, repository, publish, git } = await fixture(t);
  await publish('two');
  await writeFile(path.join(repository, 'version'), 'local edit');
  await writeFile(path.join(repository, 'local config'), 'preserve');
  const result = await applyUpdate({ source, install: () => assert.fail('must not install') });
  assert.equal(result.status, 'blocked');
  assert.equal(await git(repository, 'rev-parse', 'HEAD'), source.revision);
  assert.equal(await readFile(path.join(repository, 'version'), 'utf8'), 'local edit');
  assert.equal(await readFile(path.join(repository, 'local config'), 'utf8'), 'preserve');
  await git(repository, 'checkout', '--', 'version');
  assert.equal((await inspectUpdate(source)).status, 'blocked');
});

test('local ahead, divergent and switched branches never get merged', async t => {
  const { source, repository, publish, git } = await fixture(t);
  await writeFile(path.join(repository, 'local'), 'local commit');
  await git(repository, 'add', '.');
  await git(repository, 'commit', '-m', 'local');
  assert.equal((await inspectUpdate(source)).status, 'blocked');
  await publish('two');
  assert.equal((await inspectUpdate(source)).status, 'blocked');
  await git(repository, 'switch', '-c', 'other');
  assert.match((await inspectUpdate(source)).message, /分支已切换/);
});

test('failed builds are retried even when source was already pulled', async t => {
  const { source, publish, repository, git } = await fixture(t);
  const target = await publish('two');
  await assert.rejects(applyUpdate({ source, install: async () => { throw new Error('build failed'); } }), /build failed/);
  assert.equal(await git(repository, 'rev-parse', 'HEAD'), target);
  assert.equal((await inspectUpdate(source)).status, 'available');
  const result = await applyUpdate({ source, install: async () => {} });
  assert.equal(result.status, 'updated');
});

test('remote failure leaves the working tree and installed version alone', async t => {
  const { source, remote, repository, git } = await fixture(t);
  await rm(remote, { recursive: true, force: true });
  await assert.rejects(applyUpdate({ source, install: () => assert.fail('must not install') }), /Git fetch 失败/);
  assert.equal(await git(repository, 'rev-parse', 'HEAD'), source.revision);
  assert.equal(await git(repository, 'status', '--porcelain'), '');
});

test('detached worker installs outside its bundle and preserves disabled DLP launch state', {
  skip: process.platform !== 'darwin', timeout: 20000,
}, async t => {
  const installer = `#!/bin/bash
set -euo pipefail
test "$CODEX_QUOTA_NO_LAUNCH" = 1
mkdir -p "$CODEX_QUOTA_INSTALL_DIR/Codex 额度助手.app/Contents/MacOS" "$CODEX_QUOTA_BUILD_DIR"
printf '%s' "$CODEX_QUOTA_EXPECTED_REVISION" > "$CODEX_QUOTA_BUILD_DIR/revision"
cat > "$CODEX_QUOTA_INSTALL_DIR/Codex 额度助手.app/Contents/MacOS/CodexQuota" <<'SH'
#!/bin/bash
printf '%s\\n' "$@" > "$0.arguments"
SH
chmod +x "$CODEX_QUOTA_INSTALL_DIR/Codex 额度助手.app/Contents/MacOS/CodexQuota"
`;
  const { root, source, publish } = await fixture(t, installer);
  const target = await publish('two');
  const bundle = path.join(root, 'installed/Codex 额度助手.app');
  const state = path.join(root, 'state');
  const directory = path.join(root, 'worker');
  const result = await startUpdate({ source, bundle, state, directory, enabled: false, dlp: true });
  assert.equal(result.status, 'started');
  const argumentsFile = path.join(bundle, 'Contents/MacOS/CodexQuota.arguments');
  let status;
  let launchArguments;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      status = JSON.parse(await readFile(path.join(state, 'update-status.json'), 'utf8'));
      if (status.status === 'error') assert.fail(status.message);
      launchArguments = await readFile(argumentsFile, 'utf8');
      await readFile(path.join(directory, 'update.lock'), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (status?.status === 'updated' && launchArguments) break;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(status?.status, 'updated');
  assert.equal(launchArguments, '--quota-disabled\n--dlp-context\n');
  assert.equal(await readFile(path.join(directory, 'build/revision'), 'utf8'), target);
});
