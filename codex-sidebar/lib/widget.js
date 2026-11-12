// Executed only inside the Codex app renderer. This function is self-contained.
function installQuotaWidget(snapshot, options = {}) {
  const KEY = '__zhengruQuotaSidebarV1';
  const HOST = 'zhengru-quota-sidebar';
  if (window[KEY]?.version !== 8) window[KEY]?.dispose();
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
  const COLLAPSED_KEY = 'zhengruQuotaSidebar.collapsed';
  let collapsed = false;
  // Some renderer contexts deny storage; toggling still works for this session.
  try { collapsed = localStorage.getItem(COLLAPSED_KEY) === 'true'; } catch {}
  let usageRequest = null, usageId = 0, usagePage = 1, usageRange = null, usageDeadline = 0;
  const host = document.createElement('div');
  host.id = HOST;
  host.style.cssText = 'display:block;flex:0 0 auto;min-width:0;width:auto;margin:5px 10px;position:relative;-webkit-app-region:no-drag;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host{color:inherit;font-family:inherit;font-size:12px;color-scheme:light dark}
      *{box-sizing:border-box}
      .card{padding:8px 9px;border:1px solid color-mix(in srgb,currentColor 10%,transparent);border-radius:9px;background:color-mix(in srgb,currentColor 2%,transparent);line-height:1.35;user-select:none}
      .actions{display:flex;align-items:center;gap:5px}.usage-link{border:0;background:transparent;color:inherit;font:inherit;font-size:10px;opacity:.65;cursor:pointer;padding:3px}.usage-link:hover{opacity:1;text-decoration:underline}
      dialog{color:inherit;background:Canvas;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:14px;padding:24px;width:min(920px,calc(100vw - 40px));max-height:85vh;overflow:auto;user-select:text;font-size:12px}dialog::backdrop{background:#0006}.dialog-head,.usage-filters,.usage-pages{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.dialog-head{justify-content:space-between}.dialog-head h2{font-size:16px;margin:0}.usage-filters{margin:18px 0}.usage-pages{justify-content:flex-end;margin-top:16px}dialog button,dialog input,dialog select{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:6px;padding:6px 9px}dialog button{cursor:pointer}dialog button:disabled{opacity:.4;cursor:default}dialog button.active{background:#16845f;color:#fff}.usage-scroll{overflow:auto}table{width:100%;border-collapse:collapse;white-space:nowrap;font-variant-numeric:tabular-nums}th,td{padding:11px 9px;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent);text-align:right}th:first-child,td:first-child{text-align:left}th{font-weight:500;opacity:.65}.usage-status{opacity:.65;margin:10px 0}.usage-error{color:#df8842}
      .head,.label{display:flex;justify-content:space-between;align-items:center;gap:8px}
      .title{font-weight:600;font-size:11px;letter-spacing:.02em}
      .toggle{display:flex;align-items:center;gap:4px;flex:1;min-width:0;border:0;border-radius:4px;padding:3px;margin:-3px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;white-space:nowrap}
      .toggle:hover{background:color-mix(in srgb,currentColor 6%,transparent)}.toggle:focus-visible{outline:2px solid #16a77a;outline-offset:1px}
      .chevron{flex:none;opacity:.55}.toggle[aria-expanded="false"] .chevron{transform:rotate(-90deg)}
      .stale .toggle .title::after{content:'●';font-size:7px;color:#df8842;margin-left:4px}
      #quota-details[hidden]{display:none}
      .refresh{display:grid;place-items:center;width:20px;height:20px;padding:3px;border:0;border-radius:5px;background:transparent;color:inherit;opacity:.55;cursor:pointer}
      .refresh:hover{opacity:1;background:color-mix(in srgb,currentColor 8%,transparent)}
      .refresh:focus-visible{outline:2px solid #16a77a;outline-offset:1px}
      .refresh:disabled{cursor:wait;opacity:.35}
      .row{margin-top:5px}.name{opacity:.65;font-size:10px}.number{font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}
      .number small{font-size:10px;font-weight:400;opacity:.6;margin-left:3px}
      .track{margin-top:3px;height:3px;border-radius:4px;overflow:hidden;background:color-mix(in srgb,currentColor 9%,transparent)}
      .fill{height:100%;border-radius:4px;background:#16a77a;transition:width .35s ease}
      .reset{display:flex;justify-content:space-between;gap:4px;font-size:9px;opacity:.5;margin-top:3px;font-variant-numeric:tabular-nums;white-space:nowrap}
      .summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:8px;padding-top:7px;border-top:1px solid color-mix(in srgb,currentColor 10%,transparent)}.summary-item{min-width:0}.summary-label{font-size:9px;opacity:.7}.summary-value{font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:2px}.summary-detail{font-size:9px;line-height:1.25;opacity:.55;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.summary-detail.expiry{color:inherit;opacity:.9}.summary-detail[title]{cursor:help}
      .credits{margin-top:6px;font-size:9px;border-top:1px solid color-mix(in srgb,currentColor 10%,transparent);padding-top:5px}.credits[hidden]{display:none}.credits summary{cursor:pointer;overflow-wrap:anywhere}.credits-list{margin-top:5px;display:grid;gap:6px}.credit-expiry{display:block;opacity:.65}.credit-warning{color:#df8842;opacity:1}
      .foot{margin-top:5px;font-size:10px;color:#df8842}.foot[hidden]{display:none}.stale .fill{opacity:.45}
      @media(prefers-reduced-motion:reduce){.fill{transition:none}.refresh svg{animation:none!important}}
    </style>
    <section class="card" aria-label="Zhengru 网关额度">
      <div class="head"><button class="toggle" type="button" aria-expanded="true" aria-controls="quota-details" aria-label="收起额度详情"><svg class="chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="title">网关额度</span></button><div class="actions"><button class="usage-link" type="button">查看用量</button><button class="refresh" type="button" title="刷新额度" aria-label="刷新额度" aria-busy="false"><svg width="14" height="14" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M36.7279 36.7279C33.4706 39.9853 28.9706 42 24 42C14.0589 42 6 33.9411 6 24C6 14.0589 14.0589 6 24 6C28.9706 6 33.4706 8.01472 36.7279 11.2721C38.3859 12.9301 42 17 42 17" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M42 8V17H33" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div></div>
      <div id="quota-details">
      <div class="row" data-window="five_hour"><div class="label"><span class="name">5 小时</span><span class="number"><b>—</b><small>剩余</small></span></div><div class="track" role="progressbar" aria-label="5 小时剩余额度" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:0%"></div></div><div class="reset"><time>等待查询</time><span class="countdown"></span></div></div>
      <div class="row" data-window="seven_day"><div class="label"><span class="name">7 天</span><span class="number"><b>—</b><small>剩余</small></span></div><div class="track" role="progressbar" aria-label="7 天剩余额度" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:0%"></div></div><div class="reset"><time>等待查询</time><span class="countdown"></span></div></div>
      <div class="summary"><div class="summary-item"><div class="summary-label">重置卡</div><div class="summary-value" id="reset-card-count"></div><div class="summary-detail expiry" id="reset-card-expiry">等待查询</div></div><div class="summary-item"><div class="summary-label">点数余额</div><div class="summary-value" id="credit-balance">—</div><div class="summary-detail">Credits</div></div></div>
      <div class="foot" id="foot" role="status" hidden></div>
      </div>
    </section>
    <dialog aria-labelledby="usage-title"><div class="dialog-head"><h2 id="usage-title">用户 Token 用量排行</h2><button type="button" class="usage-close" aria-label="关闭用量排行">关闭</button></div>
    <form class="usage-filters"><button type="button" data-days="1">1 天</button><button type="button" data-days="3">3 天</button><button type="button" data-days="7">7 天</button><label>开始 <input type="date" class="usage-start" required></label><label>结束 <input type="date" class="usage-end" required></label><button type="submit">查询</button></form>
    <p class="usage-status" role="status" aria-live="polite"></p><p class="usage-error" role="alert" hidden></p>
    <div class="usage-scroll"><table><thead><tr><th>用户</th><th>请求数</th><th>输入 Token</th><th>输出 Token</th><th>缓存 Token</th><th>总 Token ↓</th><th>费用 ($)</th></tr></thead><tbody></tbody></table></div>
    <div class="usage-pages"><label>每页 <select><option value="20">20 条</option><option value="50">50 条</option><option value="100">100 条</option></select></label><button type="button" class="usage-prev" disabled>上一页</button><span class="usage-page">第 1 页</span><button type="button" class="usage-next" disabled>下一页</button></div></dialog>`;
  const toggle = root.querySelector('.toggle');
  function paintCollapse() {
    root.getElementById('quota-details').hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? '展开额度详情' : '收起额度详情');
  }
  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    try { localStorage.setItem(COLLAPSED_KEY, String(collapsed)); } catch {}
    paintCollapse();
    paint();
  });
  paintCollapse();
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
    if (usageDeadline && Date.now()>usageDeadline) receiveUsage({id:usageId,error:'用量查询超时，请检查后台连接后重试。'});
    const disconnected = Date.now() - lastContact > 45_000;
    const stale = !!current?.error || disconnected || (current?.receivedAt != null && Date.now() - current.receivedAt > 270_000);
    root.querySelector('.card').classList.toggle('stale', stale);
    toggle.title = stale ? '更新失败，展开查看详情' : '点击' + (collapsed ? '展开' : '收起') + '额度详情';
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
    const info = current?.data?.reset_credits || {}, dates = (info.credits || []).map(c => c.expires_at).filter(Boolean).sort((a,b) => Date.parse(a)-Date.parse(b));
    const count = root.getElementById('reset-card-count'), expiry = root.getElementById('reset-card-expiry'), balance = current?.data?.credits?.balance == null ? NaN : Number(current.data.credits.balance);
    count.textContent = Number.isFinite(info.available_count) ? String(info.available_count) : '—';
    const shortDate = value => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone:'Asia/Shanghai', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(new Date(value)).map(x => [x.type, x.value])); return `${p.month}/${p.day} ${p.hour}:${p.minute}:${p.second}`; };
    expiry.textContent = dates[0] ? shortDate(dates[0]) : '暂无过期时间';
    expiry.title = dates.length ? `所有重置卡到期时间：\n${dates.map((value,index) => `${index + 1}. ${exactDate(value)}`).join('\n')}` : '';
    root.getElementById('credit-balance').textContent = current?.data?.credits?.unlimited ? '无限' : Number.isFinite(balance) ? balance.toFixed(3) : '—';
    const foot = root.getElementById('foot');
    foot.hidden = !stale;
    foot.textContent = stale ? (current?.data ? '更新失败 · 当前为上次数据' : '暂时无法查询额度，请检查后台连接') : '';
    foot.title = stale ? (current?.error || '本机额度程序已断开') : '';
  }
  const dialog = root.querySelector('dialog');
  const usageStatus = root.querySelector('.usage-status');
  const usageError = root.querySelector('.usage-error');
  const startInput = root.querySelector('.usage-start'), endInput = root.querySelector('.usage-end');
  function quickRange(days) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year:'numeric',month:'2-digit',day:'2-digit' }).formatToParts(new Date()).map(p => [p.type,p.value]));
    endInput.value = `${parts.year}-${parts.month}-${parts.day}`;
    const start = new Date(endInput.value+'T00:00:00Z'); start.setUTCDate(start.getUTCDate()-days+1); startInput.value=start.toISOString().slice(0,10);
    root.querySelectorAll('[data-days]').forEach(b => { const active=Number(b.dataset.days)===days; b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active)); });
  }
  function queryUsage(page=1, apply=false) {
    if(apply) {
      if(!startInput.value || !endInput.value || startInput.value>endInput.value) { usageError.hidden=false;usageError.textContent='开始日期不能晚于结束日期。';return; }
      usageRange={start_date:startInput.value,end_date:endInput.value};
    }
    usageRequest={id:++usageId,...usageRange,page,page_size:Number(root.querySelector('select').value)};
    usageDeadline=Date.now()+30000;
    usageError.hidden=true;usageStatus.textContent='正在查询…';root.querySelector('tbody').replaceChildren();
    root.querySelector('.usage-prev').disabled=true;root.querySelector('.usage-next').disabled=true;
  }
  function receiveUsage(result) {
    if(result.id!==usageId || !dialog.open)return;
    usageDeadline=0;
    if(result.error) {usageStatus.textContent='查询失败，请点击查询重试。';usageError.textContent=result.error;usageError.hidden=false;return;}
    const data=result.data;usagePage=data.page;
    for(const user of data.users) {
      const row=document.createElement('tr');
      for(const key of ['email','requests','input_tokens','output_tokens','cache_tokens','total_tokens','cost']) {
        const cell=document.createElement('td'),n=user[key];
        if(key==='email')cell.textContent=n || `用户 ${user.user_id}`;
        else if(!Number.isFinite(n))cell.textContent='—';
        else {cell.title=String(n);cell.textContent=key==='cost'?'$'+n.toFixed(3):key.endsWith('tokens')?(Math.abs(n)>=999995?(n/1e6).toLocaleString('en-US',{maximumFractionDigits:2})+' M':Math.abs(n)>=1000?(n/1e3).toLocaleString('en-US',{maximumFractionDigits:2})+' K':n.toLocaleString('en-US')):n.toLocaleString('en-US');}
        row.append(cell);
      }
      root.querySelector('tbody').append(row);
    }
    usageStatus.textContent=`${data.start_date} 至 ${data.end_date}（含首尾日期，${data.timezone}） · ${data.users.length ? '本页 '+data.users.length+' 位用户':'暂无用量记录'}`;
    root.querySelector('.usage-page').textContent=`第 ${usagePage} 页`;
    root.querySelector('.usage-prev').disabled=usagePage<=1;root.querySelector('.usage-next').disabled=!data.has_more;
  }
  root.querySelector('.usage-link').addEventListener('click',()=>{dialog.showModal();quickRange(1);queryUsage(1,true);});
  root.querySelector('.usage-close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{usageId++;usageRequest=null;usageDeadline=0;});
  dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
  root.querySelector('.usage-filters').addEventListener('submit',e=>{e.preventDefault();queryUsage(1,true);});
  root.querySelectorAll('[data-days]').forEach(b=>b.addEventListener('click',()=>{quickRange(Number(b.dataset.days));queryUsage(1,true);}));
  for(const input of [startInput,endInput]) input.addEventListener('input',()=>root.querySelectorAll('[data-days]').forEach(b=>{b.classList.remove('active');b.setAttribute('aria-pressed','false');}));
  root.querySelector('select').addEventListener('change',()=>queryUsage(1));
  root.querySelector('.usage-prev').addEventListener('click',()=>queryUsage(usagePage-1));
  root.querySelector('.usage-next').addEventListener('click',()=>queryUsage(usagePage+1));
  function findSidebar() {
    // Codex 26.1103 splits the navigation root into a rail and a content column.
    // A full-width card belongs inside the column; rail-only mode has no space.
    const shell = document.getElementById('app-shell-sidebar');
    if (!options.selector && shell?.querySelector('[data-app-navigation-rail]') &&
        !shell.querySelector('[data-slate-sidebar-content]')) return null;
    const selectors = options.selector ? [options.selector] : [
      '#app-shell-sidebar [data-slate-sidebar-content]',
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
    // New clients emit data-sidebar-collapsed=""; older ones use "true".
    const collapsed = target.closest('[data-sidebar-collapsed]:not([data-sidebar-collapsed="false"]), [inert], [hidden], [aria-hidden="true"]');
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
    attributeFilter: ['data-sidebar-collapsed', 'inert', 'hidden', 'aria-hidden'] });
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
    version: 8,
    update(value) { current = value; lastContact = Date.now(); waitingForRefresh = false; mount(); paint(); return status(); }, status,
    receiveUsage,
    takeUsageRequest() {const request=usageRequest;usageRequest=null;return request;},
    takeRefreshRequest() { const requested = refreshRequested; refreshRequested = false; return requested; },
    dispose() { disposed = true; observer.disconnect(); clearInterval(timer); dialog.close(); host.remove(); delete window[KEY]; },
  };
  mount(); paint();
  return status();
}
