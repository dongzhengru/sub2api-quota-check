import asyncio
import copy
import math
import os
import time
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / '.env')
CACHE_SECONDS = 60


class UsageService:
    def __init__(self, client, email, password, account_id=1, tz='Asia/Shanghai'):
        self.client = client
        self.email = email
        self.password = password
        self.account_id = account_id
        self.tz = tz
        self.token = None
        self.token_deadline = 0.0
        self.cached = None
        self.cache_deadline = 0.0
        self.fetched_at = None
        self.lock = asyncio.Lock()
        self.breakdown_lock = asyncio.Lock()

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
                                'sort_by': 'total_tokens', 'limit': offset + page_size + 1,
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
            windows = {}
            for key in ('five_hour', 'seven_day'):
                window = data.get(key)
                if not isinstance(window, dict):
                    raise HTTPException(502, '上游未返回完整的 5 小时和 7 天额度。')
                used = window.get('utilization')
                reset = window.get('resets_at')
                if isinstance(used, bool) or not isinstance(used, (int, float)) or not math.isfinite(used) or used < 0:
                    raise HTTPException(502, '上游额度百分比无效。')
                try:
                    parsed = datetime.fromisoformat(reset.replace('Z', '+00:00'))
                    if parsed.tzinfo is None:
                        raise ValueError()
                except (AttributeError, TypeError, ValueError):
                    raise HTTPException(502, '上游重置时间无效。')
                windows[key] = {
                    'used_percent': used,
                    'remaining_percent': max(0, 100 - used),
                    'resets_at': reset,
                    'window_stats': window.get('window_stats'),
                }
            return {'updated_at': data.get('updated_at'), **windows,
                    'reset_credits': await self.fetch_reset_credits()}

    async def fetch_reset_credits(self):
        # This GET only inspects cards. Never call the redeem endpoint here.
        try:
            for attempt in range(2):
                response = await self.client.get(
                    '/api/v1/admin/accounts/%s/claude/reset-credits' % self.account_id,
                    headers={'Authorization': 'Bearer ' + self.token}, timeout=10.0,
                )
                if response.status_code == 401 and attempt == 0:
                    await self.login()
                    continue
                if response.status_code == 404:
                    raise HTTPException(502, '上游暂不支持重置卡查询，请确认 Sub2API 版本。')
                if response.status_code == 403:
                    raise HTTPException(403, '当前查询账号没有查看重置卡的权限。')
                data = self.unpack(response, stage='重置卡查询')
                count, items = data.get('available_count'), data.get('credits')
                if type(count) is not int or count < 0 or not isinstance(items, list):
                    raise ValueError()
                credits = []
                for item in items:
                    if not isinstance(item, dict):
                        raise ValueError()
                    remaining = item.get('resets_left')
                    if type(remaining) is not int or remaining < 0:
                        raise ValueError()
                    expires_at = item.get('expires_at')
                    if expires_at is not None:
                        parsed = datetime.fromisoformat(expires_at.replace('Z', '+00:00'))
                        if parsed.tzinfo is None:
                            raise ValueError()
                    label = item.get('label')
                    if remaining:
                        credits.append({'label': label if isinstance(label, str) else '重置卡',
                                        'resets_left': remaining, 'expires_at': expires_at})
                credits.sort(key=lambda c: datetime.fromisoformat(c['expires_at'].replace('Z', '+00:00'))
                             if c['expires_at'] else datetime.max.replace(tzinfo=timezone.utc))
                return {'available_count': count, 'credits': credits, 'error': None}
        except HTTPException as exc:
            error = exc.detail
        except httpx.RequestError:
            error = '重置卡查询暂时失败，请稍后刷新。'
        except (ValueError, TypeError, AttributeError, OverflowError):
            error = '上游返回的重置卡数据无效。'
        # Usage remains usable even when this optional query is unavailable.
        return {'available_count': None, 'credits': [], 'error': error}

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
