"""Integration and regression tests; never contact the live FoxESS service."""
import hashlib
import io
import json
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.energy import build_intervals, coverage_seconds
from app.foxess import FoxClient, FoxError, parse_time
from app.main import create_app
from app.store import Store


ORIGIN = 'https://solar.mockachino.app'
HEADERS = {'x-solar-request': '1', 'origin': ORIGIN}
TARIFF = dict(effective_from='2026-01-01', peak_rate=30, offpeak_rate=10,
              offpeak_start='23:00', offpeak_end='06:00', export_rate=15, standing_charge=50)


@pytest.fixture
def session(tmp_path, monkeypatch):
    monkeypatch.setenv('SOLAR_PASSWORD', 'household-test-password')
    monkeypatch.setenv('SOLAR_SESSION_SECRET', 'local-test-signing-secret')
    monkeypatch.setenv('SOLAR_PUBLIC_ORIGIN', ORIGIN)
    monkeypatch.delenv('SOLAR_DEV', raising=False)
    store = Store(tmp_path)
    with TestClient(create_app(store, collect=False), base_url=ORIGIN) as client:
        yield client, store


def login(client):
    return client.post('/api/login', json={'password': 'household-test-password'}, headers=HEADERS)


def sample(stamp, imported=10, exported=2, **kwargs):
    return dict(time=stamp, values={'gridConsumption': imported, 'feedin': exported},
                times={'gridConsumption': stamp, 'feedin': stamp}, **kwargs)


def test_private_data_authentication_and_secure_cookie(session):
    client, store = session
    store.set('fox', {'key': 'API-SECRET-NEVER-RETURN', 'sn': 'SN1'})
    assert client.get('/api/health').status_code == 200
    assert client.get('/api/session').json() == {'authenticated': False}
    assert client.get('/api/settings').status_code == 401
    response = login(client)
    assert response.status_code == 200
    cookie = response.headers['set-cookie']
    assert all(flag in cookie for flag in ('HttpOnly', 'Secure', 'SameSite=strict'))
    assert client.get('/api/session').json() == {'authenticated': True}
    settings = client.get('/api/settings')
    assert settings.json()['has_key'] is True
    assert 'API-SECRET-NEVER-RETURN' not in settings.text
    assert 'household-test-password' not in settings.text
    assert settings.headers['cache-control'] == 'no-store'
    client.cookies.set('solar_session', '9999999999.invalid')
    assert client.get('/api/settings').status_code == 401


def test_login_throttle_and_logout(session):
    client, _ = session
    for _ in range(8):
        assert client.post('/api/login', json={'password': 'wrong'}, headers=HEADERS).status_code == 401
    assert login(client).status_code == 429


def test_logout_ends_browser_session(session):
    client, _ = session
    login(client)
    assert client.post('/api/logout', headers=HEADERS).status_code == 200
    assert client.get('/api/settings').status_code == 401


def test_csrf_and_payload_limit(session):
    client, _ = session
    assert client.post('/api/login', json={}).status_code == 403
    assert client.post('/api/login', json={}, headers={**HEADERS, 'origin': 'https://hostile.test'}).status_code == 403
    assert client.post('/api/login', content='x' * 16385, headers=HEADERS).status_code == 413
    assert client.post('/api/login', content='{}', headers={**HEADERS, 'content-length': 'invalid'}).status_code == 400
    # Do not trust a caller-supplied small length or a chunked body.
    assert client.post('/api/login', content=(b'x' * 9000 for _ in range(2)), headers=HEADERS).status_code == 413


def test_tariff_persistence_duplicate_dates_and_dashboard_costs(session):
    client, store = session
    login(client)
    assert client.post('/api/tariffs', json=TARIFF, headers=HEADERS).status_code == 200
    assert client.post('/api/tariffs', json=TARIFF, headers=HEADERS).status_code == 409
    store.add_sample(sample('2026-01-02T05:55:00Z'))
    store.add_sample(sample('2026-01-02T06:00:00Z', 10.5, 2.1))
    store.add_sample(sample('2026-01-02T06:05:00Z', 11, 2.2))
    result = client.get('/api/dashboard?start=2026-01-02&end=2026-01-02')
    assert result.status_code == 200
    data = result.json()
    assert data['costs']['import_kwh'] == pytest.approx(1)
    assert data['costs']['offpeak_kwh'] == pytest.approx(.5)
    assert data['costs']['peak_kwh'] == pytest.approx(.5)
    assert data['costs']['net_cost'] == pytest.approx(.67)
    assert data['coverage']['seconds'] == 600
    assert data['stale'] is True
    assert client.get('/api/dashboard?start=2026-02-02&end=2026-01-01').status_code == 422


def test_unconfigured_dashboard_shows_unknown_costs(session):
    client, _ = session
    login(client)
    data = client.get('/api/dashboard?start=2026-01-02').json()
    assert data['costs']['net_cost'] is None
    assert data['coverage']['seconds'] == 0
    assert data['connected'] is False


def test_tariff_other_timezone_rejected_without_breaking_dashboard(session):
    client, _ = session
    login(client)
    response = client.post('/api/tariffs', json={**TARIFF, 'timezone': 'America/New_York'}, headers=HEADERS)
    assert response.status_code == 422
    assert client.get('/api/dashboard?start=2026-01-02').status_code == 200


def test_new_key_cannot_clear_pinned_inverter_and_mix_history(session, monkeypatch):
    client, store = session
    login(client)
    store.set('fox', {'key': 'original-secret', 'sn': 'SN1'})
    monkeypatch.setattr(FoxClient, 'devices', lambda *a: [
        {'sn': 'SN2', 'name': 'H1'}, {'sn': 'SN3', 'name': 'H1'}])
    response = client.post('/api/connection', json={'api_key': 'replacement-secret'}, headers=HEADERS)
    assert response.status_code == 409
    assert store.get('fox') == {'key': 'original-secret', 'sn': 'SN1'}
    assert 'original-secret' not in response.text
    assert 'replacement-secret' not in response.text


@pytest.mark.parametrize('path', ['/api/login', '/api/connection', '/api/tariffs'])
def test_malformed_json_is_client_error(session, path):
    client, _ = session
    login(client)
    assert client.post(path, content='{broken', headers={**HEADERS, 'content-type': 'application/json'}).status_code in (400, 422)


def test_energy_resets_outages_stale_and_impossible_counters():
    before = sample('2026-01-02T00:00:00Z')
    good = sample('2026-01-02T00:05:00Z', 10.5, 2.1)
    intervals = build_intervals([before, good])
    assert intervals[0]['import_kwh'] == .5
    assert coverage_seconds(intervals, parse_time('2026-01-02T00:02:00Z'), parse_time('2026-01-02T00:04:00Z')) == 120
    for bad in (sample('2026-01-02T00:05:00Z', 1, 2),
                sample('2026-01-02T00:21:00Z', 11, 2),
                sample('2026-01-02T00:05:00Z', 100, 2)):
        assert build_intervals([before, bad]) == []
    good['times']['feedin'] = '2026-01-01T23:00:00Z'
    assert build_intervals([before, good]) == []


def test_store_preceding_measurement_and_deduplication(tmp_path):
    store = Store(tmp_path)
    for stamp in ('2026-01-01T23:55:00Z', '2026-01-02T00:00:00Z', '2026-01-02T00:05:00Z'):
        store.add_sample(sample(stamp))
    store.add_sample(sample('2026-01-02T00:05:00Z'))
    assert len(store.samples('2026-01-02T00:00:00Z', '2026-01-02T00:05:00Z')) == 3


def test_rolling_quota_budget_survives_reopen_and_midnight(tmp_path):
    store = Store(tmp_path)
    with store.connect() as db:
        db.executemany('INSERT INTO calls VALUES (?)', [('2026-01-01T23:59:00Z',)] * 1000)
    reopened = Store(tmp_path)
    with pytest.raises(RuntimeError, match='budget'):
        reopened.register_call('2026-01-02T00:01:00Z')
    reopened.register_call('2026-01-03T00:00:00Z')
    assert reopened.call_count('2026-01-02T00:00:00Z') == 1


def test_quota_prunes_iso_timestamps(tmp_path):
    store = Store(tmp_path)
    with store.connect() as db:
        db.execute('INSERT INTO calls VALUES (?)', ('2026-01-01T00:00:00Z',))
    store.register_call('2026-01-02T02:00:00Z')
    with store.connect() as db:
        assert db.execute('SELECT count(*) FROM calls').fetchone()[0] == 1


def test_fox_request_signature_shape_and_sanitized_error(tmp_path, monkeypatch):
    client = FoxClient(Store(tmp_path))
    captured = {}

    def upstream(request, timeout):
        captured['request'] = request
        return io.BytesIO(json.dumps({'errno': 0, 'result': {'data': [{'deviceSN': 'SN1', 'deviceType': 'H1'}]}}).encode())

    monkeypatch.setattr('app.foxess.urllib.request.urlopen', upstream)
    assert client.devices('SECRET-KEY') == [{'sn': 'SN1', 'name': 'H1'}]
    request = captured['request']
    expected = hashlib.md5(f"/op/v0/device/list\r\nSECRET-KEY\r\n{request.get_header('Timestamp')}".encode()).hexdigest()
    assert request.get_header('Signature') == expected
    assert json.loads(request.data) == {'currentPage': 1, 'pageSize': 100}
    monkeypatch.setattr('app.foxess.urllib.request.urlopen', lambda *a, **k: io.BytesIO(b'{"errno": 40256, "msg": "SECRET-KEY"}'))
    with pytest.raises(FoxError) as error:
        client.devices('SECRET-KEY')
    assert 'SECRET-KEY' not in str(error.value)


def test_v1_poll_offset_timestamps_and_invalid_readings(tmp_path, monkeypatch):
    client = FoxClient(Store(tmp_path))
    rows = [dict(variable='gridConsumption', value=10, time='2026-07-01 12:00:00+01:00'),
            dict(variable='feedin', value=2, time='2026-07-01 12:00:00+01:00'),
            dict(variable='pvPower', value='NaN', time='2026-07-01 12:00:00+01:00'),
            dict(variable='SoC', value=90, time='2099-01-01T00:00:00Z')]
    monkeypatch.setattr(client, 'request', lambda *a: [{'deviceSN': 'SN1', 'datas': rows}])
    result = client.poll('secret', 'SN1')
    assert result['time'] == '2026-07-01T11:00:00Z'
    assert result['values'] == {'gridConsumption': 10, 'feedin': 2}
    assert 'secret' not in json.dumps(result)


def test_v1_named_zone_offset_and_ambiguous_naive_time():
    assert parse_time('2026-07-01 13:00:00 BST+0100') == datetime(2026, 7, 1, 12, tzinfo=timezone.utc)
    with pytest.raises(ValueError):
        parse_time('2026-07-01 13:00:00')
