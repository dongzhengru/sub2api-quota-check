// Built-in WebSocket (Node >= 22); no dependency download or page-side network.
import http from 'node:http';
export class CDP {
  constructor(ws, timeout = 5000) {
    this.ws = ws;
    this.timeout = timeout;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    ws.addEventListener('message', event => {
      let response;
      try { response = JSON.parse(event.data); } catch { return; }
      const p = this.pending.get(response.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(response.id);
      if (response.error) p.reject(new Error(response.error.message));
      else p.resolve(response.result);
    });
    ws.addEventListener('close', () => this.rejectPending());
    ws.addEventListener('error', () => this.rejectPending());
  }
  static async connect(url, { port, timeout = 5000 } = {}) {
    assertLocalSocket(url, port);
    const ws = new WebSocket(url);
    const client = new CDP(ws, timeout);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('CDP 连接超时')); }, timeout);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); }, { once: true });
    });
    return client;
  }
  rejectPending() {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('CDP 连接已断开'));
    }
    this.pending.clear();
  }
  call(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已断开'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async evaluate(expression) {
    const value = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.text || '页面执行失败');
    return value.result?.value;
  }
  close() { this.rejectPending(); this.ws.close(); }
}

export function assertLocalSocket(value, port) {
  const url = new URL(value);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' ||
      (port && Number(url.port) !== Number(port)) || !url.pathname.startsWith('/devtools/') || url.username || url.password) {
    throw new Error('拒绝连接非预期的本机 CDP 地址');
  }
}

export function isAppTarget(target) {
  if (target.type !== 'page' || !target.webSocketDebuggerUrl) return false;
  try {
    const url = new URL(target.url);
    // Exclude embedded browsers, auth pages, sandbox tools and extension targets.
    return url.protocol === 'app:' && ['-', 'codex', 'localhost'].includes(url.hostname) &&
      !/\/browser(?:\/|$)|\/sandbox(?:\/|$)/.test(url.pathname);
  } catch { return false; }
}

export function listTargets(port) {
  // Loopback CDP probing deliberately avoids global fetch: one reset connection
  // can leave undici's shared pool wedged for the rest of the process's life,
  // while the DevTools endpoint only resets connections intermittently.
  // A fresh, unpooled http request per call retries cleanly instead.
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/json/list`, { agent: false }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('无法读取 CDP 页面列表')); return; }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (!Array.isArray(result)) throw new Error('CDP 页面列表无效');
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(2500, () => request.destroy(new Error('CDP 列表请求超时')));
    request.on('error', reject);
  });
}
