import asyncio
import copy
import logging
import math
import os
import time
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from direct_usage import DirectUsageStore

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / '.env')
logger = logging.getLogger(__name__)
CACHE_SECONDS = 60
USERS_CACHE_SECONDS = 300
DEFAULT_SNAPSHOT_INTERVAL_SECONDS = 300
ACTIVITY_DAYS = 365
EXCLUDED_USER_EMAILS = {'system-check@sub2api.com'}
TREND_FIELDS = ('requests', 'input_tokens', 'output_tokens', 'cache_creation_tokens',
                'cache_read_tokens', 'total_tokens', 'cost', 'actual_cost')
WINDOW_KEYS = ('five_hour', 'seven_day')


def _parse_optional_positive_float(raw):
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    try:
        value = float(text)
    except ValueError:
        return None
    return value if math.isfinite(value) and value > 0 else None


def _parse_nonneg_int(raw, default):
    if raw is None or not str(raw).strip():
        return default
    try:
        value = int(str(raw).strip())
    except ValueError:
        return default
    return max(0, value)


class UsageService:
    def __init__(self, client, email, password, account_id=1, tz='Asia/Shanghai',
                 show_five_hour=True, store=None, snapshot_min_interval=DEFAULT_SNAPSHOT_INTERVAL_SECONDS,
                 proxy_url=None):
        self.client = client
        self.email = email
        self.password = password
        self.account_id = account_id
        self.tz = tz
        self.show_five_hour = show_five_hour
        self.store = store
        self.snapshot_min_interval = max(0, int(snapshot_min_interval))
        self.proxy_url = proxy_url.rstrip('/') if isinstance(proxy_url, str) and proxy_url.strip() else None
        self.token = None
        self.token_deadline = 0.0
        self.cached = None
        self.cache_deadline = 0.0
        self.fetched_at = None
        self.lock = asyncio.Lock()
        self.breakdown_lock = asyncio.Lock()
        self.users_lock = asyncio.Lock()
        self.users_cached = None
        self.users_deadline = 0.0
        self.activity_lock = asyncio.Lock()
        self.activity_cache = {}
        self.snapshot_lock = asyncio.Lock()

    @staticmethod
    def unpack_proxy(response, stage='查询'):
        if response.status_code >= 400:
            detail = None
            try:
                body = response.json()
                if isinstance(body, dict) and isinstance(body.get('detail'), str):
                    detail = body['detail']
            except ValueError:
                pass
            status = response.status_code if response.status_code in {400, 403, 404, 423, 503, 504} else 502
            raise HTTPException(status, detail or '代理上游%s失败（HTTP %s）。' % (stage, response.status_code))
        try:
            payload = response.json()
        except ValueError:
            raise HTTPException(502, '代理上游%s返回无效 JSON。' % stage)
        if not isinstance(payload, dict):
            raise HTTPException(502, '代理上游%s返回数据格式无效。' % stage)
        return payload

    async def directory(self):
        if self.users_cached is not None and time.monotonic() < self.users_deadline:
            return self.users_cached
        async with self.users_lock:
            if self.users_cached is not None and time.monotonic() < self.users_deadline:
                return self.users_cached
            try:
                if not self.token or time.monotonic() >= self.token_deadline:
                    await self.login()
                users, page = [], 1
                while True:
                    for attempt in range(2):
                        response = await self.client.get(
                            '/api/v1/admin/users',
                            params={'page': page, 'page_size': 100, 'include_subscriptions': 'false',
                                    'sort_by': 'created_at', 'sort_order': 'desc', 'timezone': self.tz},
                            headers={'Authorization': 'Bearer ' + self.token},
                        )
                        if response.status_code == 401 and attempt == 0:
                            await self.login()
                            continue
                        break
                    data = self.unpack(response, stage='用户列表查询')
                    items = data.get('items')
                    if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
                        raise HTTPException(502, '上游返回的用户列表无效。')
                    for item in items:
                        email = item.get('email')
                        if (isinstance(email, str) and email and email.lower() not in EXCLUDED_USER_EMAILS
                                and isinstance(item.get('id'), int)):
                            username = item.get('username')
                            users.append({'id': item['id'], 'email': email,
                                          'username': username if isinstance(username, str) else ''})
                    pages = data.get('pages')
                    if not items or not isinstance(pages, int) or page >= pages or page >= 50:
                        break
                    page += 1
                self.users_cached = users
                self.users_deadline = time.monotonic() + USERS_CACHE_SECONDS
                return users
            except httpx.TimeoutException:
                raise HTTPException(504, '上游查询超时，请稍后重试。')
            except httpx.RequestError:
                raise HTTPException(502, '无法连接上游服务，请检查网络后重试。')

    async def fetch_activity_trend(self, start, end, user_id):
        try:
            if not self.token or time.monotonic() >= self.token_deadline:
                await self.login()
            params = {'start_date': start.isoformat(), 'end_date': end.isoformat(), 'granularity': 'day',
                      'include_trend': 'true', 'include_model_stats': 'false',
                      'include_group_stats': 'false', 'timezone': self.tz}
            if user_id is not None:
                params['user_id'] = user_id
            for attempt in range(2):
                response = await self.client.get(
                    '/api/v1/admin/dashboard/snapshot-v2', params=params,
                    headers={'Authorization': 'Bearer ' + self.token},
                )
                if response.status_code == 401 and attempt == 0:
                    await self.login()
                    continue
                data = self.unpack(response, stage='Token Activity 查询')
                rows = data.get('trend')
                if not isinstance(rows, list) or len(rows) > ACTIVITY_DAYS:
                    raise HTTPException(502, '上游返回的 Token Activity 数据无效。')
                trend = []
                for row in rows:
                    if not isinstance(row, dict):
                        raise HTTPException(502, '上游返回的 Token Activity 数据无效。')
                    try:
                        day = date.fromisoformat(row.get('date'))
                    except (TypeError, ValueError):
                        raise HTTPException(502, '上游返回的 Token Activity 日期无效。')
                    if not start <= day <= end:
                        raise HTTPException(502, '上游返回的 Token Activity 日期超出范围。')
                    entry = {'date': day.isoformat()}
                    for field in TREND_FIELDS:
                        value = row.get(field)
                        if (isinstance(value, bool) or not isinstance(value, (int, float))
                                or not math.isfinite(value) or value < 0):
                            raise HTTPException(502, '上游返回的 Token Activity 数据无效。')
                        entry[field] = value
                    trend.append(entry)
                trend.sort(key=lambda entry: entry['date'])
                return trend
        except httpx.TimeoutException:
            raise HTTPException(504, '上游查询超时，请稍后重试。')
        except httpx.RequestError:
            raise HTTPException(502, '无法连接上游服务，请检查网络后重试。')

    async def token_activity(self, user=None):
        if self.proxy_url:
            key = ('proxy', user or '')
            async with self.activity_lock:
                hit = self.activity_cache.get(key)
                if hit and time.monotonic() < hit[0]:
                    return copy.deepcopy(hit[1])
                try:
                    params = {'user': user} if user else None
                    response = await self.client.get('api/token-activity', params=params)
                    data = self.unpack_proxy(response, stage='Token Activity 查询')
                except httpx.TimeoutException:
                    raise HTTPException(504, '上游查询超时，请稍后重试。')
                except httpx.RequestError:
                    raise HTTPException(502, '无法连接上游服务，请检查网络后重试。')
                now = time.monotonic()
                self.activity_cache = {k: v for k, v in self.activity_cache.items() if now < v[0]}
                self.activity_cache[key] = (now + CACHE_SECONDS, data)
                return copy.deepcopy(data)
        end = datetime.now(ZoneInfo(self.tz)).date()
        start = end - timedelta(days=ACTIVITY_DAYS - 1)
        users = await self.directory()
        user_id = None
        if user:
            match = next((entry for entry in users if entry['email'] == user), None)
            if match is None:
                raise HTTPException(404, '未找到该用户，请刷新用户列表后重试。')
            user_id = match['id']
        key = (start, end, user or '')
        async with self.activity_lock:
            hit = self.activity_cache.get(key)
            if hit and time.monotonic() < hit[0]:
                trend = hit[1]
            else:
                trend = await self.fetch_activity_trend(start, end, user_id)
                now = time.monotonic()
                self.activity_cache = {k: v for k, v in self.activity_cache.items() if now < v[0]}
                self.activity_cache[key] = (now + CACHE_SECONDS, trend)
        return {'start_date': start.isoformat(), 'end_date': end.isoformat(), 'timezone': self.tz,
                'user': user or None,
                'users': [{'email': entry['email'], 'username': entry['username']} for entry in users],
                'trend': copy.deepcopy(trend)}

    async def _fetch_proxy_users(self, start_date, end_date, needed):
        users = []
        proxy_page = 1
        upstream_has_more = False
        while len(users) < needed and proxy_page <= 50:
            response = await self.client.get(
                'api/user-breakdown',
                params={'start_date': start_date.isoformat(), 'end_date': end_date.isoformat(),
                        'page': proxy_page, 'page_size': 100},
            )
            data = self.unpack_proxy(response, stage='用户用量查询')
            batch = data.get('users')
            if not isinstance(batch, list) or any(not isinstance(u, dict) for u in batch):
                raise HTTPException(502, '代理上游返回的用户用量数据无效。')
            users.extend(u for u in batch if not u.get('is_estimated'))
            upstream_has_more = bool(data.get('has_more'))
            if not upstream_has_more or not batch:
                break
            proxy_page += 1
        return users, upstream_has_more

    async def user_breakdown(self, start_date, end_date, page, page_size):
        if start_date > end_date:
            raise HTTPException(400, '开始日期不能晚于结束日期。')
        # The upstream exposes a top-N limit, not a page/offset contract.
        # Request one extra row so the UI can accurately enable the next page.
        offset = (page - 1) * page_size
        async with self.breakdown_lock:
            try:
                upstream_has_more = False
                if self.proxy_url:
                    users, upstream_has_more = await self._fetch_proxy_users(
                        start_date, end_date, offset + page_size + 1
                    )
                else:
                    if not self.token or time.monotonic() >= self.token_deadline:
                        await self.login()
                    for attempt in range(2):
                        response = await self.client.get(
                            '/api/v1/admin/dashboard/user-breakdown',
                            params={'start_date': start_date.isoformat(), 'end_date': end_date.isoformat(),
                                    'sort_by': 'actual_cost', 'limit': offset + page_size + 1,
                                    'timezone': self.tz},
                            headers={'Authorization': 'Bearer ' + self.token},
                        )
                        if response.status_code == 401 and attempt == 0:
                            await self.login()
                            continue
                        data = self.unpack(response, stage='用户用量查询')
                        users = data.get('users')
                        if not isinstance(users, list) or any(not isinstance(user, dict) for user in users):
                            raise HTTPException(502, '上游返回的用户用量数据无效。')
                        break
                merged = list(users)
                direct_estimate = None
                if self.store is not None:
                    try:
                        estimate = await asyncio.to_thread(self.store.estimate_range, start_date, end_date)
                        direct_row = estimate.pop('row', None)
                        direct_estimate = estimate
                        if direct_row is not None:
                            def _rank_key(item):
                                for field in ('actual_cost', 'cost'):
                                    val = item.get(field)
                                    if isinstance(val, (int, float)) and not isinstance(val, bool):
                                        return float(val)
                                return -1.0

                            direct_key = _rank_key(direct_row)
                            insert_at = len(merged)
                            for idx, item in enumerate(merged):
                                if direct_key > _rank_key(item):
                                    insert_at = idx
                                    break
                            # Keep the direct-login row visible on page 1 even when its
                            # current estimate is $0 / pending / below top-N, while keeping
                            # subsequent pages free of duplicates or missing users.
                            insert_at = min(insert_at, max(0, page_size - 1))
                            merged.insert(insert_at, direct_row)
                    except Exception:
                        logger.warning('计算账号直登估算用量失败，跳过直登估算。', exc_info=True)
                return {'start_date': start_date.isoformat(), 'end_date': end_date.isoformat(),
                        'timezone': self.tz, 'users': merged[offset:offset + page_size],
                        'page': page, 'page_size': page_size,
                        'has_more': len(merged) > offset + page_size or upstream_has_more,
                        'direct_estimate': direct_estimate}
            except httpx.TimeoutException:
                raise HTTPException(504, '上游查询超时，请稍后重试。')
            except httpx.RequestError:
                raise HTTPException(502, '无法连接上游服务，请检查网络后重试。')

    @staticmethod
    def unpack(response, stage='额度查询'):
        if response.status_code == 423:
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            code = payload.get('code') if isinstance(payload, dict) else None
            if code == 'ADMIN_COMPLIANCE_ACK_REQUIRED':
                raise HTTPException(423, '上游要求先完成管理员合规确认（ADMIN_COMPLIANCE_ACK_REQUIRED）。'
                                    '请使用查询账号登录 Sub2API 管理后台，完成合规确认后重试。')
            raise HTTPException(423, '上游%s被锁定（HTTP 423），请在 Sub2API 后台检查账号状态和待确认提示。' % stage)
        if response.status_code == 403:
            raise HTTPException(403, '账号无权查询额度，请配置有权限访问管理员账户额度接口的账号。')
        if response.status_code == 401:
            raise HTTPException(502, '上游认证失败，请检查登录账号和密码。')
        if response.status_code >= 400:
            raise HTTPException(502, '上游%s失败（HTTP %s）。' % (stage, response.status_code))
        try:
            payload = response.json()
            if not isinstance(payload, dict) or payload.get('code') != 0:
                raise ValueError()
            data = payload['data']
            if not isinstance(data, dict):
                raise ValueError()
            return data
        except (ValueError, KeyError):
            raise HTTPException(502, '上游返回异常数据，请检查账号权限或稍后重试。')

    async def login(self):
        if not self.email or not self.password:
            raise HTTPException(503, '请先在 .env 中配置 SUB2API_EMAIL 和 SUB2API_PASSWORD。')
        response = await self.client.post('/api/v1/auth/login', json={
            'email': self.email, 'password': self.password,
        })
        data = self.unpack(response, stage='登录')
        token = data.get('access_token')
        expires = data.get('expires_in', 86400)
        if not isinstance(token, str) or not token or not isinstance(expires, (int, float)):
            raise HTTPException(502, '登录响应缺少有效令牌。')
        self.token = token
        self.token_deadline = time.monotonic() + max(0, expires - 30)

    async def fetch(self):
        if self.proxy_url:
            response = await self.client.get('api/usage')
            data = self.unpack_proxy(response, stage='额度查询')
            windows = {}
            for key in WINDOW_KEYS:
                raw = data.get(key)
                if isinstance(raw, dict) and 'used_percent' in raw:
                    windows[key] = self.parse_window({
                        'utilization': raw.get('used_percent'),
                        'resets_at': raw.get('resets_at'),
                        'window_stats': raw.get('window_stats'),
                    })
                else:
                    windows[key] = None
            if not self.show_five_hour:
                windows['five_hour'] = None
            if not windows['seven_day']:
                raise HTTPException(502, '代理上游未返回有效的 7 天额度。')
            result = {
                'updated_at': data.get('updated_at'),
                **windows,
                'reset_credits': data.get('reset_credits') or {'available_count': None, 'credits': [], 'error': None},
                'credits': data.get('credits') or {'has_credits': False, 'unlimited': False, 'balance': None},
            }
            await self.record_snapshot_from_usage(result)
            return result
        if not self.token or time.monotonic() >= self.token_deadline:
            await self.login()
        for attempt in range(2):
            response = await self.client.get(
                '/api/v1/admin/accounts/%s/usage' % self.account_id,
                params={'source': 'active', 'force': 'true', 'timezone': self.tz},
                headers={'Authorization': 'Bearer ' + self.token},
            )
            if response.status_code == 401 and attempt == 0:
                self.token = None
                await self.login()
                continue
            data = self.unpack(response)
            windows = {key: self.parse_window(data.get(key)) for key in WINDOW_KEYS}
            if not self.show_five_hour:
                # 关闭开关时按 Pro 账号一样处理，前端与侧栏沿用隐藏 5 小时卡片的逻辑。
                windows['five_hour'] = None
            if not windows['seven_day']:
                raise HTTPException(502, '上游未返回有效的 7 天额度。')
            reset_credits, credits = await self.fetch_openai_quota()
            result = {'updated_at': data.get('updated_at'), **windows,
                      'reset_credits': reset_credits, 'credits': credits}
            await self.record_snapshot_from_usage(result)
            return result

    async def record_snapshot_from_usage(self, usage_result, force=False):
        if self.store is None or not isinstance(usage_result, dict):
            return False
        async with self.snapshot_lock:
            now_ts = time.time()
            try:
                last_ts = await asyncio.to_thread(self.store.last_snapshot_ts)
                if (not force and last_ts is not None
                        and self.snapshot_min_interval > 0
                        and now_ts - last_ts < self.snapshot_min_interval):
                    return False
                w7 = usage_result.get('seven_day') or {}
                w5 = usage_result.get('five_hour') or {}
                credits = usage_result.get('credits') or {}
                ws = w7.get('window_stats') if isinstance(w7.get('window_stats'), dict) else None
                win_tokens = ws.get('tokens') if ws else None
                win_cost = (ws.get('cost') if ws.get('cost') is not None else ws.get('standard_cost')) if ws else None
                win_req = ws.get('requests', 0) if ws else 0
                has_window_stats = (
                    isinstance(win_tokens, (int, float)) and not isinstance(win_tokens, bool)
                    and math.isfinite(win_tokens) and win_tokens >= 0
                    and isinstance(win_cost, (int, float)) and not isinstance(win_cost, bool)
                    and math.isfinite(win_cost) and win_cost >= 0
                )
                today_row, prev_row = {}, {}
                if not has_window_stats:
                    today = datetime.fromtimestamp(now_ts, tz=timezone.utc).astimezone(ZoneInfo(self.tz)).date()
                    yesterday = today - timedelta(days=1)
                    if self.proxy_url:
                        response = await self.client.get('api/token-activity')
                        activity = self.unpack_proxy(response, stage='Token Activity 查询')
                        trend = activity.get('trend') if isinstance(activity.get('trend'), list) else []
                    else:
                        trend = await self.fetch_activity_trend(yesterday, today, user_id=None)
                    by_date = {row['date']: row for row in trend if isinstance(row, dict) and isinstance(row.get('date'), str)}
                    today_row = by_date.get(today.isoformat()) or {}
                    prev_row = by_date.get(yesterday.isoformat()) or {}
                await asyncio.to_thread(
                    self.store.record_snapshot,
                    ts=now_ts,
                    seven_day_used=w7.get('used_percent'),
                    seven_day_resets_at=w7.get('resets_at'),
                    five_hour_used=w5.get('used_percent'),
                    five_hour_resets_at=w5.get('resets_at'),
                    credits_balance=credits.get('balance'),
                    sub2_day_tokens=today_row.get('total_tokens', 0),
                    sub2_day_cost=today_row.get('cost', 0.0),
                    sub2_day_requests=today_row.get('requests', win_req if has_window_stats else 0),
                    sub2_prev_day_tokens=prev_row.get('total_tokens') if not has_window_stats else None,
                    sub2_prev_day_cost=prev_row.get('cost') if not has_window_stats else None,
                    window_sub2_tokens=win_tokens if has_window_stats else None,
                    window_sub2_cost=win_cost if has_window_stats else None,
                )
                return True
            except Exception:
                logger.warning('记录额度快照失败，不影响额度查询。', exc_info=True)
                return False

    @staticmethod
    def parse_window(window):
        # Pro 账号上游没有 5 小时窗口，字段缺失或异常都按不存在该窗口处理。
        if not isinstance(window, dict):
            return None
        used, reset = window.get('utilization'), window.get('resets_at')
        if isinstance(used, bool) or not isinstance(used, (int, float)) or not math.isfinite(used) or used < 0:
            return None
        try:
            parsed = datetime.fromisoformat(reset.replace('Z', '+00:00'))
        except (AttributeError, TypeError, ValueError):
            return None
        if parsed.tzinfo is None:
            return None
        return {
            'used_percent': used,
            'remaining_percent': max(0, 100 - used),
            'resets_at': reset,
            'window_stats': window.get('window_stats'),
        }

    async def fetch_openai_quota(self):
        try:
            for attempt in range(2):
                response = await self.client.post(
                    '/api/v1/admin/openai/accounts/%s/quota/refresh' % self.account_id,
                    headers={'Authorization': 'Bearer ' + self.token}, timeout=10.0,
                )
                if response.status_code == 401 and attempt == 0:
                    await self.login()
                    continue
                if response.status_code == 404:
                    raise HTTPException(502, '上游暂不支持 OpenAI 点数查询，请确认 Sub2API 版本。')
                data = self.unpack(response, stage='点数额度查询')
                reset_info, credit_info = data.get('rate_limit_reset_credits') or {}, data.get('credits') or {}
                count, items = reset_info.get('available_count'), reset_info.get('credits')
                if type(count) is not int or count < 0 or not isinstance(items, list):
                    raise ValueError()
                credits = []
                for item in items:
                    if not isinstance(item, dict):
                        raise ValueError()
                    expires_at = item.get('expires_at')
                    if expires_at is not None:
                        parsed = datetime.fromisoformat(expires_at.replace('Z', '+00:00'))
                        if parsed.tzinfo is None:
                            raise ValueError()
                    credits.append({'label': '重置卡', 'resets_left': 1, 'expires_at': expires_at})
                credits.sort(key=lambda c: datetime.fromisoformat(c['expires_at'].replace('Z', '+00:00'))
                             if c['expires_at'] else datetime.max.replace(tzinfo=timezone.utc))
                return ({'available_count': count, 'credits': credits, 'error': None},
                        {'has_credits': bool(credit_info.get('has_credits')),
                         'unlimited': bool(credit_info.get('unlimited')),
                         'balance': credit_info.get('balance')})
        except HTTPException as exc:
            error = exc.detail
        except httpx.RequestError:
            error = '点数额度查询暂时失败，请稍后刷新。'
        except (ValueError, TypeError, AttributeError, OverflowError):
            error = '上游返回的点数额度数据无效。'
        # Usage remains usable even when this optional query is unavailable.
        return ({'available_count': None, 'credits': [], 'error': error},
                {'has_credits': False, 'unlimited': False, 'balance': None})

    def snapshot(self, hit):
        return {**copy.deepcopy(self.cached), 'timezone': self.tz, 'cache': {
            'hit': hit, 'ttl_seconds': CACHE_SECONDS,
            'remaining_seconds': max(0, math.ceil(self.cache_deadline - time.monotonic())),
            'fetched_at': self.fetched_at,
        }}

    async def get(self):
        if self.cached is not None and time.monotonic() < self.cache_deadline:
            return self.snapshot(True)
        # Double check after taking the lock: simultaneous misses share one query.
        async with self.lock:
            if self.cached is not None and time.monotonic() < self.cache_deadline:
                return self.snapshot(True)
            try:
                result = await self.fetch()
            except httpx.TimeoutException:
                raise HTTPException(504, '上游查询超时，请稍后重试。')
            except httpx.RequestError:
                raise HTTPException(502, '无法连接上游服务，请检查网络后重试。')
            self.cached = result
            self.fetched_at = datetime.now(timezone.utc).isoformat()
            self.cache_deadline = time.monotonic() + CACHE_SECONDS
            return self.snapshot(False)


def _build_snapshot_store(account_id, tz):
    raw_path = os.getenv('SUB2API_SNAPSHOT_DB')
    if raw_path is not None:
        cleaned = raw_path.strip()
        if cleaned.lower() in {'', '0', 'false', 'no', 'off', 'none'}:
            return None
        db_path = Path(cleaned)
    else:
        db_path = ROOT / 'data' / 'quota_snapshots.db'
    return DirectUsageStore(
        db_path=db_path,
        account_id=account_id,
        tz=tz,
        seven_day_cost_override=_parse_optional_positive_float(os.getenv('SUB2API_SEVEN_DAY_COST_EQUIVALENT')),
        credit_cost_ratio=_parse_optional_positive_float(os.getenv('SUB2API_CREDIT_COST_RATIO')) or 1.0,
    )


async def _snapshot_sampler_loop(service, interval_seconds):
    while True:
        try:
            snapshot = await service.get()
            await service.record_snapshot_from_usage(snapshot)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug('后台额度快照采样跳过。', exc_info=True)
        await asyncio.sleep(interval_seconds)


@asynccontextmanager
async def lifespan(app):
    account_id = int(os.getenv('SUB2API_ACCOUNT_ID', '1'))
    tz = os.getenv('SUB2API_TIMEZONE', 'Asia/Shanghai')
    email = os.getenv('SUB2API_EMAIL')
    password = os.getenv('SUB2API_PASSWORD')
    proxy_url = (os.getenv('SUB2API_QUOTA_PROXY_URL') or '').strip().rstrip('/') or None
    snapshot_interval = _parse_nonneg_int(
        os.getenv('SUB2API_SNAPSHOT_INTERVAL_SECONDS'),
        DEFAULT_SNAPSHOT_INTERVAL_SECONDS,
    )
    store = _build_snapshot_store(account_id, tz)
    base_url = (proxy_url + '/') if proxy_url else os.getenv('SUB2API_BASE_URL', 'https://gateway.zhengru.top').rstrip('/')
    async with httpx.AsyncClient(
        base_url=base_url,
        timeout=25.0, follow_redirects=False,
    ) as client:
        service = UsageService(
            client, email, password, account_id, tz,
            os.getenv('SUB2API_SHOW_FIVE_HOUR', 'true').strip().lower() not in {'0', 'false', 'no', 'off'},
            store=store,
            snapshot_min_interval=snapshot_interval if snapshot_interval > 0 else DEFAULT_SNAPSHOT_INTERVAL_SECONDS,
            proxy_url=proxy_url,
        )
        app.state.usage = service
        sampler_task = None
        if store is not None and snapshot_interval > 0 and (proxy_url or (email and password)):
            sampler_task = asyncio.create_task(_snapshot_sampler_loop(service, snapshot_interval))
        try:
            yield
        finally:
            if sampler_task is not None:
                sampler_task.cancel()
                await asyncio.gather(sampler_task, return_exceptions=True)


app = FastAPI(title='Sub2API 额度面板', lifespan=lifespan)
app.mount('/static', StaticFiles(directory=ROOT / 'static'), name='static')


@app.get('/')
async def index():
    return FileResponse(ROOT / 'static' / 'index.html', headers={'Cache-Control': 'no-store'})


@app.get('/api/usage')
async def usage():
    from fastapi.responses import JSONResponse
    return JSONResponse(await app.state.usage.get(), headers={'Cache-Control': 'no-store'})


@app.get('/api/config')
async def config():
    return {'timezone': app.state.usage.tz}


@app.get('/api/user-breakdown')
async def user_breakdown(start_date: date, end_date: date,
                         page: int = Query(1, ge=1, le=10000),
                         page_size: int = Query(20, ge=1, le=100)):
    from fastapi.responses import JSONResponse
    return JSONResponse(await app.state.usage.user_breakdown(start_date, end_date, page, page_size),
                        headers={'Cache-Control': 'no-store'})


@app.get('/api/token-activity')
async def token_activity(user: Optional[str] = Query(None, min_length=1, max_length=254)):
    from fastapi.responses import JSONResponse
    return JSONResponse(await app.state.usage.token_activity(user), headers={'Cache-Control': 'no-store'})
