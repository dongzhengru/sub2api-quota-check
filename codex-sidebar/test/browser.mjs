// Real Chromium render test in a separate, disposable profile. No user tabs.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CDP, listTargets } from '../lib/cdp.mjs';

const executable = process.env.QUOTA_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = await mkdtemp(path.join(tmpdir(), 'codex-quota-browser-'));
const chrome = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let cdp;
try {
  let port;
  for (let i = 0; i < 60; i++) {
    try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await new Promise(r => setTimeout(r, 250)); }
  }
  assert.ok(port, 'Chromium CDP did not start');
  const target = (await listTargets(port)).find(t => t.type === 'page');
  cdp = await CDP.connect(target.webSocketDebuggerUrl, { port });
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 960, height: 760, deviceScaleFactor: 1, mobile: false });
  await cdp.evaluate(`document.body.innerHTML = '<style>body{margin:0;background:#fff;color:#252525;font:13px -apple-system,BlinkMacSystemFont,sans-serif;display:flex}#app-shell-sidebar{width:260px;height:760px;background:#f7f7f5;display:flex;flex-direction:column;border-right:1px solid #e8e8e5}[data-sidebar-navigation-root]{display:flex;flex-direction:column;flex:1;min-height:0}.chats{flex:1;overflow:auto;padding:16px}.app{padding:48px;flex:1}p{line-height:1.7;color:#888}</style><div id="app-shell-sidebar"><header style="padding:24px 20px 12px;font-size:16px;font-weight:600">Codex</header><div data-sidebar-navigation-root><div class="chats">＋ 新建聊天<p>项目<br>sub2api 额度查询<br><br>最近聊天<br>开发额度侧栏组件</p></div></div><footer style="padding:16px 20px;color:#888">设置</footer></div><main class="app"><h2>额度侧栏</h2><p>本机 CDP 注入<br>独立测试页面，非实际客户端截图</p></main>'`);
  const widget = await readFile(new URL('../lib/widget.js', import.meta.url), 'utf8');
  await cdp.evaluate(`window.__quotaSetInterval = window.setInterval; window.setInterval = (fn, ms) => { window.__quotaTick = fn; return window.__quotaSetInterval(fn, ms); }`);
  const now = Date.now();
  const snapshot = { data: {
    five_hour: { used_percent: 30, remaining_percent: 70, resets_at: new Date(now + 7200_000).toISOString() },
    seven_day: { used_percent: 32, remaining_percent: 68, resets_at: new Date(now + 3 * 86400_000).toISOString() },
    fetched_at: new Date(now).toISOString(),
  }, receivedAt: now, error: null, loading: false };
  const inject = data => cdp.evaluate(`(${widget})(${JSON.stringify(data)})`);
  assert.equal((await inject(snapshot)).mounted, true);
  assert.equal((await inject(snapshot)).mounted, true);
  assert.equal(await cdp.evaluate(`document.querySelectorAll('#zhengru-quota-sidebar').length`), 1);
  assert.equal(await cdp.evaluate(`document.querySelector('#zhengru-quota-sidebar').shadowRoot.querySelector('b').textContent`), '70%');
  // Usage stays hidden and makes no request until explicitly opened.
  const ui = `document.getElementById('zhengru-quota-sidebar').shadowRoot`;
  assert.equal(await cdp.evaluate(`${ui}.querySelector('dialog').open`), false);
  assert.equal(await cdp.evaluate(`window.__zhengruQuotaSidebarV1.takeUsageRequest()`), null);
  await cdp.evaluate(`${ui}.querySelector('.usage-link').click()`);
  assert.equal(await cdp.evaluate(`${ui}.querySelector('dialog').open`), true);
  let query = await cdp.evaluate(`window.__zhengruQuotaSidebarV1.takeUsageRequest()`);
  assert.equal(query.start_date,query.end_date);assert.equal(query.page,1);
  const usageResult = { id:query.id, data:{...query,timezone:'Asia/Shanghai',has_more:true,users:[{user_id:1,email:'<img src=x onerror=alert(1)>',requests:225,input_tokens:1254036,output_tokens:106773,cache_tokens:16050688,total_tokens:17411497,cost:4.57638018}]} };
  await cdp.evaluate(`window.__zhengruQuotaSidebarV1.receiveUsage(${JSON.stringify(usageResult)})`);
  assert.match(await cdp.evaluate(`${ui}.querySelector('tbody').textContent`), /17.41 M/);
  assert.match(await cdp.evaluate(`${ui}.querySelector('tbody').textContent`), /\$4.576/);
  assert.equal(await cdp.evaluate(`${ui}.querySelector('tbody img') === null`),true);
  await cdp.evaluate(`${ui}.querySelector('.usage-next').click()`);
  query=await cdp.evaluate(`window.__zhengruQuotaSidebarV1.takeUsageRequest()`);assert.equal(query.page,2);
  await cdp.evaluate(`${ui}.querySelector('[data-days="7"]').click()`);
  const weekQuery=await cdp.evaluate(`window.__zhengruQuotaSidebarV1.takeUsageRequest()`);
  assert.equal(weekQuery.page,1);assert.equal((Date.parse(weekQuery.end_date)-Date.parse(weekQuery.start_date))/86400000,6);
  // Late results must not overwrite the latest filter.
  await cdp.evaluate(`window.__zhengruQuotaSidebarV1.receiveUsage(${JSON.stringify(usageResult)})`);
  assert.equal(await cdp.evaluate(`${ui}.querySelector('tbody').children.length`),0);
  await cdp.evaluate(`window.__zhengruQuotaSidebarV1.receiveUsage(${JSON.stringify({id:weekQuery.id,error:'模拟查询失败'})})`);
  assert.equal(await cdp.evaluate(`${ui}.querySelector('.usage-error').textContent`),'模拟查询失败');
  await cdp.evaluate(`${ui}.querySelector('.usage-filters').requestSubmit()`);
  query=await cdp.evaluate(`window.__zhengruQuotaSidebarV1.takeUsageRequest()`);
  await cdp.evaluate(`window.__zhengruQuotaSidebarV1.receiveUsage(${JSON.stringify({...usageResult,id:query.id,data:{...usageResult.data,...query}})})`);
  await cdp.call('Page.enable');
  const usageShot=await cdp.call('Page.captureScreenshot',{format:'png'});
  await writeFile(new URL('../preview-usage.png',import.meta.url),Buffer.from(usageShot.data,'base64'));
  await cdp.evaluate(`${ui}.querySelector('.usage-close').click()`);
  assert.equal(await cdp.evaluate(`${ui}.querySelector('dialog').open`),false);
  const box = await cdp.evaluate(`JSON.stringify(document.querySelector('#zhengru-quota-sidebar').getBoundingClientRect().toJSON())`);
  const rect = JSON.parse(box);
  assert.ok(rect.width > 180 && rect.right <= 260 && rect.bottom <= 760, `Widget outside sidebar: ${box}`);
  assert.ok(rect.height <= 130, `Compact card is too tall: ${rect.height}`);
  assert.match(await cdp.evaluate(`document.getElementById('zhengru-quota-sidebar').shadowRoot.querySelector('time').textContent`), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(await cdp.evaluate(`document.getElementById('zhengru-quota-sidebar').shadowRoot.getElementById('foot').hidden`), true);
  await cdp.evaluate(`document.getElementById('zhengru-quota-sidebar').shadowRoot.querySelector('.refresh').click()`);
  const animation = await cdp.evaluate(`{ const a = document.getElementById('zhengru-quota-sidebar').shadowRoot.querySelector('svg').getAnimations()[0]; ({ iterations: a?.effect.getTiming().iterations, duration: a?.effect.getTiming().duration }) }`);
  assert.equal(animation.iterations, 1);
  assert.equal(animation.duration, 450);
  assert.equal(await cdp.evaluate(`document.getElementById('zhengru-quota-sidebar').shadowRoot.querySelector('.refresh').getAttribute('aria-busy')`), 'true');
  assert.equal(await cdp.evaluate(`window.__zhengruQuotaSidebarV1.takeRefreshRequest()`), true);
  assert.equal(await cdp.evaluate(`window.__zhengruQuotaSidebarV1.takeRefreshRequest()`), false);
  await inject({ ...snapshot, loading: true });
  assert.equal(await cdp.evaluate(`document.getElementById('zhengru-quota-sidebar').shadowRoot.querySelector('.refresh').disabled`), true);
  await inject(snapshot);
  assert.equal(await cdp.evaluate(`document.getElementById('zhengru-quota-sidebar').shadowRoot.querySelector('.refresh').disabled`), false);
  // React replaces the sidebar contents; observer reattaches the same host.
  await cdp.evaluate(`document.querySelector('[data-sidebar-navigation-root]').innerHTML = '<div class="chats">重绘后的聊天列表</div>'`);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(await cdp.evaluate(`window.__zhengruQuotaSidebarV1.status().mounted`), true);
  await cdp.evaluate(`document.querySelector('[data-sidebar-navigation-root]').setAttribute('data-sidebar-collapsed','true')`);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(await cdp.evaluate(`document.getElementById('zhengru-quota-sidebar').hidden`), true);
  await cdp.evaluate(`document.querySelector('[data-sidebar-navigation-root]').removeAttribute('data-sidebar-collapsed')`);
  await inject({ ...snapshot, error: 'network unavailable' });
  assert.equal(await cdp.evaluate(`document.getElementById('zhengru-quota-sidebar').shadowRoot.querySelector('.stale') !== null`), true);
  assert.match(await cdp.evaluate(`document.getElementById('zhengru-quota-sidebar').shadowRoot.getElementById('foot').textContent`), /上次数据/);
  await inject(snapshot);
  await cdp.evaluate(`document.querySelector('.chats').innerHTML = '＋ 新建聊天<p>项目<br>sub2api 额度查询<br><br>最近聊天<br>开发额度侧栏组件</p>'`);
  await cdp.call('Page.enable');
  await new Promise(r => setTimeout(r, 200));
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(new URL('../preview.png', import.meta.url), Buffer.from(screenshot.data, 'base64'));
  await cdp.evaluate(`document.body.style.background = '#202020'; document.body.style.color = '#eee'; document.getElementById('app-shell-sidebar').style.background = '#171717'`);
  const dark = await cdp.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(new URL('../preview-dark.png', import.meta.url), Buffer.from(dark.data, 'base64'));
  // Even if the daemon dies before the first response, the initial spinner
  // must turn into an actionable error, rather than spin forever.
  await inject({ data: null, error: null, receivedAt: null, loading: true });
  await cdp.evaluate(`{ const originalNow = Date.now; const advanced = originalNow() + 46_000; Date.now = () => advanced; try { window.__quotaTick(); } finally { Date.now = originalNow; } }`);
  assert.match(await cdp.evaluate(`document.getElementById('zhengru-quota-sidebar').shadowRoot.getElementById('foot').textContent`), /后台连接/);
  assert.equal(await cdp.evaluate(`document.getElementById('zhengru-quota-sidebar').shadowRoot.querySelector('.refresh').disabled`), false);
  await inject(snapshot);
  await cdp.evaluate(`window.__zhengruQuotaSidebarV1.dispose()`);
  assert.equal(await cdp.evaluate(`document.getElementById('zhengru-quota-sidebar') === null && !window.__zhengruQuotaSidebarV1`), true);
  // No sidebar should not result in a floating overlay elsewhere in the app.
  await cdp.evaluate(`document.getElementById('app-shell-sidebar').remove()`);
  assert.equal((await inject(snapshot)).mounted, false);
  await cdp.evaluate(`window.__zhengruQuotaSidebarV1.dispose()`);
  console.log('Browser checks passed: compact layout, exact date/time, manual refresh, first-response watchdog, React replacement, collapse, stale data, light/dark render, cleanup.');
} finally {
  cdp?.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => { chrome.once('exit', resolve); setTimeout(resolve, 3000); });
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
