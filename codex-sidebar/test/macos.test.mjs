import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('macOS shell entry points use LF line endings', async () => {
  for (const file of ['../macos/build.sh', '../macos/install.sh', '../runtime.sh', '../../启动额度侧栏.command', '../../停止额度侧栏.command']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.equal(source.includes('\r'), false, `${file} must run in macOS Bash`);
  }
});

test('macOS app bundles the current collapsible widget and a runnable engine', {
  skip: process.platform !== 'darwin', timeout: 180000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'quota macOS 中文 '));
  const buildDir = path.join(root, 'custom build');
  const sidebar = fileURLToPath(new URL('../', import.meta.url));
  const exec = promisify(execFile);
  try {
    await exec('/bin/bash', [path.join(sidebar, 'macos/build.sh')], {
      env: { ...process.env, CODEX_QUOTA_BUILD_DIR: buildDir }, timeout: 150000,
    });
    const bundle = path.join(buildDir, 'Codex 额度助手.app');
    const engine = path.join(bundle, 'Contents/Resources/engine');
    assert.equal(await readFile(path.join(engine, 'lib/widget.js'), 'utf8'),
      await readFile(path.join(sidebar, 'lib/widget.js'), 'utf8'));
    // Import the complete packaged engine, including platform helpers.
    const result = await exec(process.execPath, [path.join(engine, 'cli.mjs'), 'help']);
    assert.match(result.stdout, /start\|stop\|status/);
    await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
