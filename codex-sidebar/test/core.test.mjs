import test from 'node:test';
import assert from 'node:assert/strict';
import { validateUsage, fetchUsage, UsagePoller, ENDPOINT, fetchUserBreakdown } from '../lib/usage.mjs';
import { CDP, assertLocalSocket, isAppTarget } from '../lib/cdp.mjs';
import { assertAppListener as assertPlatformAppListener } from '../lib/daemon.mjs';

// These fixtures describe macOS lsof/ps output even when run on Windows.
const assertAppListener = (port, run) => assertPlatformAppListener(port, run, 'darwin');

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


test('ranking fetch sends date and pagination to fixed gateway, validates and strips fields', async () => {
  const query={start_date:'2026-11-01',end_date:'2026-11-06',page:2,page_size:20};
  const result=await fetchUserBreakdown(query,{fetcher:async (url,options)=>{
    assert.equal(new URL(url).pathname,'/api/quota/api/user-breakdown');
    assert.equal(new URL(url).searchParams.get('page'),'2');
    assert.equal(options.redirect,'error');
    return Response.json({...query,timezone:'Asia/Shanghai',has_more:false,users:[{email:'test@example.com',cost:1.23456,secret:'drop'}]});
  }});
  assert.equal(result.users[0].secret,undefined);assert.equal(result.users[0].cost,1.23456);
  await assert.rejects(fetchUserBreakdown({...query,start_date:'2026-02-30'}),/参数无效/);
  await assert.rejects(fetchUserBreakdown(query,{fetcher:async()=>Response.json({...query,users:[]})}),/数据无效/);
  await assert.rejects(fetchUserBreakdown(query,{fetcher:async()=>Response.json({detail:'管理员权限不足'},{status:403})}),/管理员权限不足/);
});


test('daemon identity uses UTF-8 even under Finder C locale and preserves instance boundaries', async () => {
  const { matchesDaemonProcess } = await import('../lib/process.mjs');
  const cli='/Users/example/Applications/Codex 额度助手.app/Contents/Resources/engine/cli.mjs';
  const state={pid:123,instance:'abc-123'};
  const original=process.env.LC_ALL;
  process.env.LC_ALL='C';
  try {
    const run=async (file,args,options)=>{
      assert.equal(file,'/bin/ps');assert.ok(args.includes('-ww'));
      assert.equal(options.env.LC_ALL,'en_US.UTF-8');
      assert.equal(options.env.LANG,'en_US.UTF-8');
      return {stdout:`node ${cli} run --port 9341 --instance abc-123\n`};
    };
    assert.equal(await matchesDaemonProcess(state,cli,run,'darwin'),true);
    assert.equal(await matchesDaemonProcess({...state,instance:'abc'},cli,run,'darwin'),false);
    assert.equal(await matchesDaemonProcess(state,cli,async()=>({stdout:`node ${cli} run --port 9341 --instance abc-123 --selector aside\n`}),'darwin'),true);
    assert.equal(await matchesDaemonProcess(state,cli,async()=>{throw Error('missing');},'darwin'),false);
  } finally {if(original===undefined)delete process.env.LC_ALL;else process.env.LC_ALL=original;}
});
