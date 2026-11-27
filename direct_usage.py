import math
import sqlite3
from datetime import date, datetime, time as dt_time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

DIRECT_USER_ID = 0
DIRECT_USER_LABEL = '账号直登（估算）'
MAX_INTERVAL_SECONDS = 86400
RESET_TIME_TOLERANCE_SECONDS = 1800
MIN_CALIBRATION_BLOCK_PERCENT = 2.0
FALLBACK_CALIBRATION_BLOCK_PERCENT = 0.5
SATURATION_PERCENT = 99.5
RETENTION_DAYS = 400


def _parse_iso(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def _finite_nonneg(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    return num if math.isfinite(num) and num >= 0 else None


def _percentile(sorted_values, p):
    if not sorted_values:
        return None
    if len(sorted_values) == 1:
        return sorted_values[0]
    pos = max(0.0, min(len(sorted_values) - 1, p * (len(sorted_values) - 1)))
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return sorted_values[lo]
    frac = pos - lo
    return sorted_values[lo] + frac * (sorted_values[hi] - sorted_values[lo])


def _is_window_reset(prev_used, curr_used, prev_resets_at, curr_resets_at,
                     prev_win_tokens=None, curr_win_tokens=None):
    if prev_win_tokens is not None and curr_win_tokens is not None and curr_win_tokens < prev_win_tokens:
        return True
    if prev_used is None or curr_used is None:
        return False
    if curr_used < prev_used - 1.0:
        return True
    prev_dt = _parse_iso(prev_resets_at)
    curr_dt = _parse_iso(curr_resets_at)
    if prev_dt is not None and curr_dt is not None:
        if abs((curr_dt - prev_dt).total_seconds()) > RESET_TIME_TOLERANCE_SECONDS:
            return True
    return False


class DirectUsageStore:
    """SQLite-backed snapshot store that estimates direct-login account usage.

    Records periodic snapshots of the upstream account's 7-day utilization,
    credit balance, and Sub2API's cumulative daily usage. By comparing total
    account quota/credit consumption against Sub2API's logged usage over any
    queried date range, it estimates the portion consumed via direct login.
    """

    def __init__(
        self,
        db_path,
        account_id=1,
        tz='Asia/Shanghai',
        seven_day_cost_override=None,
        credit_cost_ratio=1.0,
    ):
        self.db_path = Path(db_path)
        self.account_id = int(account_id)
        self.tz = tz
        self.zone = ZoneInfo(tz)
        self.seven_day_cost_override = (
            float(seven_day_cost_override)
            if seven_day_cost_override is not None and float(seven_day_cost_override) > 0
            else None
        )
        self.credit_cost_ratio = (
            float(credit_cost_ratio) if credit_cost_ratio is not None and float(credit_cost_ratio) > 0 else 1.0
        )
        self._initialized = False

    def _connect(self):
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        if not self._initialized:
            conn.execute('PRAGMA journal_mode=WAL')
            conn.execute(
                '''
                CREATE TABLE IF NOT EXISTS quota_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_id INTEGER NOT NULL,
                    ts REAL NOT NULL,
                    local_date TEXT NOT NULL,
                    seven_day_used REAL,
                    seven_day_resets_at TEXT,
                    five_hour_used REAL,
                    five_hour_resets_at TEXT,
                    credits_balance REAL,
                    sub2_day_tokens INTEGER NOT NULL,
                    sub2_day_cost REAL NOT NULL,
                    sub2_day_requests INTEGER NOT NULL DEFAULT 0,
                    sub2_prev_day_tokens INTEGER,
                    sub2_prev_day_cost REAL,
                    window_sub2_tokens INTEGER,
                    window_sub2_cost REAL
                )
                '''
            )
            existing_cols = {
                row['name'] for row in conn.execute('PRAGMA table_info(quota_snapshots)').fetchall()
            }
            if 'window_sub2_tokens' not in existing_cols:
                conn.execute('ALTER TABLE quota_snapshots ADD COLUMN window_sub2_tokens INTEGER')
            if 'window_sub2_cost' not in existing_cols:
                conn.execute('ALTER TABLE quota_snapshots ADD COLUMN window_sub2_cost REAL')
            conn.execute(
                'CREATE INDEX IF NOT EXISTS idx_snapshots_account_ts '
                'ON quota_snapshots (account_id, ts)'
            )
            conn.execute(
                'CREATE INDEX IF NOT EXISTS idx_snapshots_account_date '
                'ON quota_snapshots (account_id, local_date, ts)'
            )
            conn.commit()
            self._initialized = True
        return conn

    def last_snapshot_ts(self):
        if not self.db_path.exists():
            return None
        with self._connect() as conn:
            row = conn.execute(
                'SELECT ts FROM quota_snapshots WHERE account_id = ? ORDER BY ts DESC LIMIT 1',
                (self.account_id,),
            ).fetchone()
            return float(row['ts']) if row is not None else None

    def record_snapshot(
        self,
        *,
        ts,
        seven_day_used=None,
        seven_day_resets_at=None,
        five_hour_used=None,
        five_hour_resets_at=None,
        credits_balance=None,
        sub2_day_tokens=0,
        sub2_day_cost=0.0,
        sub2_day_requests=0,
        sub2_prev_day_tokens=None,
        sub2_prev_day_cost=None,
        window_sub2_tokens=None,
        window_sub2_cost=None,
    ):
        ts_val = float(ts)
        local_date = datetime.fromtimestamp(ts_val, tz=timezone.utc).astimezone(self.zone).date().isoformat()
        s7 = _finite_nonneg(seven_day_used)
        s5 = _finite_nonneg(five_hour_used)
        bal = _finite_nonneg(credits_balance)
        day_tokens = max(0, int(sub2_day_tokens or 0))
        day_cost = max(0.0, float(sub2_day_cost or 0.0))
        day_req = max(0, int(sub2_day_requests or 0))
        prev_tokens = max(0, int(sub2_prev_day_tokens)) if sub2_prev_day_tokens is not None else None
        prev_cost = max(0.0, float(sub2_prev_day_cost)) if sub2_prev_day_cost is not None else None
        win_tokens_num = _finite_nonneg(window_sub2_tokens)
        win_tokens = int(round(win_tokens_num)) if win_tokens_num is not None else None
        win_cost = _finite_nonneg(window_sub2_cost)
        cutoff_ts = ts_val - RETENTION_DAYS * 86400
        with self._connect() as conn:
            conn.execute(
                '''
                INSERT INTO quota_snapshots (
                    account_id, ts, local_date,
                    seven_day_used, seven_day_resets_at,
                    five_hour_used, five_hour_resets_at,
                    credits_balance,
                    sub2_day_tokens, sub2_day_cost, sub2_day_requests,
                    sub2_prev_day_tokens, sub2_prev_day_cost,
                    window_sub2_tokens, window_sub2_cost
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    self.account_id,
                    ts_val,
                    local_date,
                    s7,
                    seven_day_resets_at if isinstance(seven_day_resets_at, str) else None,
                    s5,
                    five_hour_resets_at if isinstance(five_hour_resets_at, str) else None,
                    bal,
                    day_tokens,
                    day_cost,
                    day_req,
                    prev_tokens,
                    prev_cost,
                    win_tokens,
                    win_cost,
                ),
            )
            conn.execute(
                'DELETE FROM quota_snapshots WHERE account_id = ? AND ts < ?',
                (self.account_id, cutoff_ts),
            )
            conn.commit()

    def _load_snapshots(self):
        if not self.db_path.exists():
            return []
        with self._connect() as conn:
            rows = conn.execute(
                '''
                SELECT ts, local_date, seven_day_used, seven_day_resets_at,
                       credits_balance, sub2_day_tokens, sub2_day_cost,
                       sub2_prev_day_tokens, sub2_prev_day_cost,
                       window_sub2_tokens, window_sub2_cost
                FROM quota_snapshots
                WHERE account_id = ?
                ORDER BY ts ASC, id ASC
                ''',
                (self.account_id,),
            ).fetchall()
            return [dict(row) for row in rows]

    def _midnight_ts(self, day_str):
        d = date.fromisoformat(day_str)
        dt = datetime.combine(d, dt_time.min, tzinfo=self.zone)
        return dt.timestamp()

    def _compute_intervals(self, rows):
        """Convert chronological snapshots into per-day attributed intervals."""
        intervals = []
        for idx in range(1, len(rows)):
            prev = rows[idx - 1]
            curr = rows[idx]
            dt_sec = curr['ts'] - prev['ts']
            if dt_sec <= 0 or dt_sec > MAX_INTERVAL_SECONDS:
                continue
            prev_day = date.fromisoformat(prev['local_date'])
            curr_day = date.fromisoformat(curr['local_date'])
            day_diff = (curr_day - prev_day).days
            if day_diff < 0 or day_diff > 1:
                continue

            reset = _is_window_reset(
                prev['seven_day_used'],
                curr['seven_day_used'],
                prev['seven_day_resets_at'],
                curr['seven_day_resets_at'],
                prev.get('window_sub2_tokens'),
                curr.get('window_sub2_tokens'),
            )
            if prev['seven_day_used'] is not None and curr['seven_day_used'] is not None:
                if reset:
                    delta_u = max(0.0, curr['seven_day_used'])
                else:
                    delta_u = max(0.0, curr['seven_day_used'] - prev['seven_day_used'])
            else:
                delta_u = 0.0

            if prev['credits_balance'] is not None and curr['credits_balance'] is not None:
                delta_credits = max(0.0, prev['credits_balance'] - curr['credits_balance'])
            else:
                delta_credits = 0.0

            saturated = (
                curr['seven_day_used'] is not None and curr['seven_day_used'] >= SATURATION_PERCENT
            )
            has_window_stats = (
                prev.get('window_sub2_cost') is not None
                and curr.get('window_sub2_cost') is not None
                and prev.get('window_sub2_tokens') is not None
                and curr.get('window_sub2_tokens') is not None
            )

            if has_window_stats:
                if reset:
                    win_delta_cost = max(0.0, curr['window_sub2_cost'])
                    win_delta_tokens = max(0, curr['window_sub2_tokens'])
                else:
                    win_delta_cost = max(0.0, curr['window_sub2_cost'] - prev['window_sub2_cost'])
                    win_delta_tokens = max(0, curr['window_sub2_tokens'] - prev['window_sub2_tokens'])
                calibratable = not reset and not saturated and delta_credits == 0.0
                if day_diff == 0:
                    intervals.append(
                        {
                            'local_date': curr['local_date'],
                            'start_ts': prev['ts'],
                            'end_ts': curr['ts'],
                            'delta_u': delta_u,
                            'delta_credits': delta_credits,
                            'delta_sub2_cost': win_delta_cost,
                            'delta_sub2_tokens': win_delta_tokens,
                            'reset': reset,
                            'saturated': saturated,
                            'calibratable': calibratable,
                        }
                    )
                else:
                    midnight = self._midnight_ts(curr['local_date'])
                    frac_prev = max(0.0, min(1.0, (midnight - prev['ts']) / dt_sec))
                    frac_curr = 1.0 - frac_prev
                    prev_tokens = int(round(win_delta_tokens * frac_prev))
                    curr_tokens = win_delta_tokens - prev_tokens
                    if frac_prev > 0:
                        intervals.append(
                            {
                                'local_date': prev['local_date'],
                                'start_ts': prev['ts'],
                                'end_ts': min(midnight, curr['ts']),
                                'delta_u': delta_u * frac_prev,
                                'delta_credits': delta_credits * frac_prev,
                                'delta_sub2_cost': win_delta_cost * frac_prev,
                                'delta_sub2_tokens': prev_tokens,
                                'reset': reset,
                                'saturated': saturated,
                                'calibratable': calibratable,
                                'cross_midnight_whole': (delta_u, win_delta_cost),
                            }
                        )
                    if frac_curr > 0:
                        intervals.append(
                            {
                                'local_date': curr['local_date'],
                                'start_ts': max(midnight, prev['ts']),
                                'end_ts': curr['ts'],
                                'delta_u': delta_u * frac_curr,
                                'delta_credits': delta_credits * frac_curr,
                                'delta_sub2_cost': win_delta_cost * frac_curr,
                                'delta_sub2_tokens': curr_tokens,
                                'reset': reset,
                                'saturated': saturated,
                                'calibratable': calibratable,
                                'cross_midnight_second': True,
                            }
                        )
                continue

            if day_diff == 0:
                delta_sub2_cost = max(0.0, curr['sub2_day_cost'] - prev['sub2_day_cost'])
                delta_sub2_tokens = max(0, curr['sub2_day_tokens'] - prev['sub2_day_tokens'])
                intervals.append(
                    {
                        'local_date': curr['local_date'],
                        'start_ts': prev['ts'],
                        'end_ts': curr['ts'],
                        'delta_u': delta_u,
                        'delta_credits': delta_credits,
                        'delta_sub2_cost': delta_sub2_cost,
                        'delta_sub2_tokens': delta_sub2_tokens,
                        'reset': reset,
                        'saturated': saturated,
                        'calibratable': (not reset and not saturated and delta_credits == 0.0),
                    }
                )
            else:
                # Split midnight-crossing interval proportionally for quota/credits,
                # and use prev_day final totals for exact Sub2API day attribution.
                midnight = self._midnight_ts(curr['local_date'])
                frac_prev = max(0.0, min(1.0, (midnight - prev['ts']) / dt_sec))
                frac_curr = 1.0 - frac_prev
                prev_rem_cost = (
                    max(0.0, curr['sub2_prev_day_cost'] - prev['sub2_day_cost'])
                    if curr['sub2_prev_day_cost'] is not None
                    else 0.0
                )
                prev_rem_tokens = (
                    max(0, curr['sub2_prev_day_tokens'] - prev['sub2_day_tokens'])
                    if curr['sub2_prev_day_tokens'] is not None
                    else 0
                )
                curr_new_cost = max(0.0, curr['sub2_day_cost'])
                curr_new_tokens = max(0, curr['sub2_day_tokens'])
                calibratable = not reset and not saturated and delta_credits == 0.0
                if frac_prev > 0 or prev_rem_cost > 0 or prev_rem_tokens > 0:
                    intervals.append(
                        {
                            'local_date': prev['local_date'],
                            'start_ts': prev['ts'],
                            'end_ts': min(midnight, curr['ts']),
                            'delta_u': delta_u * frac_prev,
                            'delta_credits': delta_credits * frac_prev,
                            'delta_sub2_cost': prev_rem_cost,
                            'delta_sub2_tokens': prev_rem_tokens,
                            'reset': reset,
                            'saturated': saturated,
                            'calibratable': calibratable,
                            'cross_midnight_whole': (
                                delta_u,
                                prev_rem_cost + curr_new_cost,
                            ),
                        }
                    )
                if frac_curr > 0 or curr_new_cost > 0 or curr_new_tokens > 0:
                    intervals.append(
                        {
                            'local_date': curr['local_date'],
                            'start_ts': max(midnight, prev['ts']),
                            'end_ts': curr['ts'],
                            'delta_u': delta_u * frac_curr,
                            'delta_credits': delta_credits * frac_curr,
                            'delta_sub2_cost': curr_new_cost,
                            'delta_sub2_tokens': curr_new_tokens,
                            'reset': reset,
                            'saturated': saturated,
                            'calibratable': calibratable,
                            'cross_midnight_second': True,
                        }
                    )
        return intervals

    def _calibrate(self, intervals):
        """Return (seven_day_cost_basis, mode) where mode is 'manual' | 'auto' | 'pending'."""
        if self.seven_day_cost_override is not None:
            return self.seven_day_cost_override, 'manual'

        samples = []
        block_u = 0.0
        block_cost = 0.0
        fallback_u = 0.0
        fallback_cost = 0.0
        last_end_ts = None

        for iv in intervals:
            if iv.get('cross_midnight_second'):
                last_end_ts = iv['end_ts']
                continue
            if not iv['calibratable']:
                block_u = 0.0
                block_cost = 0.0
                last_end_ts = iv['end_ts']
                continue
            if last_end_ts is not None and iv['start_ts'] - last_end_ts > MAX_INTERVAL_SECONDS:
                block_u = 0.0
                block_cost = 0.0

            if 'cross_midnight_whole' in iv:
                du, dc = iv['cross_midnight_whole']
            else:
                du, dc = iv['delta_u'], iv['delta_sub2_cost']

            block_u += du
            block_cost += dc
            fallback_u += du
            fallback_cost += dc
            last_end_ts = iv['end_ts']

            if block_u >= MIN_CALIBRATION_BLOCK_PERCENT:
                if block_cost > 0:
                    samples.append((block_cost / block_u) * 100.0)
                block_u = 0.0
                block_cost = 0.0

        if samples:
            samples.sort()
            if len(samples) == 2:
                basis = samples[1]
            else:
                basis = _percentile(samples, 0.85)
            return basis, 'auto'

        if fallback_u >= FALLBACK_CALIBRATION_BLOCK_PERCENT and fallback_cost > 0:
            return (fallback_cost / fallback_u) * 100.0, 'auto'

        return None, 'pending'

    def estimate_range(self, start_date, end_date):
        """Estimate direct-login usage over [start_date, end_date] inclusive."""
        start_str = start_date.isoformat() if isinstance(start_date, date) else str(start_date)
        end_str = end_date.isoformat() if isinstance(end_date, date) else str(end_date)

        rows = self._load_snapshots()
        intervals = self._compute_intervals(rows)
        basis, mode = self._calibrate(intervals)

        latest = rows[-1] if rows else None
        window_ref = None
        if (latest is not None and latest.get('seven_day_used') is not None
                and latest.get('window_sub2_cost') is not None):
            w_used = float(latest['seven_day_used'])
            w_sub2_cost = float(latest['window_sub2_cost'])
            w_sub2_tokens = int(latest['window_sub2_tokens'] or 0)
            w_min_basis = round(w_sub2_cost / (w_used / 100.0), 2) if w_used > 0 else None
            w_direct_cost = round(max(0.0, (w_used / 100.0) * basis - w_sub2_cost), 4) if basis is not None else None
            window_ref = {
                'used_percent': round(w_used, 2),
                'sub2_cost': round(w_sub2_cost, 4),
                'sub2_tokens': w_sub2_tokens,
                'min_full_cost': w_min_basis,
                'direct_cost': w_direct_cost,
            }

        in_range = [iv for iv in intervals if start_str <= iv['local_date'] <= end_str]
        if not in_range:
            in_range_snaps = [r for r in rows if start_str <= r['local_date'] <= end_str]
            if in_range_snaps:
                meta = {
                    'status': 'collecting',
                    'quota_percent': 0.0,
                    'total_quota_percent': 0.0,
                    'credits_delta': 0.0,
                    'sub2_cost': 0.0,
                    'total_account_cost': None,
                    'seven_day_cost_basis': round(basis, 4) if basis is not None else None,
                    'calibration_mode': mode,
                    'sample_count': len(in_range_snaps),
                }
                return {
                    'status': 'collecting',
                    'calibration_mode': mode,
                    'seven_day_cost_basis': round(basis, 4) if basis is not None else None,
                    'total_quota_percent': 0.0,
                    'direct_quota_percent': 0.0,
                    'credits_delta': 0.0,
                    'sub2_cost': 0.0,
                    'total_account_cost': None,
                    'direct_cost': None,
                    'direct_tokens': None,
                    'sample_count': len(in_range_snaps),
                    'coverage_start': None,
                    'coverage_end': None,
                    'window_ref': window_ref,
                    'row': {
                        'user_id': DIRECT_USER_ID,
                        'email': DIRECT_USER_LABEL,
                        'requests': None,
                        'input_tokens': None,
                        'output_tokens': None,
                        'cache_tokens': None,
                        'total_tokens': None,
                        'cost': None,
                        'actual_cost': None,
                        'is_estimated': True,
                        'direct_usage': meta,
                    },
                }
            return {
                'status': 'no_data',
                'calibration_mode': mode,
                'seven_day_cost_basis': round(basis, 4) if basis is not None else None,
                'total_quota_percent': 0.0,
                'direct_quota_percent': 0.0,
                'credits_delta': 0.0,
                'sub2_cost': 0.0,
                'total_account_cost': None,
                'direct_cost': None,
                'direct_tokens': None,
                'sample_count': 0,
                'coverage_start': None,
                'coverage_end': None,
                'window_ref': window_ref,
                'row': None,
            }

        delta_u = sum(iv['delta_u'] for iv in in_range)
        delta_credits = sum(iv['delta_credits'] for iv in in_range)
        sub2_cost = sum(iv['delta_sub2_cost'] for iv in in_range)
        sub2_tokens = sum(iv['delta_sub2_tokens'] for iv in in_range)
        sample_count = len(in_range) + 1
        cov_start = datetime.fromtimestamp(in_range[0]['start_ts'], tz=timezone.utc).astimezone(self.zone).isoformat()
        cov_end = datetime.fromtimestamp(in_range[-1]['end_ts'], tz=timezone.utc).astimezone(self.zone).isoformat()

        # Global tokens-per-dollar fallback for days where only direct login was active.
        global_sub2_cost = sum(iv['delta_sub2_cost'] for iv in intervals)
        global_sub2_tokens = sum(iv['delta_sub2_tokens'] for iv in intervals)
        tokens_per_dollar = None
        if sub2_cost > 0 and sub2_tokens > 0:
            tokens_per_dollar = sub2_tokens / sub2_cost
        elif global_sub2_cost > 0 and global_sub2_tokens > 0:
            tokens_per_dollar = global_sub2_tokens / global_sub2_cost

        credit_cost = delta_credits * self.credit_cost_ratio

        if basis is not None:
            quota_cost = (delta_u / 100.0) * basis
            total_account_cost = quota_cost + credit_cost
            direct_cost = max(0.0, total_account_cost - sub2_cost)
            direct_quota_percent = (
                min(delta_u, (direct_cost / total_account_cost) * delta_u)
                if total_account_cost > 0 and delta_u > 0
                else 0.0
            )
            direct_tokens = (
                int(round(direct_cost * tokens_per_dollar))
                if direct_cost > 0 and tokens_per_dollar is not None
                else (0 if direct_cost == 0 else None)
            )
            has_direct = (
                direct_cost >= 0.001
                or (direct_tokens is not None and direct_tokens >= 1)
                or direct_quota_percent >= 0.1
            )
            status = 'ok' if has_direct else 'zero'
        elif delta_u == 0 and delta_credits > 0:
            total_account_cost = credit_cost
            direct_cost = max(0.0, total_account_cost - sub2_cost)
            direct_quota_percent = 0.0
            direct_tokens = (
                int(round(direct_cost * tokens_per_dollar))
                if direct_cost > 0 and tokens_per_dollar is not None
                else (0 if direct_cost == 0 else None)
            )
            has_direct = direct_cost >= 0.001 or (direct_tokens is not None and direct_tokens >= 1)
            status = 'ok' if has_direct else 'zero'
        elif delta_u == 0 and delta_credits == 0:
            total_account_cost = 0.0
            direct_cost = 0.0
            direct_quota_percent = 0.0
            direct_tokens = 0
            has_direct = False
            status = 'zero'
        else:
            # 7-day quota moved, but calibration basis is not yet available.
            total_account_cost = None
            direct_cost = None
            direct_tokens = None
            direct_quota_percent = delta_u if (delta_u > 0 and sub2_cost == 0) else 0.0
            has_direct = delta_u >= 0.1 and sub2_cost == 0
            status = 'pending_calibration'

        meta = {
            'status': status,
            'quota_percent': round(direct_quota_percent, 2),
            'total_quota_percent': round(delta_u, 2),
            'credits_delta': round(delta_credits, 6),
            'sub2_cost': round(sub2_cost, 6),
            'total_account_cost': round(total_account_cost, 6) if total_account_cost is not None else None,
            'seven_day_cost_basis': round(basis, 4) if basis is not None else None,
            'calibration_mode': mode,
            'sample_count': sample_count,
        }

        row = {
            'user_id': DIRECT_USER_ID,
            'email': DIRECT_USER_LABEL,
            'requests': None,
            'input_tokens': None,
            'output_tokens': None,
            'cache_tokens': None,
            'total_tokens': direct_tokens,
            'cost': round(direct_cost, 6) if direct_cost is not None else None,
            'actual_cost': round(direct_cost, 6) if direct_cost is not None else None,
            'is_estimated': True,
            'direct_usage': meta,
        }

        return {
            'status': status,
            'calibration_mode': mode,
            'seven_day_cost_basis': round(basis, 4) if basis is not None else None,
            'total_quota_percent': round(delta_u, 2),
            'direct_quota_percent': round(direct_quota_percent, 2),
            'credits_delta': round(delta_credits, 6),
            'sub2_cost': round(sub2_cost, 6),
            'total_account_cost': round(total_account_cost, 6) if total_account_cost is not None else None,
            'direct_cost': round(direct_cost, 6) if direct_cost is not None else None,
            'direct_tokens': direct_tokens,
            'sample_count': sample_count,
            'coverage_start': cov_start,
            'coverage_end': cov_end,
            'window_ref': window_ref,
            'row': row,
        }
