import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptDlpLauncher } from '../lib/dlp.mjs';
import { parsePorts, endpointStatus } from '../lib/endpoints.mjs';
import { runDaemon } from '../lib/daemon.mjs';

test('DLP launcher adaptation preserves the safe context and is idempotent', () => {
  const source = '#!/bin/zsh\n[[ "$SAFE_SANDBOX" == "1" ]] || exit 1\n' +
    'export CODEX_ELECTRON_USER_DATA_PATH="$USER_DATA"\n' +
    'nohup "$CHATGPT_BIN" "--user-data-dir=$USER_DATA" "--proxy-server=$APP_PROXY" &\n';
  const adapted = adaptDlpLauncher(source);
  assert.ok(adapted.startsWith(source.slice(0, source.indexOf('nohup'))));
  assert.match(adapted, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(adapted, /--remote-debugging-port=9342/);
  assert.match(adapted, /dlp-helper/);
  assert.equal(adaptDlpLauncher(adapted), adapted);
  assert.throws(() => adaptDlpLauncher(source.replace('nohup ', 'nohup --remote-debugging-port=9333 ')), /其他调试端口/);
});

test('default endpoints retain the DLP instance when the ordinary instance is unavailable', async () => {
  assert.deepEqual(parsePorts(), [9341, 9342]);
  assert.deepEqual(parsePorts('9342,9341,9342'), [9342, 9341]);
  const endpoints = await endpointStatus(parsePorts(), {
    verify: async port => { if (port === 9341) throw Object.assign(new Error('closed'), { code: 1 }); },
    targets: async () => [{ type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'unused' }],
  });
  assert.equal(endpoints[0].connected, false);
  assert.equal(endpoints[1].connected, true);
  assert.equal(endpoints[1].pages, 1);
});

test('both endpoints keep separate sessions for matching page IDs and clean up on stop', { timeout: 5000 }, async t => {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const mounted = new Set(), disposed = new Set(), closed = new Set();
  const poller = { snapshot: {}, refresh: async () => {} };
  await runDaemon({
    ports: [9341, 9342], poller, signal: controller.signal, log: () => {},
    dependencies: {
      verify: async () => {},
      targets: async () => [{ id: 'same-page', type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'unused' }],
      connect: async (_url, port) => ({
        evaluate: async expression => {
          if (expression.includes('refresh: window.')) return { installed: false };
          if (expression.includes('?.dispose(); true')) { disposed.add(port); return true; }
          mounted.add(port);
          if (mounted.size === 2) controller.abort();
          return { mounted: true };
        },
        close: () => closed.add(port),
      }),
    },
  });
  assert.deepEqual([...mounted].sort(), [9341, 9342]);
  assert.deepEqual([...disposed].sort(), [9341, 9342]);
  assert.deepEqual([...closed].sort(), [9341, 9342]);
});
