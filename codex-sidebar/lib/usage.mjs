export const ENDPOINT = 'https://gateway.zhengru.top/api/quota/api/usage';

export function validateUsage(data) {
  if (!data || typeof data !== 'object') throw new Error('额度响应不是对象');
  for (const key of ['five_hour', 'seven_day']) {
    const w = data[key];
    if (!w || ['used_percent', 'remaining_percent'].some(k =>
      typeof w[k] !== 'number' || !Number.isFinite(w[k]) || w[k] < 0) ||
      typeof w.resets_at !== 'string' || !Number.isFinite(Date.parse(w.resets_at))) {
      throw new Error(`额度响应字段无效：${key}`);
    }
  }
  // Only transfer fields the widget actually needs into the renderer.
  return {
    five_hour: pickWindow(data.five_hour), seven_day: pickWindow(data.seven_day),
    fetched_at: Number.isFinite(Date.parse(data.cache?.fetched_at)) ? data.cache.fetched_at : null,
  };
}

function pickWindow(w) {
  return { used_percent: w.used_percent, remaining_percent: w.remaining_percent, resets_at: w.resets_at };
}

export async function fetchUsage({ fetcher = fetch } = {}) {
  const response = await fetcher(ENDPOINT, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`额度接口 HTTP ${response.status}`);
  return validateUsage(await response.json());
}

export class UsagePoller {
  constructor({ fetcher = fetchUsage, interval = 120_000, now = Date.now } = {}) {
    this.fetcher = fetcher;
    this.interval = interval;
    this.now = now;
    this.next = 0;
    this.pending = null;
    this.snapshot = { data: null, error: null, receivedAt: null, loading: false };
  }
  async refresh({ force = false } = {}) {
    if (this.pending) return this.pending;
    if (!force && this.now() < this.next) return this.snapshot;
    this.next = this.now() + this.interval;
    this.snapshot = { ...this.snapshot, loading: true };
    this.pending = (async () => {
      try {
        const data = await this.fetcher();
        this.snapshot = { data, error: null, receivedAt: this.now(), loading: false };
      } catch (error) {
        this.snapshot = { ...this.snapshot, error: error.message || '额度查询失败', loading: false };
      } finally {
        this.pending = null;
      }
      return this.snapshot;
    })();
    return this.pending;
  }
}
