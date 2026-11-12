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
    reset_cards: { available_count: Number.isFinite(data.reset_cards?.available_count) ? data.reset_cards.available_count : 0,
      expires_at: Array.isArray(data.reset_cards?.expires_at) ? data.reset_cards.expires_at.filter(x => typeof x === 'string') : [] },
    credits: { unlimited: data.credits?.unlimited === true, balance: data.credits?.balance ?? null },
    fetched_at: Number.isFinite(Date.parse(data.cache?.fetched_at)) ? data.cache.fetched_at : null,
  };
}

export const REFRESH_ENDPOINT = 'https://gateway.zhengru.top/api/quota/api/quota-refresh';

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

// Fetch in the daemon, keeping renderer networking independent of app CSP/CORS.
export async function fetchUserBreakdown(query, { fetcher = fetch } = {}) {
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
  if (!query || !validDate(query.start_date) || !validDate(query.end_date) || query.start_date > query.end_date ||
      !Number.isInteger(query.page) || query.page < 1 || query.page > 10000 || ![20,50,100].includes(query.page_size)) {
    throw new Error('用量查询参数无效');
  }
  const url = new URL('./user-breakdown', ENDPOINT);
  for (const key of ['start_date','end_date','page','page_size']) url.searchParams.set(key, query[key]);
  const response = await fetcher(url.toString(), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000), redirect:'error' });
  if (!response.ok) {
    let detail;
    try { detail = (await response.json()).detail; } catch {}
    throw new Error(typeof detail === 'string' ? detail : `用量接口 HTTP ${response.status}，请确认服务器已更新用量统计接口`);
  }
  const data = await response.json();
  if (!data || !Array.isArray(data.users) || data.users.length > query.page_size ||
      data.users.some(user => !user || typeof user !== 'object' || Array.isArray(user)) ||
      data.page !== query.page || data.page_size !== query.page_size || typeof data.has_more !== 'boolean' ||
      data.start_date !== query.start_date || data.end_date !== query.end_date || typeof data.timezone !== 'string') {
    throw new Error('用量接口返回数据无效');
  }
  return { start_date: data.start_date, end_date: data.end_date, page:data.page, page_size:data.page_size,
    timezone:data.timezone, has_more:data.has_more, users:data.users.map(user => Object.fromEntries(
      ['user_id','email','requests','input_tokens','output_tokens','cache_tokens','total_tokens','cost']
        .map(key => [key, key === 'email' ? (typeof user[key] === 'string' ? user[key] : '') : (Number.isFinite(user[key]) ? user[key] : null)]))) };
}
