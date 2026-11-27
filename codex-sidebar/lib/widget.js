// Executed only inside the Codex app renderer. This function is self-contained.
function installQuotaWidget(snapshot, options = {}) {
  const KEY = '__zhengruQuotaSidebarV1';
  const HOST = 'zhengru-quota-sidebar';
  const BINDING = '__zhengruQuotaDispatch';
  // Immediate channel to the daemon; the polling request state stays as fallback.
  const dispatch = message => { try { if (typeof window[BINDING] === 'function') window[BINDING](JSON.stringify(message)); } catch {} };
  const version = 38;
  if (window[KEY]?.version !== version) window[KEY]?.dispose();
  if (window[KEY]) {
    window[KEY].update(snapshot, options);
    return window[KEY].status();
  }
  let current = snapshot;
  let disposed = false;
  let scheduled = false;
  let sidebar = null;
  let positioned = null;
  let refreshRequested = false, refreshId = 0;
  let waitingForRefresh = false;
  let lastContact = Date.now();
  const COLLAPSED_KEY = 'zhengruQuotaSidebar.collapsed';
  const COST_ESTIMATION_KEY = 'zhengruQuotaSidebar.costEstimation';
  let collapsed = false;
  let costEstimation = false;
  // Some renderer contexts deny storage; toggling still works for this session.
  try { collapsed = localStorage.getItem(COLLAPSED_KEY) === 'true'; } catch {}
  try { costEstimation = localStorage.getItem(COST_ESTIMATION_KEY) === 'true'; } catch {}
  let usageRequest = null, usageId = 0, usagePage = 1, usageRange = null, usageDeadline = 0;
  let activityRequest = null, activityId = 0, activityDeadline = 0, activityData = null, activityMetric = 'tokens', activityUser = '', activityBusy = false, activityDay = null;
  const host = document.createElement('div');
  host.id = HOST;
  host.toggleAttribute('data-windows', /^Win/i.test(navigator.platform));
  host.style.cssText = 'display:block;position:absolute;left:10px;right:10px;bottom:14px;min-width:0;width:auto;z-index:2147483000;-webkit-app-region:no-drag;';
  const root = host.attachShadow({ mode: 'open' });
  // 外观默认跟随系统深浅色，助手可强制浅色／深色；切换无需重新挂载
  const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
  let forcedTheme = null;
  const applyScheme = () => { host.dataset.theme = forcedTheme || (colorScheme.matches ? 'dark' : 'light'); };
  const setTheme = value => {
    const next = value === 'light' || value === 'dark' ? value : null;
    if (next === forcedTheme) return;
    forcedTheme = next;
    applyScheme();
  };
  applyScheme();
  colorScheme.addEventListener('change', applyScheme);
  setTheme(options.theme);
  root.innerHTML = `
    <style>
      :host{font-family:inherit;font-size:12px;color-scheme:light;--qmono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;--qink:#101d29;--qmuted:rgba(16,29,41,.6);--qbg:linear-gradient(165deg,rgba(255,255,255,.88),rgba(255,255,255,.78));--qsolid:#fff;--qhead:rgba(255,255,255,.66);--qline:rgba(255,255,255,.55);--qedge:rgba(15,23,42,.14);--qtrack:rgba(15,23,42,.13);--qseg:rgba(255,255,255,.5);--qaccent:#12a48c;--qglow:rgba(18,164,140,.5);--qradius:26px;--qshadow:0 26px 56px rgba(2,6,23,.3),0 10px 22px rgba(2,6,23,.18);--qbounce:cubic-bezier(.34,1.56,.64,1);--qbright:1.03;--qlens:linear-gradient(125deg,transparent 30%,rgba(255,255,255,.4) 46%,rgba(255,255,255,.04) 58%,transparent 72%),radial-gradient(120% 120% at 50% 50%,transparent 72%,rgba(255,255,255,.3) 90%,rgba(150,180,255,.18) 100%);--qlens-opacity:.6;--qglass:inset 0 1px 0 rgba(255,255,255,.9),inset 0 0 0 1px rgba(255,255,255,.32),inset 0 8px 20px rgba(255,255,255,.34),inset 0 -12px 24px rgba(15,23,42,.05);--qseg-bg:rgba(15,23,42,.05);--qseg-shadow:inset 0 1px 3px rgba(15,23,42,.08);--qactive-bg:linear-gradient(180deg,#fff,rgba(255,255,255,.72));--qactive-shadow:0 3px 8px rgba(2,6,23,.14),inset 0 1px 0 #fff;--qpanel-bg:rgba(255,255,255,.34);--qpanel-shadow:inset 0 1px 0 rgba(255,255,255,.5);--qinset:inset 0 1px 2px rgba(15,23,42,.2);--qskel:linear-gradient(100deg,rgba(15,23,42,.07) 40%,rgba(15,23,42,.17) 50%,rgba(15,23,42,.07) 60%);--qscroll:rgba(15,23,42,.28);--qscroll-track:rgba(15,23,42,.06);--qscroll-thumb:rgba(15,23,42,.22);--qtip-shadow:0 12px 30px rgba(2,6,23,.25);--qhm0:rgba(15,23,42,.08);--qhm1:#c9def2;--qhm2:#8fc0e8;--qhm3:#4b93cf;--qhm4:#1d64a8}
      :host([data-theme="dark"]){color-scheme:dark;--qink:#e8eef5;--qmuted:rgba(232,238,245,.62);--qbg:linear-gradient(165deg,rgba(32,38,47,.88),rgba(21,26,33,.82));--qsolid:#1d232c;--qhead:rgba(29,35,44,.74);--qline:rgba(255,255,255,.1);--qedge:rgba(255,255,255,.16);--qtrack:rgba(255,255,255,.16);--qseg:rgba(255,255,255,.08);--qaccent:#2ec4a6;--qglow:rgba(46,196,166,.45);--qshadow:0 26px 56px rgba(0,0,0,.5),0 10px 22px rgba(0,0,0,.38);--qbright:.9;--qlens:linear-gradient(125deg,transparent 30%,rgba(255,255,255,.14) 46%,rgba(255,255,255,.02) 58%,transparent 72%),radial-gradient(120% 120% at 50% 50%,transparent 72%,rgba(255,255,255,.08) 90%,rgba(150,180,255,.12) 100%);--qlens-opacity:.35;--qglass:inset 0 1px 0 rgba(255,255,255,.2),inset 0 0 0 1px rgba(255,255,255,.08),inset 0 8px 20px rgba(255,255,255,.07),inset 0 -12px 24px rgba(0,0,0,.3);--qseg-bg:rgba(255,255,255,.07);--qseg-shadow:inset 0 1px 3px rgba(0,0,0,.35);--qactive-bg:linear-gradient(180deg,rgba(255,255,255,.18),rgba(255,255,255,.08));--qactive-shadow:0 3px 8px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.22);--qpanel-bg:rgba(255,255,255,.05);--qpanel-shadow:inset 0 1px 0 rgba(255,255,255,.08);--qinset:inset 0 1px 2px rgba(0,0,0,.4);--qskel:linear-gradient(100deg,rgba(255,255,255,.05) 40%,rgba(255,255,255,.13) 50%,rgba(255,255,255,.05) 60%);--qscroll:rgba(255,255,255,.24);--qscroll-track:rgba(255,255,255,.07);--qscroll-thumb:rgba(255,255,255,.2);--qtip-shadow:0 12px 30px rgba(0,0,0,.55);--qhm0:rgba(255,255,255,.07);--qhm1:#1e3d63;--qhm2:#2e6da4;--qhm3:#5ea3d8;--qhm4:#b3e0fa}
      *{box-sizing:border-box}
      .card{padding:10px 11px;border:1px solid var(--qline);border-radius:var(--qradius);background:var(--qbg);backdrop-filter:blur(40px) saturate(1.7) brightness(var(--qbright));-webkit-backdrop-filter:blur(40px) saturate(1.7) brightness(var(--qbright));box-shadow:var(--qshadow);color:var(--qink);line-height:1.35;user-select:none;position:relative;isolation:isolate;overflow:hidden;animation:lg-in .55s var(--qbounce) both}
      .card::before,dialog::before{content:"";position:absolute;inset:0;z-index:0;border-radius:inherit;pointer-events:none;mix-blend-mode:screen;opacity:var(--qlens-opacity);filter:url(#lg-lens);background:var(--qlens)}
      .card::after,dialog::after{content:"";position:absolute;inset:0;z-index:2;border-radius:inherit;pointer-events:none;box-shadow:var(--qglass)}
      .card>*,dialog>*{position:relative;z-index:1}
      .toggle,.refresh,.usage-link,.usage-close,dialog button,.seg button,input,select{transition:transform .28s var(--qbounce),background .2s ease,box-shadow .2s ease,opacity .2s ease,color .2s ease,filter .2s ease}
      .toggle:active,.refresh:active,.usage-close:active,dialog button:active,.seg button:active{transform:scale(.93)}
      @keyframes lg-in{from{opacity:0;transform:scale(.955) translateY(5px)}to{opacity:1;transform:none}}
      @keyframes dlg-in{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
      @keyframes dlg-out{to{opacity:0;transform:translateY(10px)}}
      @keyframes bd-in{from{opacity:0}to{opacity:1}}
      @keyframes bd-out{to{opacity:0}}
      .actions{display:flex;align-items:center;gap:5px}.usage-link{border:0;background:transparent;color:inherit;font:inherit;font-size:10px;opacity:.65;cursor:pointer;padding:3px}.usage-link:hover{opacity:1;text-decoration:underline}
      dialog{color:var(--qink);background:var(--qbg);backdrop-filter:blur(40px) saturate(1.7) brightness(var(--qbright));-webkit-backdrop-filter:blur(40px) saturate(1.7) brightness(var(--qbright));border:1px solid var(--qline);border-radius:28px;box-shadow:0 30px 90px #0008;position:relative;isolation:isolate;padding:22px 24px;width:min(920px,calc(100vw - 40px));max-height:85vh;overflow:auto;user-select:text;font-size:12px}dialog[open]{display:flex;flex-direction:column;animation:dlg-in .3s cubic-bezier(.22,.85,.3,1)}dialog[open]::backdrop{animation:bd-in .3s ease-out}dialog.closing{animation:dlg-out .18s ease-in forwards;pointer-events:none}dialog.closing::backdrop{animation:bd-out .18s ease-in forwards}dialog::backdrop{background:rgba(8,12,20,.42);backdrop-filter:blur(10px) saturate(1.2);-webkit-backdrop-filter:blur(10px) saturate(1.2)}
      .dialog-head,.activity,.usage-filters,.usage-pages{flex:none}
      .dialog-head,.usage-pages{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.dialog-head{justify-content:space-between}.dialog-head h2{font-size:15px;font-weight:600;margin:0;letter-spacing:-.01em}
      .usage-close{display:grid;place-items:center;width:28px;height:28px;padding:0;border:1px solid var(--qline);border-radius:9px;background:var(--qseg);color:inherit;cursor:pointer;opacity:.75}.usage-close:hover{opacity:1;background:var(--qtrack)}.usage-close:focus-visible{outline:2px solid var(--qaccent);outline-offset:1px}
      .usage-filters{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:14px 0 12px}
      .seg{display:inline-flex;gap:3px;background:var(--qseg-bg);border:1px solid var(--qline);border-radius:14px;padding:4px;box-shadow:var(--qseg-shadow)}.seg button{border:0;background:transparent;color:inherit;opacity:.62;font-family:var(--qmono);font-size:11px;padding:6px 13px;border-radius:11px;cursor:pointer}.seg button.active{background:var(--qactive-bg);opacity:1;font-weight:600;box-shadow:var(--qactive-shadow)}
      .usage-dates{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.usage-dates label{display:flex;align-items:center;gap:6px;font-family:var(--qmono);font-size:10px;color:var(--qmuted)}
      dialog button,dialog input,dialog select{font:inherit;color:inherit;background:transparent;border:1px solid var(--qline);border-radius:8px;padding:6px 9px}dialog button{cursor:pointer}dialog button:disabled{opacity:.4;cursor:default}
      .usage-scroll{overflow:auto;flex:1;min-height:0;border:1px solid var(--qline);border-radius:12px}table{width:100%;border-collapse:collapse;white-space:nowrap;font-variant-numeric:tabular-nums}th,td{padding:10px 12px;border-bottom:1px solid var(--qline);text-align:right;font-family:var(--qmono);font-size:11px}th{position:sticky;top:0;z-index:1;background:var(--qhead);color:var(--qmuted);font-weight:500;font-size:10px;letter-spacing:.1em}th:first-child,td:first-child{text-align:left;font-family:inherit;font-size:12px}td small{display:block;font-family:var(--qmono);font-size:9px;opacity:.6;margin-top:2px}td.strong{font-weight:600}tbody tr:hover{background:var(--qseg)}tbody tr.estimated-row{background:color-mix(in srgb,var(--qaccent) 9%,transparent)}tbody tr.estimated-row:hover{background:color-mix(in srgb,var(--qaccent) 15%,transparent)}tbody tr:last-child td{border-bottom:0}
      .usage-status{font-family:var(--qmono);font-size:10px;color:var(--qmuted);margin:0 0 10px}.direct-note{margin:10px 0 0;flex:none}.usage-error{color:#df8842;font-size:11px;margin:0 0 10px}
      .usage-pages{justify-content:flex-end;margin-top:14px;font-family:var(--qmono);font-size:10px}.usage-pages label{display:flex;align-items:center;gap:6px;color:var(--qmuted)}
      .activity{margin:14px 0 16px;border:1px solid var(--qline);border-radius:16px;padding:14px 16px;background:var(--qpanel-bg);box-shadow:var(--qpanel-shadow)}
      .activity-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px}.activity-head h3{margin:0;font-size:13px;font-weight:600;letter-spacing:-.01em}
      .activity-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.activity-controls select{max-width:220px;font-size:11px}
      .activity .seg{padding:3px}.activity .seg button{padding:5px 11px;font-size:10px}
      .activity .usage-status{margin:0 0 8px}.activity .usage-error{margin:0 0 8px}
      .hm-wrap{position:relative}
      .hm-scroll{overflow-x:auto;padding-bottom:4px;scrollbar-width:thin;scrollbar-color:var(--qscroll) transparent}
      .hm-scroll::-webkit-scrollbar{height:7px}.hm-scroll::-webkit-scrollbar-track{background:var(--qscroll-track);border-radius:99px}.hm-scroll::-webkit-scrollbar-thumb{background:var(--qscroll-thumb);border-radius:99px}.hm-scroll::-webkit-scrollbar-thumb:hover{background:var(--qaccent)}
      .hm-grid{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,12px);grid-auto-columns:12px;gap:3px;width:max-content;min-height:102px}
      .hm-cell{width:12px;height:12px;border-radius:3px;background:var(--qhm0)}
      .hm-cell[data-level="1"]{background:var(--qhm1)}.hm-cell[data-level="2"]{background:var(--qhm2)}.hm-cell[data-level="3"]{background:var(--qhm3)}.hm-cell[data-level="4"]{background:var(--qhm4)}
      .hm-cell.pad{visibility:hidden}.hm-cell[data-date]{cursor:pointer}.hm-cell[data-date]:hover{outline:1px solid var(--qink);outline-offset:1px}
      .hm-cell.selected,.hm-cell.selected:hover{outline:2px solid var(--qaccent);outline-offset:1px}
      .hm-cell.skel,.skel-bar{background:var(--qskel);background-size:200% 100%;animation:q-sweep 1.1s linear infinite}
      .skel-bar{display:block;height:10px;border-radius:5px}.hm-summary .skel-bar{width:230px;height:9px}
      @keyframes q-sweep{from{background-position:200% 0}to{background-position:-200% 0}}
      .hm-months{display:grid;gap:3px;width:max-content;margin-top:5px;font-family:var(--qmono);font-size:9px;color:var(--qmuted);min-height:11px}.hm-months span{grid-row:1;white-space:nowrap}
      .hm-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-top:9px;font-family:var(--qmono);font-size:10px;color:var(--qmuted)}
      .hm-legend{display:flex;align-items:center;gap:3px}.hm-legend .hm-cell{width:10px;height:10px}
      .hm-tip{position:absolute;z-index:5;pointer-events:none;background:var(--qsolid);border:1px solid var(--qedge);border-radius:10px;padding:8px 11px;font-family:var(--qmono);font-size:10px;line-height:1.7;box-shadow:var(--qtip-shadow);white-space:nowrap;color:var(--qmuted)}.hm-tip b{display:block;color:var(--qink)}.hm-tip .hi{color:var(--qink)}
      .head,.label{display:flex;justify-content:space-between;align-items:center;gap:8px}
      .title{font-family:var(--qmono);font-weight:600;font-size:11px;letter-spacing:.06em}
      .toggle{display:flex;align-items:center;gap:4px;flex:1;min-width:0;border:0;border-radius:4px;padding:3px;margin:-3px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;white-space:nowrap}
      .toggle:hover{background:var(--qseg)}.toggle:focus-visible{outline:2px solid var(--qaccent);outline-offset:1px}
      .chevron{flex:none;opacity:.55;transition:transform .3s var(--qbounce)}.toggle[aria-expanded="false"] .chevron{transform:rotate(-90deg)}
      .gauge{display:none;flex:none}.toggle[aria-expanded="false"] .gauge{display:block}
      .gauge .gtrack{stroke:var(--qtrack)}.gauge .gfill{stroke:var(--qaccent);transition:stroke-dashoffset .35s ease}.stale .gauge .gfill{opacity:.45}.gauge .gem{fill:var(--qmuted);opacity:.6}
      .gauge .ring{display:none}.single-window .gauge .arcs{display:none}.single-window .gauge .ring{display:block}
      .stale .toggle .title::after{content:'●';font-size:7px;color:#df8842;margin-left:4px}
      #quota-details[hidden]{display:none}
      .refresh{display:grid;place-items:center;width:20px;height:20px;padding:3px;border:0;border-radius:5px;background:transparent;color:inherit;opacity:.55;cursor:pointer}
      .refresh:hover{opacity:1;background:var(--qseg)}
      .refresh:focus-visible{outline:2px solid var(--qaccent);outline-offset:1px}
      .refresh:disabled{cursor:wait;opacity:.35}
      .row{margin-top:5px}.row[hidden]{display:none}.name{opacity:.65;font-size:10px;letter-spacing:.08em}.number{font-family:var(--qmono);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}
      .number small{font-size:10px;font-weight:400;opacity:.6;margin-left:3px}
      .track{margin-top:3px;height:5px;border-radius:99px;overflow:hidden;background:var(--qtrack);box-shadow:var(--qinset)}
      .fill{height:100%;border-radius:99px;background:var(--qaccent);box-shadow:0 0 10px var(--qglow);transition:width .5s var(--qbounce),background .3s ease}
      .reset{display:flex;justify-content:space-between;gap:4px;font-family:var(--qmono);font-size:9px;opacity:.55;margin-top:3px;font-variant-numeric:tabular-nums;white-space:nowrap}
      .wstats{display:flex;flex-wrap:wrap;gap:3px 6px;margin-top:4px;font-family:var(--qmono);font-size:9px;color:var(--qmuted);font-variant-numeric:tabular-nums;line-height:1.35}
      .wstats[hidden]{display:none}
      .wstats span{white-space:nowrap}
      .summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:8px;padding-top:7px;border-top:1px solid var(--qline)}.summary-item{min-width:0}.summary-label{font-family:var(--qmono);font-size:9px;letter-spacing:.1em;opacity:.7}.summary-value{font-family:var(--qmono);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:2px}.summary-detail{font-family:var(--qmono);font-size:9px;line-height:1.25;opacity:.55;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.summary-detail.expiry{color:inherit;opacity:.9}.summary-detail[title]{cursor:help}
      .credits{margin-top:6px;font-family:var(--qmono);font-size:9px;border-top:1px solid var(--qline);padding-top:5px}.credits[hidden]{display:none}.credits summary{cursor:pointer;overflow-wrap:anywhere}.credits-list{margin-top:5px;display:grid;gap:6px}.credit-expiry{display:block;opacity:.65}.credit-warning{color:#df8842;opacity:1}
      .foot{margin-top:5px;font-family:var(--qmono);font-size:10px;color:#df8842}.foot[hidden]{display:none}.stale .fill{opacity:.45}
      :host([data-windows]){
        font-family:"Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",sans-serif;
        --qmuted:light-dark(#555e65,#b9c3ca);
        --qsolid:light-dark(#fcfcfc,#24282c);--qbg:var(--qsolid);--qhead:var(--qsolid);
        --qline:light-dark(#d8dde0,#42494f);--qedge:var(--qline);
        --qseg:light-dark(#eef2f3,#343a40);--qradius:10px;--qshadow:0 2px 8px #0002
      }
      :host([data-windows]) :is(.card,dialog){backdrop-filter:none}
      :host([data-windows]) :is(.card,dialog)::before,:host([data-windows]) :is(.card,dialog)::after{display:none}
      :host([data-windows]) .card{padding:8px 11px;animation:none}
      :host([data-windows]) .title{font-family:inherit;font-size:13px;letter-spacing:normal}
      :host([data-windows]) :is(.name,.summary-label){color:var(--qmuted);font-family:inherit;font-size:11px;letter-spacing:normal;opacity:1}
      :host([data-windows]) .refresh{width:26px;height:26px;opacity:.85}
      :host([data-windows]) .usage-link{padding:4px;font-size:11px;opacity:.85}
      :host([data-windows]) .reset{flex-wrap:wrap;color:var(--qmuted);opacity:1}
      :host([data-windows]) .foot{overflow-wrap:anywhere;color:light-dark(#904600,#ffc181)}
      :host([data-windows]) .fill{box-shadow:none}
      :host([data-windows]) .seg button.active{background:var(--qsolid);box-shadow:0 1px 3px #0003}
      :host([data-windows]) .activity{background:var(--qseg);box-shadow:none}
      @media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}.fill{transition:none}.gauge .gfill{transition:none}.refresh svg{animation:none!important}}
    </style>
    <svg class="lg-defs" width="0" height="0" aria-hidden="true" focusable="false" style="position:absolute"><defs>
      <filter id="lg-lens" x="-12%" y="-12%" width="124%" height="124%" filterUnits="objectBoundingBox" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.012 0.02" numOctaves="2" seed="11" result="n"/>
        <feGaussianBlur in="n" stdDeviation="1.6" result="ns"/>
        <feDisplacementMap in="SourceGraphic" in2="ns" scale="16" xChannelSelector="R" yChannelSelector="G"/>
      </filter>
    </defs></svg>
    <section class="card" aria-label="Zhengru 网关额度">
      <div class="head"><button class="toggle" type="button" aria-expanded="true" aria-controls="quota-details" aria-label="收起额度详情"><svg class="chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><svg class="gauge" width="26" height="26" viewBox="0 0 48 48" fill="none" aria-hidden="true"><g class="arcs"><path class="gtrack" d="M6.78 15.97A19 19 0 0 1 41.22 15.97" stroke-width="5" stroke-linecap="round"/><path class="gfill" data-gauge="five_hour" d="M6.78 15.97A19 19 0 0 1 41.22 15.97" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100" stroke-width="5" stroke-linecap="round"/><path class="gtrack" d="M5.07 25.66A19 19 0 0 0 42.93 25.66" stroke-width="5" stroke-linecap="round"/><path class="gfill" data-gauge="seven_day" d="M5.07 25.66A19 19 0 0 0 42.93 25.66" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100" stroke-width="5" stroke-linecap="round"/></g><g class="ring"><circle class="gtrack" cx="24" cy="24" r="19" stroke-width="5"/><circle class="gfill" data-gauge="seven_day" cx="24" cy="24" r="19" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100" stroke-width="5" stroke-linecap="round" transform="rotate(-90 24 24)"/></g><rect class="gem" x="17" y="17" width="14" height="14" transform="rotate(45 24 24)"/></svg><span class="title">网关额度</span></button><div class="actions"><button class="usage-link" type="button">查看用量</button><button class="refresh" type="button" title="刷新额度" aria-label="刷新额度" aria-busy="false"><svg width="14" height="14" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M36.7279 36.7279C33.4706 39.9853 28.9706 42 24 42C14.0589 42 6 33.9411 6 24C6 14.0589 14.0589 6 24 6C28.9706 6 33.4706 8.01472 36.7279 11.2721C38.3859 12.9301 42 17 42 17" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M42 8V17H33" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div></div>
      <div id="quota-details">
      <div class="row" data-window="five_hour"><div class="label"><span class="name">5 小时</span><span class="number"><b>—</b><small>剩余</small></span></div><div class="track" role="progressbar" aria-label="5 小时剩余额度" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:0%"></div></div><div class="reset"><time>等待查询</time><span class="countdown"></span></div><div class="wstats" hidden></div></div>
      <div class="row" data-window="seven_day"><div class="label"><span class="name">7 天</span><span class="number"><b>—</b><small>剩余</small></span></div><div class="track" role="progressbar" aria-label="7 天剩余额度" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:0%"></div></div><div class="reset"><time>等待查询</time><span class="countdown"></span></div><div class="wstats" hidden></div></div>
      <div class="summary"><div class="summary-item"><div class="summary-label">重置卡</div><div class="summary-value" id="reset-card-count"></div><div class="summary-detail expiry" id="reset-card-expiry">等待查询</div></div><div class="summary-item"><div class="summary-label">点数余额</div><div class="summary-value" id="credit-balance">—</div><div class="summary-detail">Credits</div></div></div>
      <div class="foot" id="foot" role="status" hidden></div>
      </div>
    </section>
    <dialog aria-labelledby="usage-title"><div class="dialog-head"><h2 id="usage-title">用户 Token 用量排行</h2><button type="button" class="usage-close" aria-label="关闭用量排行"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>
    <section class="activity" aria-label="Token Activity"><div class="activity-head"><h3>Token Activity</h3><div class="activity-controls"><select class="activity-user" aria-label="选择用户"><option value="">全部用户</option></select><div class="seg" role="group" aria-label="统计口径"><button type="button" data-metric="tokens" class="active" aria-pressed="true">Tokens</button><button type="button" data-metric="cost" aria-pressed="false">Cost</button></div></div></div>
    <p class="activity-status usage-status" role="status" aria-live="polite" hidden></p><p class="activity-error usage-error" role="alert" hidden></p>
    <div class="hm-wrap"><div class="hm-scroll"><div class="hm-grid" role="img" aria-label="近 365 天 Token 活跃热力图"></div><div class="hm-months" aria-hidden="true"></div></div><div class="hm-tip" hidden></div></div>
    <div class="hm-foot"><div class="hm-legend" aria-hidden="true">少 <span class="hm-cell" data-level="0"></span><span class="hm-cell" data-level="1"></span><span class="hm-cell" data-level="2"></span><span class="hm-cell" data-level="3"></span><span class="hm-cell" data-level="4"></span> 多</div><div class="hm-summary"></div></div></section>
    <form class="usage-filters"><div class="seg" role="group" aria-label="快捷日期"><button type="button" data-days="1">1 天</button><button type="button" data-days="3">3 天</button><button type="button" data-days="7">7 天</button></div><div class="usage-dates"><label>开始 <input type="date" class="usage-start" required></label><label>结束 <input type="date" class="usage-end" required></label><button type="submit">查询</button></div></form>
    <p class="usage-status rank-status" role="status" aria-live="polite" hidden></p><p class="usage-error rank-error" role="alert" hidden></p>
    <p class="usage-status direct-note" hidden></p>
    <div class="usage-scroll"><table><thead><tr><th>用户</th><th>请求数</th><th>输入 Token</th><th>输出 Token</th><th>缓存 Token</th><th title="缓存 Token / (输入 + 缓存 Token)">缓存命中率</th><th>总 Token</th><th aria-sort="descending">费用 ($) ↓</th></tr></thead><tbody></tbody></table></div>
    <div class="usage-pages"><label><input type="checkbox" class="cost-estimation"> 成本估算</label><label>每页 <select class="usage-size"><option value="20">20 条</option><option value="50">50 条</option><option value="100">100 条</option></select></label><button type="button" class="usage-prev" disabled>上一页</button><span class="usage-page">第 1 页</span><button type="button" class="usage-next" disabled>下一页</button></div></dialog>`;
  const toggle = root.querySelector('.toggle');
  const details = root.getElementById('quota-details');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  function paintCollapse() {
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? '展开额度详情' : '收起额度详情');
  }
  let collapseTimer = 0;
  function finishCollapse() {
    clearTimeout(collapseTimer); collapseTimer = 0;
    details.removeEventListener('transitionend', collapseEnd);
    details.style.transition = ''; details.style.height = ''; details.style.opacity = ''; details.style.overflow = '';
    details.hidden = collapsed;
  }
  const collapseEnd = e => { if (e.target === details && e.propertyName === 'height') finishCollapse(); };
  function paintCollapseAnimated() {
    paintCollapse();
    if (reduceMotion.matches) { finishCollapse(); return; }
    const from = details.hidden ? 0 : details.getBoundingClientRect().height;
    if (collapseTimer) { clearTimeout(collapseTimer); details.removeEventListener('transitionend', collapseEnd); }
    details.style.transition = ''; details.style.height = ''; details.style.opacity = '';
    details.hidden = false;
    const to = collapsed ? 0 : details.getBoundingClientRect().height;
    if (Math.abs(to - from) < 1) { finishCollapse(); return; }
    details.style.overflow = 'hidden';
    details.style.height = from + 'px';
    details.style.opacity = collapsed ? '1' : '0';
    void details.offsetHeight;
    details.style.transition = 'height .34s cubic-bezier(.22,.85,.3,1),opacity .28s ease';
    details.style.height = to + 'px';
    details.style.opacity = collapsed ? '0' : '1';
    details.addEventListener('transitionend', collapseEnd);
    collapseTimer = setTimeout(finishCollapse, 420);
  }
  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    try { localStorage.setItem(COLLAPSED_KEY, String(collapsed)); } catch {}
    paintCollapseAnimated();
    paint();
  });
  paintCollapse();
  details.hidden = collapsed;
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
    if (activityDeadline && Date.now()>activityDeadline) receiveActivity({id:activityId,error:'Token Activity 查询超时，请检查后台连接后重试。'});
    const disconnected = Date.now() - lastContact > 45_000;
    const beijingMinutes = Math.floor(Date.now() / 60_000 + 8 * 60) % 1440;
    const quiet = beijingMinutes >= 120 && beijingMinutes < 510;
    const stale = !!current?.error || disconnected || (!quiet && current?.receivedAt != null && Date.now() - current.receivedAt > 270_000);
    const card = root.querySelector('.card');
    card.classList.toggle('stale', stale);
    const g5 = current?.data?.five_hour, g7 = current?.data?.seven_day;
    card.classList.toggle('single-window', !!current?.data && !g5 && !!g7);
    const notes = [];
    if (g5) notes.push(`5h 剩 ${formatPercent(g5.remaining_percent)}`);
    if (g7) notes.push(`7d 剩 ${formatPercent(g7.remaining_percent)}`);
    toggle.title = (stale ? '更新失败，展开查看详情' : '点击' + (collapsed ? '展开' : '收起') + '额度详情')
      + (collapsed && notes.length ? ` · ${notes.join(' / ')}` : '');
    const button = root.querySelector('.refresh');
    const loading = !disconnected && (waitingForRefresh || !!current?.loading);
    button.disabled = loading;
    button.setAttribute('aria-busy', String(loading));
    const critical = remaining => remaining <= 10 ? '#e05a50' : remaining <= 30 ? '#d99a37' : 'var(--qaccent)';
    for (const key of ['five_hour', 'seven_day']) {
      const w = current?.data?.[key];
      const row = root.querySelector(`[data-window="${key}"]`);
      row.hidden = !!current?.data && !w;
      const track = row.querySelector('.track');
      const time = row.querySelector('time');
      const wstatsBox = row.querySelector('.wstats');
      if (!w) {
        row.querySelector('b').textContent = '—';
        row.title = '';
        time.textContent = row.querySelector('.countdown').textContent = '';
        time.removeAttribute('datetime');
        track.removeAttribute('aria-valuenow');
        track.removeAttribute('aria-valuetext');
        row.querySelector('.fill').style.width = '0%';
        wstatsBox.replaceChildren();
        wstatsBox.hidden = true;
        for (const gauge of root.querySelectorAll('[data-gauge="' + key + '"]')) gauge.style.strokeDashoffset = '100';
        continue;
      }
      const remaining = Math.max(0, Math.min(100, w.remaining_percent));
      row.querySelector('b').textContent = formatPercent(w.remaining_percent);
      row.querySelector('.fill').style.width = `${remaining}%`;
      row.querySelector('.fill').style.background = critical(remaining);
      for (const gauge of root.querySelectorAll(`[data-gauge="${key}"]`)) {
        gauge.style.strokeDashoffset = String(100 - remaining);
        gauge.style.stroke = critical(remaining);
      }
      track.setAttribute('aria-valuenow', String(remaining));
      track.setAttribute('aria-valuetext', `剩余 ${formatPercent(w.remaining_percent)}，已用 ${formatPercent(w.used_percent)}`);
      time.textContent = exactDate(w.resets_at);
      time.dateTime = w.resets_at;
      time.title = '北京时间';
      row.querySelector('.countdown').textContent = countdown(w.resets_at);
      const ws = w.window_stats && typeof w.window_stats === 'object' ? w.window_stats : null;
      const wsChips = [];
      if (ws) {
        if (Number.isFinite(ws.requests)) wsChips.push(ws.requests >= 1000 ? `${(ws.requests / 1e3).toLocaleString('en-US', { maximumFractionDigits: 1 })}K req` : `${ws.requests} req`);
        if (Number.isFinite(ws.tokens)) wsChips.push(Math.abs(ws.tokens) >= 999995 ? `${(ws.tokens / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 })}M` : Math.abs(ws.tokens) >= 1000 ? `${(ws.tokens / 1e3).toLocaleString('en-US', { maximumFractionDigits: 1 })}K` : String(ws.tokens));
        const acctCost = Number.isFinite(ws.cost) ? ws.cost : Number.isFinite(ws.standard_cost) ? ws.standard_cost : null;
        if (acctCost !== null) wsChips.push(`A $${acctCost.toFixed(2)}`);
        if (Number.isFinite(ws.user_cost)) wsChips.push(`U $${ws.user_cost.toFixed(2)}`);
        if (costEstimation && acctCost !== null && acctCost > 0 && Number.isFinite(w.used_percent) && w.used_percent > 0) {
          wsChips.push(`预计 $${(acctCost / (w.used_percent / 100)).toFixed(2)}`);
        }
      }
      wstatsBox.replaceChildren();
      for (const label of wsChips) {
        const span = document.createElement('span');
        span.textContent = label;
        wstatsBox.append(span);
      }
      wstatsBox.hidden = !wsChips.length;
      row.title = `已用 ${formatPercent(w.used_percent)} · 北京时间 ${formatDate(w.resets_at)} 重置` + (wsChips.length ? ` · ${wsChips.join(' / ')}` : '');
    }
    const info = current?.data?.reset_credits || {}, dates = (info.credits || []).map(c => c.expires_at).filter(Boolean).sort((a,b) => Date.parse(a)-Date.parse(b));
    const count = root.getElementById('reset-card-count'), expiry = root.getElementById('reset-card-expiry'), balance = current?.data?.credits?.balance == null ? NaN : Number(current.data.credits.balance);
    count.textContent = Number.isFinite(info.available_count) ? String(info.available_count) : '—';
    const shortDate = value => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone:'Asia/Shanghai', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(new Date(value)).map(x => [x.type, x.value])); return `${p.month}/${p.day} ${p.hour}:${p.minute}:${p.second}`; };
    expiry.textContent = dates[0] ? shortDate(dates[0]) : '暂无过期时间';
    expiry.title = dates.length ? `所有重置卡到期时间：\n${dates.map((value,index) => `${index + 1}. ${exactDate(value)}`).join('\n')}` : '';
    root.getElementById('credit-balance').textContent = current?.data?.credits?.unlimited ? '无限' : Number.isFinite(balance) ? balance.toFixed(3) : '—';
    const foot = root.getElementById('foot');
    const paused = quiet && !stale;
    const reason = disconnected ? '后台连接已断开' : current?.error || '额度数据尚未更新';
    foot.hidden = !stale && !paused && !loading;
    foot.textContent = stale ? reason + (current?.data ? ' · 显示上次数据' : ' · 请点击刷新重试')
      : loading ? '正在查询额度…' : paused ? '凌晨 2:00–8:30 已暂停自动刷新 · 可点击手动刷新' : '';
    foot.title = stale ? reason : '';
    foot.style.color = paused ? 'inherit' : '';
    foot.style.opacity = paused ? '.6' : '';
  }
  const dialog = root.querySelector('dialog');
  // Content swaps (skeleton, results, errors) change the auto height; glide between
  // the settled heights instead of jumping, then hand control back to max-height.
  // While a query is in flight the height is held so the taller skeleton never
  // stretches the dialog before the real rows shrink it back.
  let lastDialogH = 0, dialogAnimating = false, dialogHeld = false, dialogFinish = null;
  function holdDialog() {
    if (!dialog.open || reduceMotion.matches) return;
    dialogFinish?.();
    const h = dialog.getBoundingClientRect().height;
    dialogHeld = true;
    dialog.style.height = h + 'px';
    lastDialogH = h;
  }
  function releaseDialog() {
    // Wait for every in-flight query so the skeleton of a pending activity
    // request cannot stretch the dialog after the ranking already settled.
    if (!dialogHeld || usageDeadline || activityDeadline) return;
    dialogHeld = false;
    dialog.style.height = '';
  }
  const dialogRO = new ResizeObserver(() => {
    const h = dialog.getBoundingClientRect().height;
    if (!dialog.open) { lastDialogH = 0; return; }
    if (dialogAnimating || dialogHeld) return;
    if (!lastDialogH || reduceMotion.matches || Math.abs(h - lastDialogH) < 1) { lastDialogH = h; return; }
    const from = lastDialogH; lastDialogH = h; dialogAnimating = true;
    dialog.style.overflow = 'hidden';
    dialog.style.height = from + 'px';
    void dialog.offsetHeight;
    dialog.style.transition = 'height .34s cubic-bezier(.22,.85,.3,1)';
    dialog.style.height = h + 'px';
    const finish = () => {
      clearTimeout(timer); dialog.removeEventListener('transitionend', onEnd);
      dialog.style.transition = ''; dialog.style.height = ''; dialog.style.overflow = '';
      dialogAnimating = false; dialogFinish = null;
    };
    const onEnd = e => { if (e.target === dialog && e.propertyName === 'height') finish(); };
    const timer = setTimeout(finish, 420);
    dialogFinish = finish;
    dialog.addEventListener('transitionend', onEnd);
  });
  dialogRO.observe(dialog);
  const usageStatus = root.querySelector('.rank-status');
  const usageError = root.querySelector('.rank-error');
  const directNote = root.querySelector('.direct-note');
  const startInput = root.querySelector('.usage-start'), endInput = root.querySelector('.usage-end');
  function formatCoverage(startIso, endIso, isPartial) {
    if (!startIso || !endIso) return '';
    const parts = iso => {
      const d = new Date(iso);
      if (!Number.isFinite(d.getTime())) return null;
      return Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
    };
    const s = parts(startIso), e = parts(endIso);
    if (!s || !e) return '';
    const sameDay = s.month === e.month && s.day === e.day;
    const span = sameDay ? `${s.hour}:${s.minute}–${e.hour}:${e.minute}` : `${s.month}/${s.day} ${s.hour}:${s.minute}–${e.month}/${e.day} ${e.hour}:${e.minute}`;
    return (isPartial ? '仅覆盖 ' : '覆盖 ') + span;
  }
  function formatDirectBasis(est) {
    if (!est) return '';
    if (Number.isFinite(est.seven_day_cost_basis)) {
      const mode = est.calibration_mode === 'manual' ? '手动基准' : '自动校准';
      const step = Number.isFinite(est.step_cost) ? ` · 1% ≈ $${est.step_cost.toFixed(2)}` : '';
      return `100% 7天额度 ≈ $${est.seven_day_cost_basis.toFixed(2)}（${mode}）${step}`;
    }
    return '待校准换算基准';
  }
  function formatDirectSub(du) {
    if (!du) return '差值反推估算';
    const cov = formatCoverage(du.coverage_start, du.coverage_end, du.is_partial_coverage);
    if (du.status === 'collecting') return `${cov ? cov + ' · ' : ''}已采 ${du.sample_count || 1} 次 · 等待下次对比`;
    if (du.status === 'zero') {
      const bits = [];
      if (cov) bits.push(cov);
      bits.push('暂无明显直登');
      if (Number.isFinite(du.step_cost)) bits.push(`精度 ±$${du.step_cost.toFixed(2)}`);
      return bits.join(' · ');
    }
    const parts = ['按账号成本(A)反推'];
    if (cov) parts.push(cov);
    if (Number.isFinite(du.quota_percent) && du.quota_percent > 0) parts.push(`7天额度 ~${Number(du.quota_percent.toFixed(1))}%`);
    if (Number.isFinite(du.credits_delta) && du.credits_delta > 0) parts.push(`点数 -${du.credits_delta.toFixed(2)}`);
    if (du.calibration_mode === 'pending' && parts.length <= 2) parts.push('待校准换算基准');
    return parts.join(' · ');
  }
  function formatDirectNote(est) {
    if (!est || !est.status) return '';
    const basis = formatDirectBasis(est);
    const cov = formatCoverage(est.coverage_start, est.coverage_end, est.is_partial_coverage);
    const ref = est.window_ref;
    const refText = ref && Number.isFinite(ref.used_percent) && Number.isFinite(ref.sub2_cost)
      ? ` · 7天周期累计：已用 ${Number(ref.used_percent.toFixed(1))}%，Sub2API A $${ref.sub2_cost.toFixed(2)}` + (Number.isFinite(ref.sub2_user_cost) ? ` / U $${ref.sub2_user_cost.toFixed(2)}` : '') + (Number.isFinite(ref.min_full_cost) ? `（预计满额 $${ref.min_full_cost.toFixed(2)}）` : '')
      : '';
    if (est.status === 'ok') {
      const bits = ['账号直登按账号标准成本(A)差值反推'];
      if (cov) bits.push(cov);
      if (Number.isFinite(est.total_quota_percent) && est.total_quota_percent > 0) bits.push(`区间总额度 +${Number(est.total_quota_percent.toFixed(1))}%（直登约 ${Number((est.direct_quota_percent || 0).toFixed(1))}%）`);
      if (Number.isFinite(est.credits_delta) && est.credits_delta > 0) bits.push(`点数消耗 ${est.credits_delta.toFixed(2)}`);
      bits.push(`基准：${basis}`);
      return bits.join(' · ') + refText;
    }
    if (est.status === 'collecting') return `直登监测已启动（${cov ? cov + '，' : ''}已采 ${est.sample_count || 1} 次），等待下次快照对比 · 基准：${basis}${refText}`;
    if (est.status === 'zero') return `${cov ? cov + ' · ' : ''}区间总额度 +${Number((est.total_quota_percent || 0).toFixed(1))}%，暂无明显直登消耗（OpenAI 1% 步进误差${Number.isFinite(est.step_cost) ? '约 ±$' + est.step_cost.toFixed(2) : ''}）· 基准：${basis}${refText}`;
    if (est.status === 'pending_calibration') return `${cov ? cov + ' · ' : ''}区间总额度 +${Number((est.total_quota_percent || 0).toFixed(1))}%，待自动校准或配置基准后反推费用与 Token${refText}`;
    if (est.status === 'no_data') return `该日期范围暂无额度快照，账号直登按天统计自启用快照后开始累计${refText}`;
    return '';
  }
  function quickRange(days) {
    activityDay=null;paintDaySelection();
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year:'numeric',month:'2-digit',day:'2-digit' }).formatToParts(new Date()).map(p => [p.type,p.value]));
    endInput.value = `${parts.year}-${parts.month}-${parts.day}`;
    const start = new Date(endInput.value+'T00:00:00Z'); start.setUTCDate(start.getUTCDate()-days+1); startInput.value=start.toISOString().slice(0,10);
    root.querySelectorAll('[data-days]').forEach(b => { const active=Number(b.dataset.days)===days; b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active)); });
  }
  const costEstimationInput = root.querySelector('.cost-estimation');
  costEstimationInput.checked = costEstimation;
  function queryUsage(page=1, apply=false) {
    if(apply) {
      if(!startInput.value || !endInput.value || startInput.value>endInput.value) { usageError.hidden=false;usageError.textContent='开始日期不能晚于结束日期。';return; }
      usageRange={start_date:startInput.value,end_date:endInput.value};
    }
    usageRequest={id:++usageId,...usageRange,page,page_size:Number(root.querySelector('.usage-size').value),include_estimates:costEstimation};
    costEstimationInput.disabled = true;
    holdDialog();
    dispatch({kind:'usage',...usageRequest});
    usageDeadline=Date.now()+30000;
    usageError.hidden=true;usageStatus.hidden=false;usageStatus.textContent='正在查询…';directNote.hidden=true;directNote.textContent='';rankLoading();
    root.querySelector('.usage-prev').disabled=true;root.querySelector('.usage-next').disabled=true;
  }
  function receiveUsage(result) {
    if(result.id!==usageId || !dialog.open)return;
    usageDeadline=0;
    costEstimationInput.disabled = false;
    releaseDialog();
    if(result.error) {usageStatus.hidden=false;usageStatus.textContent='查询失败，请点击查询重试。';usageError.textContent=result.error;usageError.hidden=false;directNote.hidden=true;directNote.textContent='';root.querySelector('tbody').replaceChildren();return;}
    const data=result.data;usagePage=data.page;
    root.querySelector('tbody').replaceChildren();
    for(const user of data.users) {
      const isEst=user.is_estimated===true;
      const row=document.createElement('tr');
      if(isEst){
        row.className='estimated-row';
        const du=user.direct_usage;
        if(du){
          const tipParts=['差值反推估算（总消耗 − Sub2API 消耗）'];
          if(Number.isFinite(du.total_quota_percent))tipParts.push(`区间 7天额度总增量 +${Number(du.total_quota_percent.toFixed(1))}%`);
          if(Number.isFinite(du.quota_percent))tipParts.push(`直登约占 ${Number(du.quota_percent.toFixed(1))}%`);
          if(Number.isFinite(du.total_account_cost))tipParts.push(`账号估算总费用 $${du.total_account_cost.toFixed(3)}`);
          if(Number.isFinite(du.sub2_cost))tipParts.push(`同期 Sub2API 费用 $${du.sub2_cost.toFixed(3)}`);
          tipParts.push(`换算基准：${formatDirectBasis(du)}`);
          row.title=tipParts.join(' · ');
        }
      }
      const prompt=user.input_tokens+user.cache_tokens;
      user.cache_hit_rate=Number.isFinite(user.input_tokens)&&Number.isFinite(user.cache_tokens)&&prompt>0?user.cache_tokens/prompt*100:null;
      for(const key of ['email','requests','input_tokens','output_tokens','cache_tokens','cache_hit_rate','total_tokens','actual_cost']) {
        const cell=document.createElement('td'),n=user[key];
        if(key==='email'){
          cell.textContent=n || (isEst ? '账号直登（估算）' : `用户 ${user.user_id}`);
          if(isEst){ const sub=document.createElement('small'); sub.textContent=formatDirectSub(user.direct_usage); cell.append(sub); }
        }
        else if(!Number.isFinite(n))cell.textContent='—';
        else {
          const prefix=isEst&&(key==='total_tokens'||key==='actual_cost')?'~':'';
          cell.title=(isEst?'估算值：':'')+String(n);
          cell.textContent=prefix+(key==='actual_cost'?'$'+n.toFixed(3):key==='cache_hit_rate'?n.toFixed(1)+'%':key.endsWith('tokens')?(Math.abs(n)>=999995?(n/1e6).toLocaleString('en-US',{maximumFractionDigits:2})+' M':Math.abs(n)>=1000?(n/1e3).toLocaleString('en-US',{maximumFractionDigits:2})+' K':n.toLocaleString('en-US')):n.toLocaleString('en-US'));
        }
        if(key==='total_tokens')cell.className='strong';
        row.append(cell);
      }
      root.querySelector('tbody').append(row);
    }
    const noteText=formatDirectNote(data.direct_estimate);
    directNote.textContent=noteText;directNote.hidden=!noteText;
    usageStatus.hidden=data.users.length>0;usageStatus.textContent=data.users.length?'':'暂无用量记录';
    root.querySelector('.usage-page').textContent=`第 ${usagePage} 页`;
    root.querySelector('.usage-prev').disabled=usagePage<=1;root.querySelector('.usage-next').disabled=!data.has_more;
  }
  const activitySelect=root.querySelector('.activity-user'),activityStatus=root.querySelector('.activity-status'),activityError=root.querySelector('.activity-error'),hmGrid=root.querySelector('.hm-grid'),hmMonths=root.querySelector('.hm-months'),hmTip=root.querySelector('.hm-tip'),hmWrap=root.querySelector('.hm-wrap'),hmScroll=root.querySelector('.hm-scroll'),hmSummary=root.querySelector('.hm-summary');
  const WEEKDAYS=['周日','周一','周二','周三','周四','周五','周六'];
  const fmtTokens=n=>Math.abs(n)>=999995?(n/1e6).toLocaleString('en-US',{maximumFractionDigits:2})+' M':Math.abs(n)>=1000?(n/1e3).toLocaleString('en-US',{maximumFractionDigits:2})+' K':n.toLocaleString('en-US');
  const fmtCost=n=>'$'+n.toFixed(3);
  function rankLoading() {
    const frag=document.createDocumentFragment();
    for(let i=0;i<6;i++){
      const tr=document.createElement('tr');tr.className='skel-row';
      for(let c=0;c<8;c++){
        const td=document.createElement('td'),bar=document.createElement('span');
        bar.className='skel-bar';bar.style.width=c===0?'72%':'80%';bar.style.animationDelay=(i*.07+c*.03).toFixed(2)+'s';
        td.append(bar);tr.append(td);
      }
      frag.append(tr);
    }
    root.querySelector('tbody').replaceChildren(frag);
  }
  function activityLoading() {
    activityBusy=true;
    const frag=document.createDocumentFragment();
    for(let col=0;col<53;col++)for(let row=0;row<7;row++){
      const cell=document.createElement('div');cell.className='hm-cell skel';cell.style.animationDelay=(col*.035+row*.02).toFixed(3)+'s';frag.append(cell);
    }
    hmGrid.replaceChildren(frag);hmGrid.setAttribute('aria-busy','true');
    hmMonths.replaceChildren();hmTip.hidden=true;
    const bar=document.createElement('span');bar.className='skel-bar';hmSummary.replaceChildren(bar);
  }
  function queryActivity() {
    activityRequest={id:++activityId,user:activityUser||null};
    holdDialog();
    dispatch({kind:'activity',...activityRequest});
    activityDeadline=Date.now()+30000;
    activityError.hidden=true;activityStatus.hidden=false;activityStatus.textContent='正在加载近 365 天用量…';
    activityLoading();
  }
  function receiveActivity(result) {
    if(result.id!==activityId || !dialog.open)return;
    activityDeadline=0;
    releaseDialog();
    if(result.error){activityBusy=false;activityStatus.hidden=false;activityStatus.textContent='加载失败，请重新打开重试。';activityError.textContent=result.error;activityError.hidden=false;hmGrid.replaceChildren();hmGrid.setAttribute('aria-busy','false');hmMonths.replaceChildren();hmSummary.replaceChildren();hmTip.hidden=true;return;}
    activityError.hidden=true;activityBusy=false;
    activityData=result.data;
    activitySelect.replaceChildren(new Option('全部用户',''));
    for(const user of activityData.users)activitySelect.append(new Option(user.username?`${user.username} · ${user.email}`:user.email,user.email));
    activitySelect.value=activityUser;
    if(activitySelect.value!==activityUser){activityUser='';activitySelect.value='';}
    renderActivity();
    activityStatus.hidden=true;activityStatus.textContent='';
  }
  function renderActivity() {
    if(!activityData||activityBusy)return;
    hmGrid.setAttribute('aria-busy','false');
    const map=new Map(activityData.trend.map(row=>[row.date,row]));
    const start=new Date(activityData.start_date+'T00:00:00Z'),end=new Date(activityData.end_date+'T00:00:00Z');
    const days=Math.round((end-start)/864e5)+1,lead=start.getUTCDay(),cols=Math.ceil((lead+days)/7);
    const value=row=>activityMetric==='cost'?(row?.actual_cost??0):(row?.total_tokens??0);
    const cells=[],nonzero=[];let totalTokens=0,totalCost=0,active=0;
    for(let i=0;i<days;i++){
      const date=new Date(start.getTime()+i*864e5).toISOString().slice(0,10),row=map.get(date),v=value(row);
      if(v>0){nonzero.push(v);active++;}
      totalTokens+=row?.total_tokens||0;totalCost+=row?.actual_cost||0;
      cells.push({date,row,v});
    }
    nonzero.sort((a,b)=>a-b);
    const q=p=>nonzero.length?nonzero[Math.min(nonzero.length-1,Math.floor(p*(nonzero.length-1)))]:0;
    const t1=q(.25),t2=q(.5),t3=q(.75);
    const level=v=>v<=0?0:v<=t1?1:v<=t2?2:v<=t3?3:4;
    const frag=document.createDocumentFragment();
    for(let slot=0;slot<cols*7;slot++){
      const index=slot-lead,cell=document.createElement('div');cell.className='hm-cell';
      if(index<0||index>=days)cell.classList.add('pad');
      else{
        const entry=cells[index];
        cell.dataset.level=String(level(entry.v));cell.dataset.date=entry.date;
        cell.setAttribute('aria-label',`${entry.date}：${fmtTokens(entry.row?.total_tokens??0)} Token，${fmtCost(entry.row?.actual_cost??0)}`);
      }
      frag.append(cell);
    }
    hmGrid.replaceChildren(frag);
    hmMonths.replaceChildren();hmMonths.style.gridTemplateColumns=`repeat(${cols},12px)`;
    let lastMonth=-1;
    for(let col=0;col<cols;col++){
      const index=Math.max(0,col*7-lead),d=new Date(start.getTime()+index*864e5),month=d.getUTCMonth();
      if(month!==lastMonth){
        lastMonth=month;
        const span=document.createElement('span');span.textContent=d.toLocaleDateString('en-US',{month:'short',timeZone:'UTC'});span.style.gridColumn=String(col+1);hmMonths.append(span);
      }
    }
    hmSummary.textContent=`近 ${days} 天 · Token ${fmtTokens(totalTokens)} · ${fmtCost(totalCost)} · 活跃 ${active} 天`;
    hmGrid.setAttribute('aria-label',`近 ${days} 天${activityMetric==='cost'?'费用':' Token'} 活跃热力图，活跃 ${active} 天`);
    paintDaySelection();
    hmTip.hidden=true;
  }
  function paintDaySelection() {
    hmGrid.querySelectorAll('.hm-cell[data-date]').forEach(cell=>cell.classList.toggle('selected',cell.dataset.date===activityDay));
  }
  // tooltip 会被最近的滚动祖先（弹窗 dialog）裁剪，翻转与夹紧都要以它的可视区为准，而不是视口。
  function tipBounds() {
    let top=8,bottom=window.innerHeight;
    for(let node=hmTip.parentElement;node;node=node.parentElement){
      const style=getComputedStyle(node);
      if(style.overflowY==='visible')continue;
      const rect=node.getBoundingClientRect();
      top=Math.max(top,rect.top+1);bottom=Math.min(bottom,rect.bottom-1);break;
    }
    return {top,bottom};
  }
  function showActivityTip(cell) {
    const row=activityData?.trend.find(entry=>entry.date===cell.dataset.date);
    const d=new Date(cell.dataset.date+'T00:00:00Z');
    const lines=[
      `${cell.dataset.date} · ${WEEKDAYS[d.getUTCDay()]}`,
      `Token ${fmtTokens(row?.total_tokens??0)}`,
      `费用 ${fmtCost(row?.actual_cost??0)}`,
      `请求 ${(row?.requests??0).toLocaleString('en-US')}`,
      `输入 ${fmtTokens(row?.input_tokens??0)} · 输出 ${fmtTokens(row?.output_tokens??0)}`,
      `缓存 ${fmtTokens((row?.cache_read_tokens??0)+(row?.cache_creation_tokens??0))}`,
      '点击定位当日排行',
    ];
    hmTip.replaceChildren();
    lines.forEach((text,index)=>{
      const line=document.createElement(index?'span':'b');
      line.textContent=text;
      if(index===1||index===2)line.className='hi';
      hmTip.append(line);
      if(index)hmTip.append(document.createElement('br'));
    });
    hmTip.hidden=false;
    const wrapRect=hmWrap.getBoundingClientRect(),cellRect=cell.getBoundingClientRect(),tipRect=hmTip.getBoundingClientRect();
    let left=cellRect.left-wrapRect.left+cellRect.width/2-tipRect.width/2;
    left=Math.max(0,Math.min(left,wrapRect.width-tipRect.width));
    const bounds=tipBounds();
    const above=cellRect.top-bounds.top,below=bounds.bottom-cellRect.bottom;
    const cellTop=above<tipRect.height+8&&below>above?cellRect.bottom+8:cellRect.top-tipRect.height-8;
    let top=cellTop-wrapRect.top;
    top=Math.max(bounds.top+4-wrapRect.top,Math.min(top,bounds.bottom-4-wrapRect.top-tipRect.height));
    hmTip.style.left=left+'px';hmTip.style.top=top+'px';
  }
  hmGrid.addEventListener('pointerover',e=>{const cell=e.target.closest('.hm-cell[data-date]');if(cell)showActivityTip(cell);});
  hmGrid.addEventListener('pointerout',e=>{if(e.target.closest('.hm-cell[data-date]'))hmTip.hidden=true;});
  hmGrid.addEventListener('click',e=>{
    const cell=e.target.closest('.hm-cell[data-date]');
    if(!cell)return;
    activityDay=cell.dataset.date;
    paintDaySelection();
    startInput.value=endInput.value=activityDay;
    root.querySelectorAll('[data-days]').forEach(b=>{b.classList.remove('active');b.setAttribute('aria-pressed','false');});
    queryUsage(1,true);
    const filters=root.querySelector('.usage-filters');
    dialog.scrollTo({top:Math.max(0,filters.offsetTop-14),behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  });
  hmScroll.addEventListener('scroll',()=>{hmTip.hidden=true;});
  activitySelect.addEventListener('change',()=>{activityUser=activitySelect.value;queryActivity();});
  root.querySelectorAll('[data-metric]').forEach(button=>button.addEventListener('click',()=>{
    activityMetric=button.dataset.metric;
    root.querySelectorAll('[data-metric]').forEach(b=>{const active=b===button;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
    renderActivity();
  }));
  let dialogClosing = 0;
  function closeDialog() {
    if (!dialog.open || dialogClosing) return;
    if (reduceMotion.matches) { dialog.close(); return; }
    dialog.classList.add('closing');
    const done = () => {
      clearTimeout(dialogClosing); dialogClosing = 0;
      dialog.removeEventListener('animationend', onEnd);
      dialog.classList.remove('closing');
      dialog.close();
    };
    const onEnd = e => { if (e.target === dialog && e.animationName === 'dlg-out') done(); };
    dialog.addEventListener('animationend', onEnd);
    dialogClosing = setTimeout(done, 260);
  }
  function openDialog() {
    if (dialogClosing) { clearTimeout(dialogClosing); dialogClosing = 0; dialog.classList.remove('closing'); }
    if (!dialog.open) dialog.showModal();
    quickRange(1); queryUsage(1, true); queryActivity();
  }
  root.querySelector('.usage-link').addEventListener('click', openDialog);
  root.querySelector('.usage-close').addEventListener('click', closeDialog);
  dialog.addEventListener('cancel', e => { e.preventDefault(); closeDialog(); });
  dialog.addEventListener('close',()=>{usageId++;usageRequest=null;usageDeadline=0;activityId++;activityRequest=null;activityDeadline=0;activityDay=null;hmTip.hidden=true;dialogFinish?.();releaseDialog();dialog.classList.remove('closing');clearTimeout(dialogClosing);dialogClosing=0;});
  dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeDialog();}});
  root.querySelector('.usage-filters').addEventListener('submit',e=>{e.preventDefault();queryUsage(1,true);});
  root.querySelectorAll('[data-days]').forEach(b=>b.addEventListener('click',()=>{quickRange(Number(b.dataset.days));queryUsage(1,true);}));
  for(const input of [startInput,endInput]) input.addEventListener('input',()=>{activityDay=null;paintDaySelection();root.querySelectorAll('[data-days]').forEach(b=>{b.classList.remove('active');b.setAttribute('aria-pressed','false');});});
  costEstimationInput.addEventListener('change', () => {
    costEstimation = costEstimationInput.checked;
    try { localStorage.setItem(COST_ESTIMATION_KEY, String(costEstimation)); } catch {}
    queryUsage(1);
    paint();
  });
  root.querySelector('.usage-size').addEventListener('change',()=>queryUsage(1));
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
    // Float over the column instead of taking a flex row: pin the card to the
    // bottom of a positioned ancestor so the chat scroller keeps full height.
    if (getComputedStyle(target).position === 'static') {
      if (positioned && positioned !== target) positioned.style.position = '';
      target.style.position = 'relative';
      positioned = target;
    }
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
    refreshRequested = ++refreshId;
    dispatch({kind:'refresh',id:refreshRequested});
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
    version,
    update(value, opts) {
      if (opts) setTheme(opts.theme);
      // An immediate push and the periodic tick can race; never regress to older data.
      if (value?.receivedAt && current?.receivedAt && value.receivedAt < current.receivedAt) return status();
      current = value; lastContact = Date.now(); waitingForRefresh = false; mount(); paint(); return status();
    }, status,
    receiveUsage,
    takeUsageRequest() {const request=usageRequest;usageRequest=null;return request;},
    receiveActivity,
    takeActivityRequest() {const request=activityRequest;activityRequest=null;return request;},
    takeRefreshRequest() { const requested = refreshRequested; refreshRequested = false; return requested; },
    dispose() { disposed = true; colorScheme.removeEventListener('change', applyScheme); observer.disconnect(); dialogRO.disconnect(); clearTimeout(collapseTimer); clearInterval(timer); dialog.close(); host.remove(); if (positioned) positioned.style.position = ''; delete window[KEY]; },
  };
  mount(); paint();
  return status();
}
