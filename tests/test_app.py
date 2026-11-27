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
            assert request.url.params['sort_by'] == 'actual_cost'
            limit = int(request.url.params['limit'])
            limits.append(limit)
            return httpx.Response(200, json={'code': 0, 'data': {
                'users': [{'user_id': i, 'actual_cost': 55 - i, 'total_tokens': i} for i in range(55)][:limit]}})
        async with httpx.AsyncClient(base_url='https://test', transport=httpx.MockTransport(handler)) as client:
            service = UsageService(client, 'test', 'test')
            service.token, service.token_deadline = 'expired', float('inf')
            pages = [await service.user_breakdown(date(2026, 11, 1), date(2026, 11, 6), p, 20)
                     for p in (1, 2, 3)]
            assert limits == [21, 41, 61]
            assert [p['has_more'] for p in pages] == [True, True, False]
            assert [u['user_id'] for p in pages for u in p['users']] == list(range(55))
            assert [u['actual_cost'] for p in pages for u in p['users']] == list(range(55, 0, -1))
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


def test_direct_usage_auto_calibration_and_estimation(tmp_path):
    from datetime import date, datetime
    from zoneinfo import ZoneInfo
    from direct_usage import DirectUsageStore

    tz = ZoneInfo('Asia/Shanghai')
    store = DirectUsageStore(tmp_path / 'snapshots.db', account_id=1, tz='Asia/Shanghai')
    resets = '2026-11-30T00:00:00+08:00'

    def ts(h, m=0, day=27):
        return datetime(2026, 11, day, h, m, tzinfo=tz).timestamp()

    # Pure Sub2API blocks on Nov 26: 100% 7d quota = $200 ($2 per 1%, 500k tokens per $1).
    store.record_snapshot(ts=ts(9, 0, day=26), seven_day_used=10.0, seven_day_resets_at=resets,
                          sub2_day_tokens=0, sub2_day_cost=0.0)
    store.record_snapshot(ts=ts(10, 0, day=26), seven_day_used=14.0, seven_day_resets_at=resets,
                          sub2_day_tokens=4_000_000, sub2_day_cost=8.0)
    store.record_snapshot(ts=ts(11, 0, day=26), seven_day_used=18.0, seven_day_resets_at=resets,
                          sub2_day_tokens=8_000_000, sub2_day_cost=16.0)
    store.record_snapshot(ts=ts(12, 0, day=26), seven_day_used=22.0, seven_day_resets_at=resets,
                          sub2_day_tokens=12_000_000, sub2_day_cost=24.0)

    # Pure Sub2API day should yield 0 direct usage and auto-calibrated basis = $200,
    # while still keeping a visible 0-usage direct row so users see monitoring is active.
    day1 = store.estimate_range(date(2026, 11, 26), date(2026, 11, 26))
    assert day1['status'] == 'zero'
    assert day1['calibration_mode'] == 'auto'
    assert day1['seven_day_cost_basis'] == pytest.approx(200.0, rel=1e-3)
    assert day1['row']['email'] == '账号直登（估算）'
    assert day1['row']['total_tokens'] == 0
    assert day1['row']['cost'] == 0.0

    # Nov 27 mixed day: total +10% (= $20), Sub2API spent $6 (3M tokens) => direct = $14 (7M tokens, 7%).
    store.record_snapshot(ts=ts(9, 0, day=27), seven_day_used=22.0, seven_day_resets_at=resets,
                          sub2_day_tokens=0, sub2_day_cost=0.0,
                          sub2_prev_day_tokens=12_000_000, sub2_prev_day_cost=24.0)
    store.record_snapshot(ts=ts(12, 0, day=27), seven_day_used=32.0, seven_day_resets_at=resets,
                          sub2_day_tokens=3_000_000, sub2_day_cost=6.0,
                          sub2_prev_day_tokens=12_000_000, sub2_prev_day_cost=24.0)

    day2 = store.estimate_range(date(2026, 11, 27), date(2026, 11, 27))
    assert day2['status'] == 'ok'
    assert day2['direct_cost'] == pytest.approx(14.0, abs=0.01)
    assert day2['direct_tokens'] == 7_000_000
    assert day2['direct_quota_percent'] == pytest.approx(7.0, abs=0.05)
    assert day2['row']['email'] == '账号直登（估算）'
    assert day2['row']['is_estimated'] is True
    assert day2['row']['requests'] is None
    assert day2['row']['total_tokens'] == 7_000_000
    assert day2['row']['cost'] == pytest.approx(14.0, abs=0.01)

    # Nov 28 direct-only day: Sub2API = 0, total +5% (= $10) => falls back to global 500k tokens/$ -> 5M tokens.
    store.record_snapshot(ts=ts(9, 0, day=28), seven_day_used=32.0, seven_day_resets_at=resets,
                          sub2_day_tokens=0, sub2_day_cost=0.0,
                          sub2_prev_day_tokens=3_000_000, sub2_prev_day_cost=6.0)
    store.record_snapshot(ts=ts(11, 0, day=28), seven_day_used=37.0, seven_day_resets_at=resets,
                          sub2_day_tokens=0, sub2_day_cost=0.0,
                          sub2_prev_day_tokens=3_000_000, sub2_prev_day_cost=6.0)
    day3 = store.estimate_range(date(2026, 11, 28), date(2026, 11, 28))
    assert day3['status'] == 'ok'
    assert day3['direct_cost'] == pytest.approx(10.0, abs=0.01)
    assert day3['direct_tokens'] == 5_000_000


def test_direct_usage_manual_override_credits_midnight_and_reset(tmp_path):
    from datetime import date, datetime
    from zoneinfo import ZoneInfo
    from direct_usage import DirectUsageStore

    tz = ZoneInfo('Asia/Shanghai')
    store = DirectUsageStore(tmp_path / 'manual.db', account_id=1, tz='Asia/Shanghai',
                             seven_day_cost_override=100.0, credit_cost_ratio=1.0)
    resets1 = '2026-11-28T00:00:00+08:00'
    resets2 = '2026-12-05T00:00:00+08:00'

    def ts(day, h, m=0):
        return datetime(2026, 11, day, h, m, tzinfo=tz).timestamp()

    # Cross midnight: 23:55 -> 00:05 (+2% quota = $2, credits drop 100 -> 95 = $5; Sub2API spent $1 prev + $1 curr = $2).
    store.record_snapshot(ts=ts(26, 23, 55), seven_day_used=50.0, seven_day_resets_at=resets1,
                          credits_balance=100.0, sub2_day_tokens=2_000_000, sub2_day_cost=10.0)
    store.record_snapshot(ts=ts(27, 0, 5), seven_day_used=52.0, seven_day_resets_at=resets1,
                          credits_balance=95.0, sub2_day_tokens=200_000, sub2_day_cost=1.0,
                          sub2_prev_day_tokens=2_200_000, sub2_prev_day_cost=11.0)
    # Credit top-up (95 -> 150) should not be counted as consumption; window reset (52% -> 4%) uses new window 4%.
    store.record_snapshot(ts=ts(27, 1, 5), seven_day_used=4.0, seven_day_resets_at=resets2,
                          credits_balance=150.0, sub2_day_tokens=400_000, sub2_day_cost=2.0,
                          sub2_prev_day_tokens=2_200_000, sub2_prev_day_cost=11.0)

    both = store.estimate_range(date(2026, 11, 26), date(2026, 11, 27))
    assert both['calibration_mode'] == 'manual'
    assert both['seven_day_cost_basis'] == 100.0
    # Total account cost = (2% + 4%) * $1 + $5 credits = $11; Sub2API covered = $1 + $1 + $1 = $3 => direct = $8.
    assert both['credits_delta'] == pytest.approx(5.0, abs=1e-4)
    assert both['direct_cost'] == pytest.approx(8.0, abs=0.01)
    assert both['direct_tokens'] == 1_600_000


def test_direct_usage_pending_calibration_and_ranking_merge_pagination(tmp_path):
    from datetime import date, datetime
    from zoneinfo import ZoneInfo
    from direct_usage import DirectUsageStore

    tz = ZoneInfo('Asia/Shanghai')
    store = DirectUsageStore(tmp_path / 'rank.db', account_id=1, tz='Asia/Shanghai',
                             seven_day_cost_override=200.0)
    resets = '2026-11-30T00:00:00+08:00'
    t1 = datetime(2026, 11, 27, 10, 0, tzinfo=tz).timestamp()
    t2 = datetime(2026, 11, 27, 11, 0, tzinfo=tz).timestamp()
    # +10% (= $20), Sub2API spent $10 (10M tokens -> 1M tokens/$) => direct = $10 (10M tokens).
    store.record_snapshot(ts=t1, seven_day_used=10.0, seven_day_resets_at=resets,
                          sub2_day_tokens=0, sub2_day_cost=0.0)
    store.record_snapshot(ts=t2, seven_day_used=20.0, seven_day_resets_at=resets,
                          sub2_day_tokens=10_000_000, sub2_day_cost=10.0)

    async def run():
        async def handler(request):
            limit = int(request.url.params['limit'])
            users = [
                {'user_id': 1, 'email': 'heavy@example.com', 'requests': 10, 'input_tokens': 1,
                 'output_tokens': 1, 'cache_tokens': 1, 'total_tokens': 25_000_000, 'cost': 25.0, 'actual_cost': 25.0},
                {'user_id': 2, 'email': 'mid@example.com', 'requests': 5, 'input_tokens': 1,
                 'output_tokens': 1, 'cache_tokens': 1, 'total_tokens': 5_000_000, 'cost': 5.0, 'actual_cost': 5.0},
                {'user_id': 3, 'email': 'light@example.com', 'requests': 2, 'input_tokens': 1,
                 'output_tokens': 1, 'cache_tokens': 1, 'total_tokens': 1_000_000, 'cost': 1.0, 'actual_cost': 1.0},
            ]
            return httpx.Response(200, json={'code': 0, 'data': {'users': users[:limit]}})

        async with httpx.AsyncClient(base_url='https://test', transport=httpx.MockTransport(handler)) as client:
            service = UsageService(client, 'test', 'test', store=store)
            service.token, service.token_deadline = 'test', float('inf')
            page1 = await service.user_breakdown(date(2026, 11, 27), date(2026, 11, 27), 1, 2)
            page2 = await service.user_breakdown(date(2026, 11, 27), date(2026, 11, 27), 2, 2)
            assert page1['has_more'] is True
            assert page2['has_more'] is False
            assert [u['email'] for u in page1['users']] == ['heavy@example.com', '账号直登（估算）']
            assert [u['email'] for u in page2['users']] == ['mid@example.com', 'light@example.com']
            assert page1['users'][1]['total_tokens'] == 10_000_000
            assert page1['users'][1]['actual_cost'] == pytest.approx(10.0, abs=0.01)
            assert page1['direct_estimate']['status'] == 'ok'

            # Historical date without snapshots does not inject a fake direct row.
            old = await service.user_breakdown(date(2026, 11, 1), date(2026, 11, 1), 1, 20)
            assert all(not u.get('is_estimated') for u in old['users'])
            assert old['direct_estimate']['status'] == 'no_data'

    asyncio.run(run())


def test_fetch_records_snapshot_and_throttles(tmp_path):
    from direct_usage import DirectUsageStore

    store = DirectUsageStore(tmp_path / 'fetch.db', account_id=1, tz='Asia/Shanghai')
    trend_calls = 0

    async def run():
        nonlocal trend_calls
        async def handler(request):
            nonlocal trend_calls
            if request.url.path.endswith('/login'):
                return httpx.Response(200, json={'code': 0, 'data': {'access_token': 'test', 'expires_in': 86400}})
            if request.url.path.endswith('/quota/refresh'):
                return httpx.Response(200, json={'code': 0, 'data': {
                    'rate_limit_reset_credits': {'available_count': 0, 'credits': []},
                    'credits': {'balance': '50.5'}}})
            if request.url.path.endswith('/snapshot-v2'):
                trend_calls += 1
                end_date = request.url.params['end_date']
                return httpx.Response(200, json={'code': 0, 'data': {'trend': [
                    {'date': end_date, 'requests': 4, 'input_tokens': 100, 'output_tokens': 50,
                     'cache_creation_tokens': 0, 'cache_read_tokens': 50, 'total_tokens': 200,
                     'cost': 1.25, 'actual_cost': 1.25},
                ]}})
            return httpx.Response(200, json=payload())

        async with httpx.AsyncClient(base_url='https://test', transport=httpx.MockTransport(handler)) as client:
            service = UsageService(client, 'test', 'test', store=store, snapshot_min_interval=300)
            await service.get()
            assert trend_calls == 1
            assert store.last_snapshot_ts() is not None
            # Expire quota cache, but snapshot throttle still prevents duplicate snapshot within 300s.
            service.cache_deadline = 0
            await service.get()
            assert trend_calls == 1

    asyncio.run(run())


def test_quota_proxy_mode_records_snapshots_and_merges_direct_usage(tmp_path):
    from datetime import date, datetime
    from zoneinfo import ZoneInfo
    from direct_usage import DirectUsageStore

    tz = ZoneInfo('Asia/Shanghai')
    store = DirectUsageStore(tmp_path / 'proxy.db', account_id=1, tz='Asia/Shanghai',
                             seven_day_cost_override=200.0)
    resets = '2026-12-03T00:00:00+08:00'
    today = datetime.now(tz).date()
    # Seed an earlier snapshot today so the live proxy fetch forms an interval with direct usage.
    earlier_ts = datetime(today.year, today.month, today.day, 0, 1, tzinfo=tz).timestamp()
    store.record_snapshot(ts=earlier_ts, seven_day_used=10.0, seven_day_resets_at=resets,
                          sub2_day_tokens=0, sub2_day_cost=0.0)

    async def run():
        async def handler(request):
            if request.url.path == '/api/quota/api/usage':
                return httpx.Response(200, json={
                    'updated_at': '2026-11-27T15:00:00+08:00',
                    'five_hour': None,
                    'seven_day': {'used_percent': 20.0, 'remaining_percent': 80.0, 'resets_at': resets},
                    'reset_credits': {'available_count': 0, 'credits': [], 'error': None},
                    'credits': {'has_credits': True, 'unlimited': False, 'balance': '100.0'},
                    'timezone': 'Asia/Shanghai',
                })
            if request.url.path == '/api/quota/api/token-activity':
                return httpx.Response(200, json={
                    'start_date': today.isoformat(),
                    'end_date': today.isoformat(),
                    'timezone': 'Asia/Shanghai',
                    'user': None,
                    'users': [{'email': 'a@example.com', 'username': 'A'}],
                    'trend': [{
                        'date': today.isoformat(), 'requests': 5, 'input_tokens': 1_000_000,
                        'output_tokens': 500_000, 'cache_creation_tokens': 0, 'cache_read_tokens': 500_000,
                        'total_tokens': 2_000_000, 'cost': 4.0, 'actual_cost': 4.0,
                    }],
                })
            if request.url.path == '/api/quota/api/user-breakdown':
                return httpx.Response(200, json={
                    'start_date': today.isoformat(), 'end_date': today.isoformat(),
                    'timezone': 'Asia/Shanghai', 'page': 1, 'page_size': 100, 'has_more': False,
                    'users': [
                        {'user_id': 1, 'email': 'a@example.com', 'requests': 5, 'input_tokens': 1_000_000,
                         'output_tokens': 500_000, 'cache_tokens': 500_000, 'total_tokens': 2_000_000, 'cost': 4.0},
                        # Any upstream estimated row should be stripped before local merge.
                        {'user_id': 0, 'email': '账号直登（估算）', 'is_estimated': True, 'total_tokens': 1, 'cost': 0.1},
                    ],
                })
            raise AssertionError(f'Unexpected path: {request.url.path}')

        async with httpx.AsyncClient(base_url='https://gateway.zhengru.top/api/quota/',
                                     transport=httpx.MockTransport(handler)) as client:
            service = UsageService(
                client, None, None, store=store, snapshot_min_interval=0,
                proxy_url='https://gateway.zhengru.top/api/quota',
            )
            usage = await service.get()
            assert usage['seven_day']['remaining_percent'] == 80.0
            ranking = await service.user_breakdown(today, today, 1, 20)
            # +10% (= $20) minus Sub2API $4 => $16 direct, at 500k tokens/$ => 8M direct tokens (ranks #1).
            assert [u['email'] for u in ranking['users']] == ['账号直登（估算）', 'a@example.com']
            assert ranking['users'][0]['total_tokens'] == 8_000_000
            assert ranking['users'][0]['cost'] == pytest.approx(16.0, abs=0.01)
            assert ranking['direct_estimate']['status'] == 'ok'
            activity = await service.token_activity()
            assert activity['users'][0]['email'] == 'a@example.com'

    asyncio.run(run())


def test_window_stats_snapshots_handle_resets_at_jitter_without_extra_trend_call(tmp_path):
    from datetime import date, datetime
    from zoneinfo import ZoneInfo
    from direct_usage import DirectUsageStore

    tz = ZoneInfo('Asia/Shanghai')
    store = DirectUsageStore(tmp_path / 'wstats.db', account_id=1, tz='Asia/Shanghai')

    def ts(day, h, m=0):
        return datetime(2026, 11, day, h, m, tzinfo=tz).timestamp()

    # Pure Sub2API blocks with real-world resets_at jitter (2m32s drift) — must NOT trigger false reset.
    # 100% 7d quota = $700 ($7 per 1%, ~800k tokens/$).
    store.record_snapshot(ts=ts(26, 10, 0), seven_day_used=40.0,
                          seven_day_resets_at='2026-12-02T22:10:29+08:00',
                          window_sub2_tokens=200_000_000, window_sub2_cost=250.0)
    store.record_snapshot(ts=ts(26, 11, 0), seven_day_used=44.0,
                          seven_day_resets_at='2026-12-02T22:07:57+08:00',
                          window_sub2_tokens=222_400_000, window_sub2_cost=278.0)
    store.record_snapshot(ts=ts(26, 12, 0), seven_day_used=48.0,
                          seven_day_resets_at='2026-12-02T22:09:10+08:00',
                          window_sub2_tokens=244_800_000, window_sub2_cost=306.0)

    # Mixed day on Nov 27: +10% (= $70), Sub2API window_stats grew by $28 (22.4M tokens) => direct = $42 (33.6M tokens, 6%).
    store.record_snapshot(ts=ts(27, 10, 0), seven_day_used=48.0,
                          seven_day_resets_at='2026-12-02T22:08:00+08:00',
                          window_sub2_tokens=244_800_000, window_sub2_cost=306.0)
    store.record_snapshot(ts=ts(27, 12, 0), seven_day_used=58.0,
                          seven_day_resets_at='2026-12-02T22:07:30+08:00',
                          window_sub2_tokens=267_200_000, window_sub2_cost=334.0)

    est = store.estimate_range(date(2026, 11, 27), date(2026, 11, 27))
    assert est['status'] == 'ok'
    assert est['calibration_mode'] == 'auto'
    assert est['seven_day_cost_basis'] == pytest.approx(700.0, rel=1e-3)
    assert est['direct_cost'] == pytest.approx(42.0, abs=0.05)
    assert est['direct_tokens'] == 33_600_000
    assert est['direct_quota_percent'] == pytest.approx(6.0, abs=0.05)

    # Also verify fetch() with window_stats skips /api/token-activity completely in proxy mode.
    async def run():
        calls = []
        async def handler(request):
            calls.append(request.url.path)
            return httpx.Response(200, json={
                'updated_at': '2026-11-27T15:26:45+08:00',
                'five_hour': None,
                'seven_day': {
                    'used_percent': 57, 'remaining_percent': 43,
                    'resets_at': '2026-12-02T22:07:57+08:00',
                    'window_stats': {
                        'requests': 3995, 'tokens': 318634339,
                        'cost': 370.69758577, 'standard_cost': 370.69758577, 'user_cost': 429.62759225,
                    },
                },
                'reset_credits': {'available_count': 3, 'credits': [], 'error': None},
                'credits': {'has_credits': True, 'unlimited': False, 'balance': '648.4777550000'},
                'timezone': 'Asia/Shanghai',
            })

        store2 = DirectUsageStore(tmp_path / 'wstats_fetch.db', account_id=1, tz='Asia/Shanghai')
        async with httpx.AsyncClient(base_url='https://gateway.zhengru.top/api/quota/',
                                     transport=httpx.MockTransport(handler)) as client:
            service = UsageService(client, None, None, store=store2, snapshot_min_interval=0,
                                   proxy_url='https://gateway.zhengru.top/api/quota')
            await service.get()
            assert calls == ['/api/quota/api/usage']
            assert store2.last_snapshot_ts() is not None

    asyncio.run(run())


def test_window_floor_prevents_underestimation_and_cold_start_direct_tokens(tmp_path):
    from datetime import date, datetime
    from zoneinfo import ZoneInfo
    from direct_usage import DirectUsageStore

    tz = ZoneInfo('Asia/Shanghai')
    store = DirectUsageStore(tmp_path / 'floor.db', account_id=1, tz='Asia/Shanghai')
    resets = '2026-12-02T22:08:00+08:00'

    def ts(h, m=0):
        return datetime(2026, 11, 27, h, m, tzinfo=tz).timestamp()

    # Mirrors real production window_stats where 60% already has $387.55 of Sub2API spend
    # (floor = 387.55 / 0.61 ≈ $635.33), while the newly observed +3% window has mixed direct usage
    # ($16.14 Sub2API across +3%, which naively calibrates to ~$427 and wrongly zeroes direct cost).
    store.record_snapshot(ts=ts(15, 29), seven_day_used=57.0, seven_day_resets_at=resets,
                          window_sub2_tokens=319_984_532, window_sub2_cost=371.4085)
    store.record_snapshot(ts=ts(15, 53), seven_day_used=58.0, seven_day_resets_at=resets,
                          window_sub2_tokens=325_939_724, window_sub2_cost=376.0057)
    store.record_snapshot(ts=ts(16, 7), seven_day_used=59.0, seven_day_resets_at=resets,
                          window_sub2_tokens=327_107_828, window_sub2_cost=379.9499)
    store.record_snapshot(ts=ts(16, 29), seven_day_used=60.0, seven_day_resets_at=resets,
                          window_sub2_tokens=328_243_924, window_sub2_cost=384.5970)
    store.record_snapshot(ts=ts(16, 48), seven_day_used=60.0, seven_day_resets_at=resets,
                          window_sub2_tokens=329_320_517, window_sub2_cost=387.5521)

    est = store.estimate_range(date(2026, 11, 27), date(2026, 11, 27))
    assert est['calibration_mode'] == 'auto'
    # The tightest lower bound comes from 57% ($371.4085 / 0.58 ≈ $640.36) before direct usage diluted Sub2API share.
    assert est['seven_day_cost_basis'] == pytest.approx(371.4085 / 0.58, rel=1e-3)
    assert est['status'] == 'ok'
    assert est['direct_cost'] > 3.0
    assert est['direct_tokens'] > 1_000_000

    # Cold-start direct-only interval (Sub2API delta = 0) still estimates cost & tokens from window_stats.
    store2 = DirectUsageStore(tmp_path / 'cold_direct.db', account_id=1, tz='Asia/Shanghai')
    store2.record_snapshot(ts=ts(17, 0), seven_day_used=60.0, seven_day_resets_at=resets,
                           window_sub2_tokens=300_000_000, window_sub2_cost=366.0)
    store2.record_snapshot(ts=ts(17, 15), seven_day_used=61.0, seven_day_resets_at=resets,
                           window_sub2_tokens=300_000_000, window_sub2_cost=366.0)
    cold = store2.estimate_range(date(2026, 11, 27), date(2026, 11, 27))
    assert cold['status'] == 'ok'
    assert cold['calibration_mode'] == 'auto'
    assert cold['seven_day_cost_basis'] == pytest.approx(366.0 / 0.61, rel=1e-3)
    assert cold['direct_cost'] == pytest.approx(6.0, abs=0.05)
    assert cold['direct_tokens'] > 4_000_000


def test_direct_row_stays_visible_on_page_one_without_dropping_users(tmp_path):
    from datetime import date, datetime
    from zoneinfo import ZoneInfo
    from direct_usage import DirectUsageStore

    tz = ZoneInfo('Asia/Shanghai')
    store = DirectUsageStore(tmp_path / 'page1.db', account_id=1, tz='Asia/Shanghai')
    resets = '2026-12-02T22:08:00+08:00'
    # Single snapshot -> status='collecting', actual_cost=None (would previously fall off page 1).
    store.record_snapshot(ts=datetime(2026, 11, 27, 16, 0, tzinfo=tz).timestamp(),
                          seven_day_used=60.0, seven_day_resets_at=resets,
                          window_sub2_tokens=300_000_000, window_sub2_cost=366.0)

    async def run():
        async def handler(request):
            limit = int(request.url.params['limit'])
            users = [
                {'user_id': i + 1, 'email': f'u{i + 1}@example.com', 'requests': 1,
                 'input_tokens': 1, 'output_tokens': 1, 'cache_tokens': 0,
                 'total_tokens': 2, 'cost': float(100 - i), 'actual_cost': float(100 - i)}
                for i in range(5)
            ]
            return httpx.Response(200, json={'code': 0, 'data': {'users': users[:limit]}})

        async with httpx.AsyncClient(base_url='https://test', transport=httpx.MockTransport(handler)) as client:
            service = UsageService(client, 'test', 'test', store=store)
            service.token, service.token_deadline = 'test', float('inf')
            p1 = await service.user_breakdown(date(2026, 11, 27), date(2026, 11, 27), 1, 3)
            p2 = await service.user_breakdown(date(2026, 11, 27), date(2026, 11, 27), 2, 3)
            assert [u['email'] for u in p1['users']] == ['u1@example.com', 'u2@example.com', '账号直登（估算）']
            assert [u['email'] for u in p2['users']] == ['u3@example.com', 'u4@example.com', 'u5@example.com']
            assert p1['has_more'] is True
            assert p2['has_more'] is False

    asyncio.run(run())
