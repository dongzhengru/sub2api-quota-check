// Executed only inside the Codex app renderer. This function is self-contained.
function installQuotaWidget(snapshot, options = {}) {
  const KEY = '__zhengruQuotaSidebarV1';
  const HOST = 'zhengru-quota-sidebar';
  if (window[KEY]?.version !== 3) window[KEY]?.dispose();
  if (window[KEY]) {
    window[KEY].update(snapshot);
    return window[KEY].status();
  }
  let current = snapshot;
  let disposed = false;
  let scheduled = false;
  let sidebar = null;
  let refreshRequested = false;
  let waitingForRefresh = false;
  let lastContact = Date.now();
  const host = document.createElement('div');
  host.id = HOST;
  host.style.cssText = 'display:block;flex:0 0 auto;min-width:0;width:auto;margin:5px 10px;position:relative;-webkit-app-region:no-drag;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host{color:inherit;font-family:inherit;font-size:12px;color-scheme:light dark}
      *{box-sizing:border-box}
      .card{padding:8px 9px;border:1px solid color-mix(in srgb,currentColor 10%,transparent);border-radius:9px;background:color-mix(in srgb,currentColor 2%,transparent);line-height:1.35;user-select:none}
      .head,.label{display:flex;justify-content:space-between;align-items:center;gap:8px}
      .title{font-weight:600;font-size:11px;letter-spacing:.02em}
      .refresh{display:grid;place-items:center;width:20px;height:20px;padding:3px;border:0;border-radius:5px;background:transparent;color:inherit;opacity:.55;cursor:pointer}
      .refresh:hover{opacity:1;background:color-mix(in srgb,currentColor 8%,transparent)}
      .refresh:focus-visible{outline:2px solid #16a77a;outline-offset:1px}
      .refresh:disabled{cursor:wait;opacity:.35}
      .row{margin-top:5px}.name{opacity:.65;font-size:10px}.number{font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}
      .number small{font-size:10px;font-weight:400;opacity:.6;margin-left:3px}
      .track{margin-top:3px;height:3px;border-radius:4px;overflow:hidden;background:color-mix(in srgb,currentColor 9%,transparent)}
      .fill{height:100%;border-radius:4px;background:#16a77a;transition:width .35s ease}
      .reset{display:flex;justify-content:space-between;gap:4px;font-size:9px;opacity:.5;margin-top:3px;font-variant-numeric:tabular-nums;white-space:nowrap}
      .foot{margin-top:5px;font-size:10px;color:#df8842}.foot[hidden]{display:none}.stale .fill{opacity:.45}
      @media(prefers-reduced-motion:reduce){.fill{transition:none}.refresh svg{animation:none!important}}
    </style>
    <section class="card" aria-label="Zhengru 网关额度">
      <div class="head"><span class="title">网关额度</span><button class="refresh" type="button" title="刷新额度" aria-label="刷新额度" aria-busy="false"><svg width="14" height="14" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M36.7279 36.7279C33.4706 39.9853 28.9706 42 24 42C14.0589 42 6 33.9411 6 24C6 14.0589 14.0589 6 24 6C28.9706 6 33.4706 8.01472 36.7279 11.2721C38.3859 12.9301 42 17 42 17" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M42 8V17H33" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
      <div class="row" data-window="five_hour"><div class="label"><span class="name">5 小时</span><span class="number"><b>—</b><small>剩余</small></span></div><div class="track" role="progressbar" aria-label="5 小时剩余额度" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:0%"></div></div><div class="reset"><time>等待查询</time><span class="countdown"></span></div></div>
      <div class="row" data-window="seven_day"><div class="label"><span class="name">7 天</span><span class="number"><b>—</b><small>剩余</small></span></div><div class="track" role="progressbar" aria-label="7 天剩余额度" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:0%"></div></div><div class="reset"><time>等待查询</time><span class="countdown"></span></div></div>
      <div class="foot" id="foot" role="status" hidden></div>
    </section>`;
  const formatPercent = n => `${Number(n.toFixed(1))}%`;
  const formatDate = value => new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false,
  });
  const exactDate = value => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(value));
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  };
  function countdown(value) {
    let seconds = Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / 1000));
    if (!seconds) return '等待重置';
    const days = Math.floor(seconds / 86400); seconds %= 86400;
    const hours = Math.floor(seconds / 3600); seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    return (days ? `${days}天` : '') + (hours ? `${hours}时` : '') + `${minutes}分后`;
  }
  function paint() {
    const disconnected = Date.now() - lastContact > 45_000;
    const stale = !!current?.error || disconnected || (current?.receivedAt != null && Date.now() - current.receivedAt > 270_000);
    root.querySelector('.card').classList.toggle('stale', stale);
    const button = root.querySelector('.refresh');
    const loading = !disconnected && (waitingForRefresh || !!current?.loading);
    button.disabled = loading;
    button.setAttribute('aria-busy', String(loading));
    for (const key of ['five_hour', 'seven_day']) {
      const w = current?.data?.[key];
      const row = root.querySelector(`[data-window="${key}"]`);
      if (!w) continue;
      const remaining = Math.max(0, Math.min(100, w.remaining_percent));
      row.querySelector('b').textContent = formatPercent(w.remaining_percent);
      row.querySelector('.fill').style.width = `${remaining}%`;
      row.querySelector('.fill').style.background = remaining <= 10 ? '#e05a50' : remaining <= 30 ? '#d99a37' : '#16a77a';
      row.querySelector('.track').setAttribute('aria-valuenow', String(remaining));
      row.querySelector('.track').setAttribute('aria-valuetext', `剩余 ${formatPercent(w.remaining_percent)}，已用 ${formatPercent(w.used_percent)}`);
      row.querySelector('time').textContent = exactDate(w.resets_at);
      row.querySelector('time').dateTime = w.resets_at;
      row.querySelector('time').title = '北京时间';
      row.querySelector('.countdown').textContent = countdown(w.resets_at);
      row.title = `已用 ${formatPercent(w.used_percent)} · 北京时间 ${formatDate(w.resets_at)} 重置`;
    }
    const foot = root.getElementById('foot');
    foot.hidden = !stale;
    foot.textContent = stale ? (current?.data ? '更新失败 · 当前为上次数据' : '暂时无法查询额度，请检查后台连接') : '';
    foot.title = stale ? (current?.error || '本机额度程序已断开') : '';
  }
  function findSidebar() {
    // Verified in the installed unified ChatGPT/Codex client, then older Codex.
    const selectors = options.selector ? [options.selector] : [
      '#app-shell-sidebar [data-sidebar-navigation-root]',
      '#app-shell-sidebar .sidebar-navigation', '#app-shell-sidebar',
      '[data-sidebar-navigation-root]', 'aside[data-testid="sidebar"]',
      '[data-testid="sidebar"]', 'nav[aria-label="Sidebar"]',
    ];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node && node !== host && !host.contains(node)) return node;
    }
    return null;
  }
  function mount() {
    if (disposed) return;
    const target = findSidebar();
    if (!target) { host.remove(); sidebar = null; return; }
    sidebar = target;
    const collapsed = target.closest('[data-sidebar-collapsed="true"], [inert]');
    host.hidden = !!collapsed;
    host.style.display = collapsed ? 'none' : 'block';
    if (host.parentNode !== target) target.appendChild(host);
  }
  const observer = new MutationObserver(records => {
    if (scheduled || records.every(r => r.target === host)) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; mount(); });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-sidebar-collapsed', 'inert'] });
  const timer = setInterval(() => { mount(); paint(); }, 5000);
  root.querySelector('.refresh').addEventListener('click', () => {
    refreshRequested = true;
    waitingForRefresh = true;
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      root.querySelector('.refresh svg').animate([
        { transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' },
      ], { duration: 450, easing: 'ease-in-out', iterations: 1 });
    }
    paint();
  });
  const status = () => ({ mounted: host.isConnected, selector: sidebar?.id || sidebar?.className || null });
  window[KEY] = {
    version: 3,
    update(value) { current = value; lastContact = Date.now(); waitingForRefresh = false; mount(); paint(); return status(); }, status,
    takeRefreshRequest() { const requested = refreshRequested; refreshRequested = false; return requested; },
    dispose() { disposed = true; observer.disconnect(); clearInterval(timer); host.remove(); delete window[KEY]; },
  };
  mount(); paint();
  return status();
}
