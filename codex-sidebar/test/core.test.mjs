import test from 'node:test';
import assert from 'node:assert/strict';
import { validateUsage, fetchUsage, UsagePoller, ENDPOINT } from '../lib/usage.mjs';
import { CDP, assertLocalSocket, isAppTarget } from '../lib/cdp.mjs';
import { assertAppListener } from '../lib/daemon.mjs';

export function sample() {
  return {
    five_hour: { used_percent: 30, remaining_percent: 70, resets_at: '2026-11-06T14:56:46+08:00' },
    seven_day: { used_percent: 32, remaining_percent: 68, resets_at: '2026-11-10T22:44:35+08:00' },
    cache: { fetched_at: '2026-11-06T03:54:54.640668+00:00' },
  };
}

test('quota parsing rejects malformed windows and drops unrelated fields', () => {
  const data = sample(); data.secret = 'do-not-transfer';
  assert.equal(validateUsage(data).secret, undefined);
  for (const value of [true, NaN, Infinity, -1, '30']) {
    const invalid = sample(); invalid.five_hour.used_percent = value;
    assert.throws(() => validateUsage(invalid), /无效/);
  }
  const invalid = sample(); invalid.seven_day.resets_at = '<script>';
  assert.throws(() => validateUsage(invalid), /无效/);
});

test('HTTP failure never becomes a successful quota response', async () => {
  await assert.rejects(fetchUsage({ fetcher: async (url, options) => {
    assert.equal(url, ENDPOINT); assert.equal(options.redirect, 'error');
    return new Response('unauthorized', { status: 401 });
  } }), /HTTP 401/);
});

test('concurrent requests coalesce and refresh is rate limited', async () => {
  let calls = 0; let now = 100;
  const poller = new UsagePoller({ now: () => now, fetcher: async () => { calls++; return validateUsage(sample()); } });
  await Promise.all([poller.refresh(), poller.refresh(), poller.refresh()]);
  assert.equal(calls, 1); assert.equal(poller.snapshot.data.five_hour.remaining_percent, 70);
  now += 119_999; await poller.refresh(); assert.equal(calls, 1);
  now++; await poller.refresh(); assert.equal(calls, 2);
});

test('failed refresh keeps the last result and explicitly marks it stale', async () => {
  let now = 0; let fail = false;
  const poller = new UsagePoller({ now: () => now, fetcher: async () => {
    if (fail) throw new Error('network unavailable');
    return validateUsage(sample());
  } });
  await poller.refresh(); const original = poller.snapshot.data;
  now = 120_000; fail = true; await poller.refresh();
  assert.equal(poller.snapshot.data, original);
  assert.equal(poller.snapshot.receivedAt, 0);
  assert.equal(poller.snapshot.error, 'network unavailable');
});

test('manual refresh bypasses the 120 second interval, coalesces requests, and clears loading', async () => {
  let calls = 0;
  const poller = new UsagePoller({ fetcher: async () => { calls++; return validateUsage(sample()); } });
  await poller.refresh();
  await poller.refresh(); assert.equal(calls, 1);
  const a = poller.refresh({ force: true });
  assert.equal(poller.snapshot.loading, true);
  const b = poller.refresh({ force: true });
  await Promise.all([a, b]);
  assert.equal(calls, 2); assert.equal(poller.snapshot.loading, false);
});

test('CDP listener uses mapped executable, independent of mutable process title', async () => {
  const appExe = '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/156/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)';
  const calls = [];
  const run = async (file, args) => {
    calls.push(args);
    assert.equal(file, '/usr/sbin/lsof');
    return { stdout: args.includes('-Fpn') ? 'p123\nn127.0.0.1:9341\n' : `p123\nn${appExe}\nn/usr/lib/dyld\n` };
  };
  await assertAppListener(9341, run);
  assert.ok(calls[0].includes('-a'));
  assert.ok(calls[1].includes('txt'));
  await assert.rejects(assertAppListener(9341, async () => ({ stdout: 'p123\nn*:9341\n' })), /127.0.0.1/);
  await assert.rejects(assertAppListener(9341, async (_, args) => ({ stdout: args.includes('-Fpn') ? 'p123\nn127.0.0.1:9341\n' : 'p123\nn/usr/local/bin/node\n' })), /不属于/);
});

test('inherited CDP listener held by computer-use child is accepted, unrelated holders are rejected', async () => {
  const run = async (file, args) => {
    if (args.includes('-Fpn')) return { stdout: 'p123\nn127.0.0.1:9341\np456\nn127.0.0.1:9341\n' };
    if (file === '/bin/ps') return { stdout: '123\n' };
    const pid = args[args.indexOf('-p') + 1];
    return { stdout: pid === '123' ? 'p123\nn/Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n' :
      'p456\nn/Users/example/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService\n' };
  };
  await assertAppListener(9341, run);
  await assert.rejects(assertAppListener(9341, (file, args) => file === '/bin/ps' ? Promise.resolve({ stdout: '1\n' }) : run(file, args)), /不属于客户端/);
});

test('only application renderer targets and loopback sockets are accepted', () => {
  const target = { type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9341/devtools/page/1' };
  assert.equal(isAppTarget(target), true);
  for (const url of ['https://chatgpt.com', 'app://sandbox/index.html', 'app://-/browser/1', 'devtools://devtools']) {
    assert.equal(isAppTarget({ ...target, url }), false);
  }
  assertLocalSocket(target.webSocketDebuggerUrl, 9341);
  for (const url of ['ws://example.com:9341/devtools/page/1', 'ws://127.0.0.1:9222/devtools/page/1', 'ws://127.0.0.1:9341/other']) {
    assert.throws(() => assertLocalSocket(url, 9341));
  }
});

class FakeSocket extends EventTarget {
  send(message) { this.sent = JSON.parse(message); }
  respond(result) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(result) })); }
  close() { this.dispatchEvent(new Event('close')); }
}
test('CDP correlates results, rejects protocol errors and closes outstanding calls', async () => {
  const ws = new FakeSocket(); const cdp = new CDP(ws, 1000);
  let call = cdp.call('Runtime.enable');
  ws.respond({ id: ws.sent.id, result: {} }); await call;
  call = cdp.call('Unknown'); ws.respond({ id: ws.sent.id, error: { message: 'not supported' } });
  await assert.rejects(call, /not supported/);
  call = cdp.call('Runtime.enable'); cdp.close(); await assert.rejects(call, /断开/);
});
test('CDP request timeouts do not leak pending promises', async () => {
  const cdp = new CDP(new FakeSocket(), 10);
  await assert.rejects(cdp.call('Runtime.enable'), /超时/);
  assert.equal(cdp.pending.size, 0); cdp.close();
});
