export const ENDPOINT = 'https://gateway.zhengru.top/api/quota/api/usage';

export function validateUsage(data) {
  if (!data || typeof data !== 'object') throw new Error('额度响应不是对象');
  const windows = {};
  for (const key of ['five_hour', 'seven_day']) {
    const w = data[key];
    // Pro 账号没有 5 小时窗口，服务端以 null 表示该窗口不存在。
    if (w == null) { windows[key] = null; continue; }
    if (typeof w !== 'object' || ['used_percent', 'remaining_percent'].some(k =>
      typeof w[k] !== 'number' || !Number.isFinite(w[k]) || w[k] < 0) ||
      typeof w.resets_at !== 'string' || !Number.isFinite(Date.parse(w.resets_at))) {
      throw new Error(`额度响应字段无效：${key}`);
    }
    windows[key] = pickWindow(w);
  }
  if (!windows.five_hour && !windows.seven_day) {
    const balance = data.credits?.balance;
    const hasBalance = (typeof balance === 'number' || (typeof balance === 'string' && balance.trim() !== '')) && Number.isFinite(Number(balance));
    const creditsOnly = data.five_hour === null && data.seven_day === null && (hasBalance || data.credits?.unlimited === true);
    if (!creditsOnly) throw new Error('额度响应缺少有效额度窗口');
  }
  // Only transfer fields the widget actually needs into the renderer.
  return {
    cost_estimation_enabled: data.cost_estimation_enabled === true,
    five_hour: windows.five_hour, seven_day: windows.seven_day,
    reset_credits: validateResetCredits(data.reset_credits),
    credits: { unlimited: data.credits?.unlimited === true,
      balance: data.credits?.balance ?? null },
    fetched_at: Number.isFinite(Date.parse(data.cache?.fetched_at)) ? data.cache.fetched_at : null,
  };
}

export function validateResetCredits(info) {
  if (info == null) return null; // Older servers still provide quota windows.
  const invalid = () => ({ available_count: null, credits: [], error: '重置卡响应数据无效' });
  if (typeof info !== 'object' || Array.isArray(info)) return invalid();
  if (typeof info.error === 'string' && info.error) return { available_count: null, credits: [], error: info.error };
  if (!Number.isInteger(info.available_count) || info.available_count < 0 || !Array.isArray(info.credits)) return invalid();
  const credits = [];
  for (const credit of info.credits) {
    if (!credit || typeof credit !== 'object' || !Number.isInteger(credit.resets_left) || credit.resets_left <= 0 ||
        (credit.expires_at != null && (typeof credit.expires_at !== 'string' || !Number.isFinite(Date.parse(credit.expires_at))))) return invalid();
    credits.push({ label: typeof credit.label === 'string' ? credit.label : '重置卡', resets_left: credit.resets_left, expires_at: credit.expires_at ?? null });
  }
  return { available_count: info.available_count, credits, error: null };
}

function sanitizeWindowStats(ws) {
  if (!ws || typeof ws !== 'object' || Array.isArray(ws)) return null;
  const num = k => (typeof ws[k] === 'number' && Number.isFinite(ws[k]) && ws[k] >= 0 ? ws[k] : null);
  const requests = num('requests'), tokens = num('tokens');
  const cost = num('cost'), standard_cost = num('standard_cost'), user_cost = num('user_cost');
  if (requests === null && tokens === null && cost === null && standard_cost === null && user_cost === null) return null;
  return { requests, tokens, cost, standard_cost, user_cost };
}

function pickWindow(w) {
  const out = { used_percent: w.used_percent, remaining_percent: w.remaining_percent, resets_at: w.resets_at };
  const ws = sanitizeWindowStats(w.window_stats);
  if (ws) out.window_stats = ws;
  return out;
}

export async function fetchUsage({ fetcher = fetch } = {}) {
  const response = await fetcher(ENDPOINT, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`额度接口 HTTP ${response.status}`);
  return validateUsage(await response.json());
}

// 北京时间 02:00–08:30 暂停自动刷新，仅手动刷新可请求上游。
export function isQuietHours(timestamp) {
  const minutes = Math.floor(timestamp / 60_000 + 8 * 60) % 1440;
  return minutes >= 120 && minutes < 510;
}

export class UsagePoller {
  constructor({ fetcher = fetchUsage, interval = 120_000, now = Date.now, quietHours = isQuietHours } = {}) {
    this.fetcher = fetcher;
    this.interval = interval;
    this.now = now;
    this.quietHours = quietHours;
    this.next = 0;
    this.pending = null;
    this.snapshot = { data: null, error: null, receivedAt: null, loading: false };
  }
  async refresh({ force = false } = {}) {
    if (this.pending) return this.pending;
    if (!force && (this.now() < this.next || this.quietHours(this.now()))) return this.snapshot;
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
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const TREND_FIELDS = ['requests','input_tokens','output_tokens','cache_creation_tokens','cache_read_tokens','total_tokens','cost','actual_cost'];

function sanitizeIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function sanitizeDirectUsage(info) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  const num = k => (Number.isFinite(info[k]) ? info[k] : null);
  const mode = ['manual', 'auto', 'pending'].includes(info.calibration_mode) ? info.calibration_mode : null;
  const status = ['ok', 'zero', 'pending_calibration', 'collecting'].includes(info.status) ? info.status : null;
  return {
    status,
    quota_percent: num('quota_percent'),
    total_quota_percent: num('total_quota_percent'),
    credits_delta: num('credits_delta'),
    sub2_cost: num('sub2_cost'),
    total_account_cost: num('total_account_cost'),
    seven_day_cost_basis: num('seven_day_cost_basis'),
    step_cost: num('step_cost'),
    calibration_mode: mode,
    sample_count: num('sample_count'),
    coverage_start: sanitizeIso(info.coverage_start),
    coverage_end: sanitizeIso(info.coverage_end),
    is_partial_coverage: info.is_partial_coverage === true,
  };
}

function sanitizeDirectEstimate(info) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  const status = ['ok', 'zero', 'pending_calibration', 'collecting', 'no_data'].includes(info.status) ? info.status : null;
  if (!status) return null;
  const num = k => (Number.isFinite(info[k]) ? info[k] : null);
  const mode = ['manual', 'auto', 'pending'].includes(info.calibration_mode) ? info.calibration_mode : null;
  const ref = info.window_ref && typeof info.window_ref === 'object' && !Array.isArray(info.window_ref) ? {
    used_percent: Number.isFinite(info.window_ref.used_percent) ? info.window_ref.used_percent : null,
    sub2_cost: Number.isFinite(info.window_ref.sub2_cost) ? info.window_ref.sub2_cost : null,
    sub2_user_cost: Number.isFinite(info.window_ref.sub2_user_cost) ? info.window_ref.sub2_user_cost : null,
    sub2_tokens: Number.isFinite(info.window_ref.sub2_tokens) ? info.window_ref.sub2_tokens : null,
    sub2_requests: Number.isFinite(info.window_ref.sub2_requests) ? info.window_ref.sub2_requests : null,
    min_full_cost: Number.isFinite(info.window_ref.min_full_cost) ? info.window_ref.min_full_cost : null,
    direct_cost: Number.isFinite(info.window_ref.direct_cost) ? info.window_ref.direct_cost : null,
  } : null;
  return {
    status,
    calibration_mode: mode,
    seven_day_cost_basis: num('seven_day_cost_basis'),
    step_cost: num('step_cost'),
    total_quota_percent: num('total_quota_percent'),
    direct_quota_percent: num('direct_quota_percent'),
    credits_delta: num('credits_delta'),
    direct_cost: num('direct_cost'),
    direct_tokens: num('direct_tokens'),
    sample_count: num('sample_count'),
    coverage_start: sanitizeIso(info.coverage_start),
    coverage_end: sanitizeIso(info.coverage_end),
    is_partial_coverage: info.is_partial_coverage === true,
    window_ref: ref,
  };
}

export async function fetchUserBreakdown(query, { fetcher = fetch } = {}) {
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
  return {
    start_date: data.start_date, end_date: data.end_date, page: data.page, page_size: data.page_size,
    timezone: data.timezone, has_more: data.has_more,
    direct_estimate: sanitizeDirectEstimate(data.direct_estimate),
    users: data.users.map(user => {
      const clean = Object.fromEntries(
        ['user_id','email','requests','input_tokens','output_tokens','cache_tokens','total_tokens','cost','actual_cost']
          .map(key => [key, key === 'email' ? (typeof user[key] === 'string' ? user[key] : '') : (Number.isFinite(user[key]) ? user[key] : null)])
      );
      if (user.is_estimated === true) {
        clean.is_estimated = true;
        clean.direct_usage = sanitizeDirectUsage(user.direct_usage);
      }
      return clean;
    }),
  };
}

export async function fetchTokenActivity(query, { fetcher = fetch } = {}) {
  if (!query || (query.user != null && (typeof query.user !== 'string' || !query.user || query.user.length > 254))) {
    throw new Error('Token Activity 查询参数无效');
  }
  const url = new URL('./token-activity', ENDPOINT);
  if (query.user) url.searchParams.set('user', query.user);
  const response = await fetcher(url.toString(), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000), redirect:'error' });
  if (!response.ok) {
    let detail;
    try { detail = (await response.json()).detail; } catch {}
    throw new Error(typeof detail === 'string' ? detail : `Token Activity 接口 HTTP ${response.status}，请确认服务器已更新用量统计接口`);
  }
  const data = await response.json();
  if (!data || !validDate(data.start_date) || !validDate(data.end_date) ||
      Math.round((Date.parse(data.end_date) - Date.parse(data.start_date)) / 86400000) !== 364 ||
      typeof data.timezone !== 'string' || (data.user != null && typeof data.user !== 'string') ||
      !Array.isArray(data.users) || data.users.length > 5000 ||
      data.users.some(user => !user || typeof user.email !== 'string' || !user.email || typeof user.username !== 'string') ||
      !Array.isArray(data.trend) || data.trend.length > 365 ||
      data.trend.some(row => !row || !validDate(row.date) || row.date < data.start_date || row.date > data.end_date ||
        TREND_FIELDS.some(key => !Number.isFinite(row[key]) || row[key] < 0))) {
    throw new Error('Token Activity 接口返回数据无效');
  }
  return { start_date: data.start_date, end_date: data.end_date, timezone: data.timezone,
    user: data.user || null,
    users: data.users.map(user => ({ email: user.email, username: user.username })),
    trend: data.trend.map(row => Object.fromEntries(['date', ...TREND_FIELDS].map(key => [key, row[key]]))) };
}
