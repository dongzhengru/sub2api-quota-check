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
            if request.url.path.endswith('/quota/refresh'):
                return httpx.Response(200, json={'code': 0, 'data': {'rate_limit_reset_credits': {'available_count': 0, 'credits': []}, 'credits': {'balance': '0'}}})
            assert request.url.params['timezone'] == 'Asia/Shanghai'
            return httpx.Response(200, json=payload())
        async with httpx.AsyncClient(base_url='https://test', transport=httpx.MockTransport(handler)) as client:
            service = UsageService(client, 'test', 'test')
            results = await asyncio.gather(*(service.get() for _ in range(20)))
            assert len(calls) == 3
            assert sum(not r['cache']['hit'] for r in results) == 1
            assert results[0]['five_hour']['remaining_percent'] == 93
            assert results[0]['seven_day']['remaining_percent'] == 74
            results[0]['five_hour']['remaining_percent'] = -1
            assert (await service.get())['five_hour']['remaining_percent'] == 93
            service.cache_deadline = 0
            assert not (await service.get())['cache']['hit']
            assert len(calls) == 5
    asyncio.run(run())


def test_unauthorized_relogin_once():
    async def run():
        counts = {'login': 0, 'usage': 0}
        async def handler(request):
            if request.url.path.endswith('/login'):
                counts['login'] += 1
                return httpx.Response(200, json={'code': 0, 'data': {'access_token': 'test'}})
            if request.url.path.endswith('/quota/refresh'):
                return httpx.Response(200, json={'code': 0, 'data': {'rate_limit_reset_credits': {'available_count': 0, 'credits': []}, 'credits': {'balance': '0'}}})
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


@pytest.mark.parametrize('five_hour', ['missing', None, {'utilization': 'x'}])
def test_pro_account_without_five_hour_window(five_hour):
    async def run():
        async def handler(request):
            if request.url.path.endswith('/login'):
                return httpx.Response(200, json={'code': 0, 'data': {'access_token': 'test', 'expires_in': 86400}})
            if request.url.path.endswith('/quota/refresh'):
                return httpx.Response(200, json={'code': 0, 'data': {'rate_limit_reset_credits': {'available_count': 0, 'credits': []}, 'credits': {'balance': '0'}}})
            body = payload()
            if five_hour == 'missing':
                del body['data']['five_hour']
            else:
                body['data']['five_hour'] = five_hour
            return httpx.Response(200, json=body)
        async with httpx.AsyncClient(base_url='https://test', transport=httpx.MockTransport(handler)) as client:
            service = UsageService(client, 'test', 'test')
            data = await service.get()
            assert data['five_hour'] is None
            assert data['seven_day']['remaining_percent'] == 74
    asyncio.run(run())


def test_five_hour_window_switch():
    async def handler(request):
        if request.url.path.endswith('/login'):
            return httpx.Response(200, json={'code': 0, 'data': {'access_token': 'test', 'expires_in': 86400}})
        if request.url.path.endswith('/quota/refresh'):
            return httpx.Response(200, json={'code': 0, 'data': {'rate_limit_reset_credits': {'available_count': 0, 'credits': []}, 'credits': {'balance': '0'}}})
        return httpx.Response(200, json=payload())

    async def run():
        async with httpx.AsyncClient(base_url='https://test', transport=httpx.MockTransport(handler)) as client:
            data = await UsageService(client, 'test', 'test', show_five_hour=False).get()
            assert data['five_hour'] is None
            assert data['seven_day']['remaining_percent'] == 74
            assert (await UsageService(client, 'test', 'test').get())['five_hour']['remaining_percent'] == 93
    asyncio.run(run())

    for value, expected in (('false', False), ('OFF', False), ('0', False), ('no', False),
                            ('true', True), ('Yes', True), ('', True)):
        with patch.dict('os.environ', {'SUB2API_SHOW_FIVE_HOUR': value}):
            with TestClient(app):
                assert app.state.usage.show_five_hour is expected


def test_missing_seven_day_window_fails():
    async def run():
        async def handler(request):
            body = payload()
            del body['data']['seven_day']
            return httpx.Response(200, json=body)
        async with httpx.AsyncClient(base_url='https://test', transport=httpx.MockTransport(handler)) as client:
            service = UsageService(client, 'test', 'test')
            service.token, service.token_deadline = 'test', float('inf')
            with pytest.raises(HTTPException) as exc:
                await service.get()
            assert exc.value.status_code == 502
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


def test_user_breakdown_pagination_and_relogin():
    from datetime import date
    async def run():
        limits = []
        attempts = 0
        async def handler(request):
            nonlocal attempts
            if request.url.path.endswith('/login'):
                return httpx.Response(200, json={'code': 0, 'data': {'access_token': 'renewed'}})
            attempts += 1
            if attempts == 1:
                return httpx.Response(401)
            assert request.headers['authorization'] == 'Bearer renewed'
            assert request.url.params['start_date'] == '2026-11-01'
            assert request.url.params['end_date'] == '2026-11-06'
            assert request.url.params['timezone'] == 'Asia/Shanghai'
            assert request.url.params['sort_by'] == 'total_tokens'
            limit = int(request.url.params['limit'])
            limits.append(limit)
            return httpx.Response(200, json={'code': 0, 'data': {
                'users': [{'user_id': i} for i in range(55)][:limit]}})
        async with httpx.AsyncClient(base_url='https://test', transport=httpx.MockTransport(handler)) as client:
            service = UsageService(client, 'test', 'test')
            service.token, service.token_deadline = 'expired', float('inf')
            pages = [await service.user_breakdown(date(2026, 11, 1), date(2026, 11, 6), p, 20)
                     for p in (1, 2, 3)]
            assert limits == [21, 41, 61]
            assert [p['has_more'] for p in pages] == [True, True, False]
            assert [u['user_id'] for p in pages for u in p['users']] == list(range(55))
    asyncio.run(run())


def test_user_breakdown_validation():
    with TestClient(app) as client:
        for params in ({'start_date': 'bad', 'end_date': '2026-11-06'},
                       {'start_date': '2026-11-01', 'end_date': '2026-11-06', 'page': 0},
                       {'start_date': '2026-11-01', 'end_date': '2026-11-06', 'page_size': 101}):
            assert client.get('/api/user-breakdown', params=params).status_code == 422
        assert client.get('/api/user-breakdown', params={
            'start_date': '2026-11-07', 'end_date': '2026-11-06'}).status_code == 400
        assert client.get('/api/config').json()['timezone'] == app.state.usage.tz


def test_token_activity_directory_filter_and_cache():
    from datetime import date
    async def run():
        calls = []
        async def handler(request):
            if request.url.path.endswith('/login'):
                return httpx.Response(200, json={'code': 0, 'data': {'access_token': 'test'}})
            calls.append((request.url.path, dict(request.url.params)))
            if request.url.path == '/api/v1/admin/users':
                page = int(request.url.params['page'])
                items = ([{'id': 3, 'email': 'system-check@sub2api.com', 'username': '', 'balance': 0},
                          {'id': 1, 'email': 'dzr@sub2api.com', 'username': '董政儒', 'balance': 1000}]
                         if page == 1 else [{'id': 2, 'email': 'zzy@sub2api.com', 'username': ''}])
                return httpx.Response(200, json={'code': 0, 'data': {'items': items, 'pages': 2}})
            assert request.url.path == '/api/v1/admin/dashboard/snapshot-v2'
            assert request.url.params['granularity'] == 'day'
            assert request.url.params['include_trend'] == 'true'
            assert request.url.params['timezone'] == 'Asia/Shanghai'
            row = {'date': request.url.params['end_date'], 'requests': 3, 'input_tokens': 10,
                   'output_tokens': 5, 'cache_creation_tokens': 0, 'cache_read_tokens': 7,
                   'total_tokens': 22, 'cost': 0.5, 'actual_cost': 0.5}
            return httpx.Response(200, json={'code': 0, 'data': {'trend': [row]}})
        async with httpx.AsyncClient(base_url='https://test', transport=httpx.MockTransport(handler)) as client:
            service = UsageService(client, 'test', 'test')
            result = await service.token_activity()
            assert result['users'] == [{'email': 'dzr@sub2api.com', 'username': '董政儒'},
                                       {'email': 'zzy@sub2api.com', 'username': ''}]
            assert (date.fromisoformat(result['end_date']) - date.fromisoformat(result['start_date'])).days == 364
            assert result['user'] is None and result['trend'][0]['total_tokens'] == 22
            snapshots = [params for path, params in calls if path.endswith('snapshot-v2')]
            assert 'user_id' not in snapshots[0]
            await service.token_activity()
            assert len([p for p, _ in calls if p.endswith('snapshot-v2')]) == 1
            filtered = await service.token_activity('dzr@sub2api.com')
            snapshots = [params for path, params in calls if path.endswith('snapshot-v2')]
            assert snapshots[-1]['user_id'] == '1' and filtered['user'] == 'dzr@sub2api.com'
            assert len([p for p, _ in calls if p == '/api/v1/admin/users']) == 2
            result['trend'][0]['total_tokens'] = -1
            assert (await service.token_activity())['trend'][0]['total_tokens'] == 22
            with pytest.raises(HTTPException) as exc:
                await service.token_activity('missing@x.com')
            assert exc.value.status_code == 404
    asyncio.run(run())


@pytest.mark.parametrize('trend', [
    None,
    [{'date': '2000-01-01', 'requests': 1, 'input_tokens': 1, 'output_tokens': 1,
      'cache_creation_tokens': 0, 'cache_read_tokens': 0, 'total_tokens': 2, 'cost': 0, 'actual_cost': 0}],
    [{'date': '2026-11-06', 'requests': 1, 'input_tokens': 1, 'output_tokens': 1,
      'cache_creation_tokens': 0, 'cache_read_tokens': 0, 'total_tokens': -2, 'cost': 0, 'actual_cost': 0}],
])
def test_token_activity_invalid_trend_not_cached(trend):
    async def run():
        async def handler(request):
            return httpx.Response(200, json={'code': 0, 'data': {'trend': trend}})
        async with httpx.AsyncClient(base_url='https://test', transport=httpx.MockTransport(handler)) as client:
            service = UsageService(client, 'test', 'test')
            service.token, service.token_deadline = 'test', float('inf')
            service.users_cached, service.users_deadline = [], float('inf')
            with pytest.raises(HTTPException) as exc:
                await service.token_activity()
            assert exc.value.status_code == 502
            assert not service.activity_cache
    asyncio.run(run())


def test_token_activity_param_validation():
    with TestClient(app) as client:
        assert client.get('/api/token-activity', params={'user': ''}).status_code == 422
        assert client.get('/api/token-activity', params={'user': 'x' * 255}).status_code == 422



def test_reset_cards_sorted_whitelisted_cached_and_reauthenticated():
    async def run():
        calls = []
        async def handler(request):
            calls.append((request.method, request.url.path))
            if request.url.path.endswith('/login'):
                return httpx.Response(200, json={'code': 0, 'data': {'access_token': 'renewed'}})
            if request.url.path.endswith('/usage'):
                return httpx.Response(200, json=payload())
            assert request.url.path == '/api/v1/admin/openai/accounts/7/quota/refresh'
            if request.headers['authorization'] == 'Bearer old':
                return httpx.Response(401)
            return httpx.Response(200, json={'code': 0, 'data': {
                'rate_limit_reset_credits': {'available_count': 2, 'credits': [
                    {'expires_at': '2026-12-01T00:00:00Z'},
                    {'expires_at': '2026-11-20T08:00:00+08:00'},
                    {'expires_at': None}]},
                'credits': {'balance': '732.871522'}}})
        async with httpx.AsyncClient(base_url='https://test', transport=httpx.MockTransport(handler)) as client:
            service = UsageService(client, 'test', 'test', account_id=7)
            service.token, service.token_deadline = 'old', float('inf')
            result = await service.get()
            cards = result['reset_credits']
            assert cards['available_count'] == 2 and cards['error'] is None
            assert [c['expires_at'] for c in cards['credits']] == ['2026-11-20T08:00:00+08:00', '2026-12-01T00:00:00Z', None]
            assert all(set(c) == {'label', 'resets_left', 'expires_at'} for c in cards['credits'])
            assert all(method == 'POST' or path.endswith('/login') or path.endswith('/usage') for method, path in calls)
            assert len(calls) == 4
            cards['credits'].clear()
            cached = await service.get()
            assert cached['cache']['hit'] and len(cached['reset_credits']['credits']) == 3
            assert len(calls) == 4
    asyncio.run(run())


@pytest.mark.parametrize('status,body,error', [
    (404, {}, '暂不支持'), (403, {}, '权限'), (401, {}, '认证失败'),
    (423, {'code': 'ADMIN_COMPLIANCE_ACK_REQUIRED'}, '合规确认'),
    (200, {'code': 0, 'data': {'available_count': True, 'credits': []}}, '无效'),
    (200, {'code': 0, 'data': {'available_count': 1, 'credits': [
        {'resets_left': 1, 'expires_at': '2026-11-20T08:00:00'}]}}, '无效'),
    (200, {'code': 0, 'data': {'available_count': 1, 'credits': [
        {'resets_left': -1}]}}, '无效'),
    (200, {'code': 0, 'data': {'available_count': 1, 'credits': [None]}}, '无效'),
])
def test_optional_reset_card_failure_does_not_break_usage(status, body, error):
    async def run():
        async def handler(request):
            if request.url.path.endswith('/usage'):
                return httpx.Response(200, json=payload())
            if request.url.path.endswith('/login'):
                return httpx.Response(200, json={'code': 0, 'data': {'access_token': 'new'}})
            return httpx.Response(status, json=body)
        async with httpx.AsyncClient(base_url='https://test', transport=httpx.MockTransport(handler)) as client:
            service = UsageService(client, 'test', 'test')
            service.token, service.token_deadline = 'test', float('inf')
            data = await service.get()
            assert data['five_hour']['remaining_percent'] == 93
            assert data['reset_credits']['available_count'] is None
            assert error in data['reset_credits']['error']
    asyncio.run(run())


@pytest.mark.parametrize('timeout', [False, True])
def test_reset_card_empty_and_network_failure(timeout):
    async def run():
        async def handler(request):
            if request.url.path.endswith('/usage'):
                return httpx.Response(200, json=payload())
            if timeout:
                raise httpx.ReadTimeout('timeout')
            return httpx.Response(200, json={'code': 0, 'data': {'rate_limit_reset_credits': {'available_count': 0, 'credits': []}, 'credits': {'balance': '0'}}})
        async with httpx.AsyncClient(base_url='https://test', transport=httpx.MockTransport(handler)) as client:
            service = UsageService(client, 'test', 'test')
            service.token, service.token_deadline = 'test', float('inf')
            data = await service.get()
            assert data['five_hour']['remaining_percent'] == 93
            assert data['reset_credits']['credits'] == []
            assert bool(data['reset_credits']['error']) == timeout
    asyncio.run(run())
