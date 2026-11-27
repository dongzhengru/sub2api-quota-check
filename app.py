import asyncio
import copy
import math
import os
import time
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / '.env')
CACHE_SECONDS = 60
USERS_CACHE_SECONDS = 300
ACTIVITY_DAYS = 365
EXCLUDED_USER_EMAILS = {'system-check@sub2api.com'}
TREND_FIELDS = ('requests', 'input_tokens', 'output_tokens', 'cache_creation_tokens',
                'cache_read_tokens', 'total_tokens', 'cost', 'actual_cost')
WINDOW_KEYS = ('five_hour', 'seven_day')


class UsageService:
    def __init__(self, client, email, password, account_id=1, tz='Asia/Shanghai', show_five_hour=True):
        self.client = client
        self.email = email
        self.password = password
        self.account_id = account_id
        self.tz = tz
        self.show_five_hour = show_five_hour
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

    async def user_breakdown(self, start_date, end_date, page, page_size):
        if start_date > end_date:
            raise HTTPException(400, '开始日期不能晚于结束日期。')
        # The upstream exposes a top-N limit, not a page/offset contract.
        # Request one extra row so the UI can accurately enable the next page.
        offset = (page - 1) * page_size
        async with self.breakdown_lock:
            try:
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
                    return {'start_date': start_date.isoformat(), 'end_date': end_date.isoformat(),
                            'timezone': self.tz, 'users': users[offset:offset + page_size],
                            'page': page, 'page_size': page_size,
                            'has_more': len(users) > offset + page_size}
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
            return {'updated_at': data.get('updated_at'), **windows,
                    'reset_credits': reset_credits, 'credits': credits}

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


@asynccontextmanager
async def lifespan(app):
    async with httpx.AsyncClient(
        base_url=os.getenv('SUB2API_BASE_URL', 'https://gateway.zhengru.top').rstrip('/'),
        timeout=25.0, follow_redirects=False,
    ) as client:
        app.state.usage = UsageService(
            client, os.getenv('SUB2API_EMAIL'), os.getenv('SUB2API_PASSWORD'),
            int(os.getenv('SUB2API_ACCOUNT_ID', '1')), os.getenv('SUB2API_TIMEZONE', 'Asia/Shanghai'),
            os.getenv('SUB2API_SHOW_FIVE_HOUR', 'true').strip().lower() not in {'0', 'false', 'no', 'off'},
        )
        yield


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
async def token_activity(user: str | None = Query(None, min_length=1, max_length=254)):
    from fastapi.responses import JSONResponse
    return JSONResponse(await app.state.usage.token_activity(user), headers={'Cache-Control': 'no-store'})
