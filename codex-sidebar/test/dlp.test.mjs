import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { adaptDlpLauncher } from '../lib/dlp.mjs';
import { parsePorts, endpointStatus } from '../lib/endpoints.mjs';
import { runDaemon } from '../lib/daemon.mjs';
import { ensureDlpHelper } from '../lib/helper.mjs';

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
        call: async () => ({}),
        on: () => {},
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


test('listener verification runs only for new connections, not on every tick', { timeout: 10000 }, async t => {
  const controller = new AbortController();
  t.after(() => controller.abort());
  let verifyCalls = 0, connects = 0, injections = 0;
  let firstClient;
  const poller = { snapshot: {}, refresh: async () => {} };
  await runDaemon({
    port: 9341, poller, signal: controller.signal, log: () => {},
    dependencies: {
      verify: async () => { verifyCalls++; },
      targets: async () => [{ id: 'p1', type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'unused' }],
      connect: async () => {
        connects++;
        const client = {
          closed: false,
          call: async () => ({}),
          on: () => {},
          evaluate: async expression => {
            if (expression.includes('refresh: window.')) return { installed: true };
            if (expression.includes('?.dispose(); true')) return true;
            injections++;
            if (injections === 2) firstClient.closed = true;
            if (injections === 3) controller.abort();
            return { mounted: true };
          },
          close: () => { client.closed = true; },
        };
        if (connects === 1) firstClient = client;
        return client;
      },
    },
  });
  assert.equal(injections, 3);
  assert.equal(connects, 2, 'steady ticks reuse the live session');
  assert.equal(verifyCalls, 2, 'verification runs once per new connection, not per tick');
});

test('forced refresh broadcasts the finished snapshot to every session before the next tick', { timeout: 5000 }, async t => {
  const controller = new AbortController();
  t.after(() => controller.abort());
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fresh = { data: { marker: 'fresh' }, receivedAt: 2, loading: false };
  const poller = {
    snapshot: { data: null, receivedAt: 1, loading: true },
    refresh: ({ force } = {}) => force
      ? gate.then(() => { poller.snapshot = fresh; return fresh; })
      : Promise.resolve(poller.snapshot),
  };
  let stateProbes = 0, loadingSeen = 0, freshSeen = 0;
  await runDaemon({
    port: 9341, poller, signal: controller.signal, log: () => {},
    dependencies: {
      verify: async () => {},
      targets: async () => ['p1', 'p2'].map(id => ({ id, type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'unused' })),
      connect: async () => ({
        call: async () => ({}),
        on: () => {},
        evaluate: async expression => {
          if (expression.includes('refresh: window.')) { stateProbes++; return { refresh: stateProbes === 1 }; }
          if (expression.includes('?.dispose(); true')) return true;
          if (expression.includes('"marker":"fresh"')) { freshSeen++; if (freshSeen === 2) controller.abort(); }
          else if (++loadingSeen === 2) release();
          return { mounted: true };
        },
        close: () => {},
      }),
    },
  });
  assert.equal(freshSeen, 2, 'both windows receive the pushed snapshot');
  assert.equal(stateProbes, 2, 'fresh data arrives before the next polling tick');
});

test('binding requests are fetched immediately and deduplicated against polling', { timeout: 5000 }, async t => {
  const controller = new AbortController();
  t.after(() => controller.abort());
  let fetchCalls = 0, stateProbes = 0, bindingHandler;
  const received = [], cdpCalls = [];
  const query = { kind: 'usage', id: 1, start_date: '2026-11-01', end_date: '2026-11-01', page: 1, page_size: 20 };
  const poller = { snapshot: {}, refresh: async () => {} };
  await runDaemon({
    port: 9341, poller, signal: controller.signal, log: () => {},
    dependencies: {
      verify: async () => {},
      targets: async () => [{ id: 'p1', type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'unused' }],
      usageFetch: async request => { fetchCalls++; return { page: request.page, users: [] }; },
      connect: async () => ({
        call: async (method, params) => { cdpCalls.push([method, params]); return {}; },
        on: (method, handler) => { if (method === 'Runtime.bindingCalled') bindingHandler = handler; },
        evaluate: async expression => {
          if (expression.includes('refresh: window.')) { stateProbes++; return { installed: true, usage: query }; }
          if (expression.includes('?.dispose(); true')) return true;
          if (expression.includes('receiveUsage?.(')) {
            const id = Number(expression.match(/"id":(\d+)/)[1]);
            received.push(id);
            if (id === 1) setTimeout(() => {
              bindingHandler({ name: '__zhengruQuotaDispatch', payload: JSON.stringify(query) });
              bindingHandler({ name: '__zhengruQuotaDispatch', payload: JSON.stringify({ ...query, id: 2 }) });
            }, 0);
            if (id === 2) controller.abort();
            return undefined;
          }
          return { mounted: true };
        },
        close: () => {},
      }),
    },
  });
  assert.deepEqual(received, [1, 2]);
  assert.equal(fetchCalls, 2, 'the polling pickup of an already-handled id must not refetch');
  assert.equal(stateProbes, 1, 'binding results arrive before the next polling tick');
  assert.ok(cdpCalls.some(([method, params]) => method === 'Runtime.addBinding' && params.name === '__zhengruQuotaDispatch'));
});

test('busy binding requests are dropped and retried by the polling fallback', { timeout: 8000 }, async t => {
  const controller = new AbortController();
  t.after(() => controller.abort());
  let fetchCalls = 0, stateProbes = 0, bindingHandler, release;
  const gate = new Promise(resolve => { release = resolve; });
  const received = [];
  const query = id => ({ kind: 'usage', id, start_date: '2026-11-01', end_date: '2026-11-01', page: 1, page_size: 20 });
  const poller = { snapshot: {}, refresh: async () => {} };
  await runDaemon({
    port: 9341, poller, signal: controller.signal, log: () => {},
    dependencies: {
      verify: async () => {},
      targets: async () => [{ id: 'p1', type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'unused' }],
      usageFetch: async request => { fetchCalls++; await gate; return { page: request.page, users: [] }; },
      connect: async () => ({
        call: async () => ({}),
        on: (method, handler) => { if (method === 'Runtime.bindingCalled') bindingHandler = handler; },
        evaluate: async expression => {
          if (expression.includes('refresh: window.')) {
            stateProbes++;
            return stateProbes === 1 ? { installed: true } : { installed: true, usage: query(2) };
          }
          if (expression.includes('?.dispose(); true')) return true;
          if (expression.includes('receiveUsage?.(')) {
            const id = Number(expression.match(/"id":(\d+)/)[1]);
            received.push(id);
            if (id === 2) controller.abort();
            return undefined;
          }
          if (stateProbes === 1) setTimeout(() => {
            bindingHandler({ name: '__zhengruQuotaDispatch', payload: JSON.stringify(query(1)) });
            bindingHandler({ name: '__zhengruQuotaDispatch', payload: JSON.stringify(query(2)) });
            release();
          }, 0);
          return { mounted: true };
        },
        close: () => {},
      }),
    },
  });
  assert.deepEqual(received, [1, 2]);
  assert.equal(fetchCalls, 2, 'a request dropped while busy must not trigger a concurrent fetch');
  assert.equal(stateProbes, 2, 'the dropped request is served by the next polling tick');
});

test('existing DLP helper is recognized using full UTF-8 process paths', async () => {
  const bundle = '/Applications/Codex 额度助手.app';
  const executable = path.join(bundle, 'Contents/MacOS/CodexQuota');
  const result = await ensureDlpHelper({ bundle, log: 'unused',
    stopDaemon: () => assert.fail('must reuse the existing DLP helper'),
    launch: () => assert.fail('must not launch a duplicate helper'),
    run: async (command, args, options) => {
      if (command.endsWith('PlistBuddy')) return { stdout: 'top.zhengru.codex-quota' };
      assert.equal(command, '/bin/ps');
      assert.equal(args[0], '-ww');
      assert.equal(options.env.LANG, 'en_US.UTF-8');
      assert.equal(options.env.LC_ALL, 'en_US.UTF-8');
      if (args.includes('-axo')) return { stdout: `4242 ${executable}\n` };
      assert.ok(args.includes('4242'));
      return { stdout: `${executable} --attach-existing --dlp-context\n` };
    },
  });
  assert.deepEqual(result, { reused: true, pid: 4242 });
});
