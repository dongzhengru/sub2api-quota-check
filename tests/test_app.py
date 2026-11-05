import asyncio
from unittest.mock import patch

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import UsageService, app


def payload():
    return {'code': 0, 'data': {
        'five_hour': {'utilization': 7, 'resets_at': '2026-11-06T01:57:23+08:00'},
        'seven_day': {'utilization': 26, 'resets_at': '2026-11-10T22:44:35+08:00'},
    }}


def test_cache_concurrency_and_expiration():
    async def run():
        calls = []
        async def handler(request):
            calls.append(request)
            await asyncio.sleep(0.01)
            if request.url.path.endswith('/login'):
                return httpx.Response(200, json={'code': 0, 'data': {'access_token': 'test', 'expires_in': 86400}})
            assert request.headers['authorization'] == 'Bearer test'
            assert request.url.params['timezone'] == 'Asia/Shanghai'
            return httpx.Response(200, json=payload())
        async with httpx.AsyncClient(base_url='https://test', transport=httpx.MockTransport(handler)) as client:
            service = UsageService(client, 'test', 'test')
            results = await asyncio.gather(*(service.get() for _ in range(20)))
            assert len(calls) == 2
            assert sum(not r['cache']['hit'] for r in results) == 1
            assert results[0]['five_hour']['remaining_percent'] == 93
            assert results[0]['seven_day']['remaining_percent'] == 74
            results[0]['five_hour']['remaining_percent'] = -1
            assert (await service.get())['five_hour']['remaining_percent'] == 93
            service.cache_deadline = 0
            assert not (await service.get())['cache']['hit']
            assert len(calls) == 3
    asyncio.run(run())


def test_unauthorized_relogin_once():
    async def run():
        counts = {'login': 0, 'usage': 0}
        async def handler(request):
            if request.url.path.endswith('/login'):
                counts['login'] += 1
                return httpx.Response(200, json={'code': 0, 'data': {'access_token': 'test'}})
            counts['usage'] += 1
            return httpx.Response(401) if counts['usage'] == 1 else httpx.Response(200, json=payload())
        async with httpx.AsyncClient(base_url='https://test', transport=httpx.MockTransport(handler)) as client:
            await UsageService(client, 'test', 'test').get()
            assert counts == {'login': 2, 'usage': 2}
    asyncio.run(run())


@pytest.mark.parametrize('status,body,expected', [
    (403, {}, 403), (500, {}, 502), (200, {'code': 0, 'data': {}}, 502),
    (200, {'code': 1}, 502),
])
def test_failed_queries_not_cached(status, body, expected):
    async def run():
        async def handler(request):
            return httpx.Response(status, json=body)
        async with httpx.AsyncClient(base_url='https://test', transport=httpx.MockTransport(handler)) as client:
            service = UsageService(client, 'test', 'test')
            service.token, service.token_deadline = 'test', float('inf')
            with pytest.raises(HTTPException) as exc:
                await service.get()
            assert exc.value.status_code == expected
            assert service.cached is None
    asyncio.run(run())


def test_page_and_api():
    with patch.dict('os.environ', {'SUB2API_EMAIL': '', 'SUB2API_PASSWORD': ''}):
        with TestClient(app) as client:
            response = client.get('/')
            assert response.status_code == 200
            assert '7 天额度' in response.text
            response = client.get('/api/usage')
            assert response.status_code == 503
            assert 'SUB2API_EMAIL' in response.json()['detail']


@pytest.mark.parametrize('body,expected', [
    ({'code': 'ADMIN_COMPLIANCE_ACK_REQUIRED'}, '管理员合规确认'),
    ({'code': 'OTHER_LOCK'}, '额度查询被锁定'),
    ([], '额度查询被锁定'),
])
def test_locked_usage_not_retried_or_cached(body, expected):
    async def run():
        calls = []
        async def handler(request):
            calls.append(request.url.path)
            return httpx.Response(423, json=body)
        async with httpx.AsyncClient(base_url='https://test', transport=httpx.MockTransport(handler)) as client:
            service = UsageService(client, 'test', 'test')
            service.token, service.token_deadline = 'test', float('inf')
            with pytest.raises(HTTPException) as exc:
                await service.get()
            assert exc.value.status_code == 423
            assert expected in exc.value.detail
            assert calls == ['/api/v1/admin/accounts/1/usage']
            assert service.cached is None
    asyncio.run(run())


def test_non_json_locked_login():
    response = httpx.Response(423, text='<html>Locked</html>')
    with pytest.raises(HTTPException) as exc:
        UsageService.unpack(response, stage='登录')
    assert exc.value.status_code == 423
    assert '登录被锁定' in exc.value.detail
