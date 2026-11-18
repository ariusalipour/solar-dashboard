"""Cloudflare Access verification tests using generated RSA keys and local JWKS."""
import io
import json
import threading
import time
from types import SimpleNamespace
from urllib.error import URLError

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app.main import create_app
from app.store import Store


TEAM = 'https://outdoortechnica.cloudflareaccess.com'
AUDIENCE = 'test-solar-application-audience'
ORIGIN = 'https://solar.mockachino.app'
MUTATION_HEADERS = {'origin': ORIGIN, 'x-solar-request': '1'}


@pytest.fixture(scope='module')
def signing_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def token(key, changes=None, remove=None, algorithm='RS256'):
    now = int(time.time())
    claims = dict(iss=TEAM, aud=[AUDIENCE], sub='household-user', email='user@example.test', iat=now - 10, exp=now + 300)
    claims.update(changes or {})
    for field in remove or []:
        claims.pop(field)
    return jwt.encode(claims, key, algorithm=algorithm, headers={'kid': 'test-key'})


@pytest.fixture
def access_session(tmp_path, monkeypatch, signing_key):
    monkeypatch.setenv('SOLAR_AUTH_MODE', 'cloudflare')
    monkeypatch.setenv('SOLAR_CF_TEAM_DOMAIN', TEAM)
    monkeypatch.setenv('SOLAR_CF_AUD', AUDIENCE)
    monkeypatch.setenv('SOLAR_PUBLIC_ORIGIN', ORIGIN)
    monkeypatch.delenv('SOLAR_PASSWORD', raising=False)
    monkeypatch.delenv('SOLAR_DEV', raising=False)
    calls = []
    jwk = jwt.algorithms.RSAAlgorithm.to_jwk(signing_key.public_key(), as_dict=True)
    jwk.update(kid='test-key', alg='RS256', use='sig')

    def open_jwks(request, timeout):
        calls.append((request.full_url, timeout, threading.current_thread().name))
        return io.BytesIO(json.dumps({'keys': [jwk]}).encode())

    monkeypatch.setattr('jwt.jwks_client.urllib.request.build_opener', lambda *a: SimpleNamespace(open=open_jwks))
    store = Store(tmp_path)
    with TestClient(create_app(store, collect=False), base_url=ORIGIN) as client:
        yield client, calls


def test_valid_access_identity_needs_no_password_or_application_cookie(access_session, signing_key):
    client, calls = access_session
    headers = {'Cf-Access-Jwt-Assertion': token(signing_key)}
    session = client.get('/api/session', headers=headers)
    assert session.json() == dict(authenticated=True, auth_mode='cloudflare', login_url='/cdn-cgi/access/login', logout_url='/cdn-cgi/access/logout')
    assert 'set-cookie' not in session.headers
    assert client.get('/api/settings', headers=headers).status_code == 200
    assert len(calls) == 1  # The verifier and JWKS are cached per application.
    assert calls[0][:2] == (TEAM + '/cdn-cgi/access/certs', 5)
    assert 'asyncio-portal' not in calls[0][2]  # JWKS fetch runs off the event loop.


@pytest.mark.parametrize('changes,remove', [
    ({'aud': ['other-app']}, None),
    ({'aud': [AUDIENCE, 'other-app']}, None),
    ({'iss': 'https://other.cloudflareaccess.com'}, None),
    ({'exp': 1}, None),
    ({'iat': int(time.time()) + 3600}, None),
    ({'nbf': int(time.time()) + 3600}, None),
    ({'email': ''}, None),
    ({'email': None}, None),
    ({'sub': ''}, None),
    ({}, ['exp']), ({}, ['iss']), ({}, ['aud']), ({}, ['sub']), ({}, ['iat']),
])
def test_invalid_claims_fail_closed(access_session, signing_key, changes, remove):
    client, _ = access_session
    assertion = token(signing_key, changes=changes, remove=remove)
    response = client.get('/api/settings', headers={'Cf-Access-Jwt-Assertion': assertion})
    assert response.status_code == 401
    assert response.json() == {'detail': 'Cloudflare Access session expired. Sign in again.'}
    assert assertion not in response.text


def test_missing_assertion_email_headers_and_cookies_are_not_identity(access_session, signing_key):
    client, calls = access_session
    client.cookies.set('CF_Authorization', token(signing_key))
    client.cookies.set('solar_session', '9999999999.fake')
    headers = {'Cf-Access-Authenticated-User-Email': 'user@example.test'}
    assert client.get('/api/settings', headers=headers).status_code == 401
    assert client.get('/api/session', headers=headers).json()['authenticated'] is False
    assert client.get('/api/health').json() == {'status': 'ok'}
    assert calls == []


def test_forged_signature_and_unsigned_algorithm_rejected(access_session, signing_key):
    client, calls = access_session
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    for assertion in (token(other_key), token(None, algorithm='none'), 'not.a.jwt'):
        assert client.get('/api/settings', headers={'Cf-Access-Jwt-Assertion': assertion}).status_code == 401


def test_jwks_failure_is_unauthorized_not_server_error(access_session, signing_key, monkeypatch):
    client, _ = access_session

    def offline(*args, **kwargs):
        raise URLError('private upstream failure')

    monkeypatch.setattr('jwt.jwks_client.urllib.request.build_opener', lambda *a: SimpleNamespace(open=offline))
    response = client.get('/api/settings', headers={'Cf-Access-Jwt-Assertion': token(signing_key)})
    assert response.status_code == 401
    assert 'private upstream failure' not in response.text


def test_access_mode_rejects_password_login_and_retains_csrf(access_session, signing_key):
    client, _ = access_session
    assertion = {'Cf-Access-Jwt-Assertion': token(signing_key)}
    response = client.post('/api/login', json={'password': 'anything'}, headers=MUTATION_HEADERS)
    assert response.status_code == 409
    assert 'set-cookie' not in response.headers
    assert client.post('/api/tariffs', json={}, headers=assertion).status_code == 403
    assert client.post('/api/tariffs', json={}, headers={**assertion, **MUTATION_HEADERS, 'origin': 'https://hostile.test'}).status_code == 403
    logout = client.post('/api/logout', headers={**assertion, **MUTATION_HEADERS})
    assert logout.json() == {'authenticated': False, 'logout_url': '/cdn-cgi/access/logout'}
    assert 'Max-Age=0' in logout.headers['set-cookie']


@pytest.mark.parametrize('domain,audience', [
    ('', AUDIENCE), ('http://outdoortechnica.cloudflareaccess.com', AUDIENCE),
    ('https://evil.test', AUDIENCE), ('https://team.cloudflareaccess.com.evil.test', AUDIENCE),
    ('https://team.cloudflareaccess.com/path', AUDIENCE), ('https://user@team.cloudflareaccess.com', AUDIENCE),
    ('https://team.cloudflareaccess.com:443', AUDIENCE), (TEAM, ''), (TEAM, ' '),
])
def test_access_config_fails_startup_without_password_fallback(tmp_path, monkeypatch, domain, audience):
    monkeypatch.setenv('SOLAR_AUTH_MODE', 'cloudflare')
    monkeypatch.setenv('SOLAR_CF_TEAM_DOMAIN', domain)
    monkeypatch.setenv('SOLAR_CF_AUD', audience)
    monkeypatch.setenv('SOLAR_PASSWORD', 'fallback-must-not-work')
    monkeypatch.setenv('SOLAR_DEV', 'true')
    with pytest.raises(RuntimeError):
        with TestClient(create_app(Store(tmp_path), collect=False)):
            pass


def test_unknown_auth_mode_fails_startup(tmp_path, monkeypatch):
    monkeypatch.setenv('SOLAR_AUTH_MODE', 'typo')
    monkeypatch.setenv('SOLAR_DEV', 'true')
    with pytest.raises(RuntimeError):
        with TestClient(create_app(Store(tmp_path), collect=False)):
            pass


def test_valid_legacy_password_cookie_cannot_authenticate_access_mode(tmp_path, monkeypatch):
    monkeypatch.setenv('SOLAR_PUBLIC_ORIGIN', ORIGIN)
    monkeypatch.setenv('SOLAR_PASSWORD', 'previous-household-password')
    monkeypatch.setenv('SOLAR_SESSION_SECRET', 'unchanged-session-secret')
    monkeypatch.setenv('SOLAR_AUTH_MODE', 'password')
    store = Store(tmp_path)
    with TestClient(create_app(store, collect=False), base_url=ORIGIN) as client:
        response = client.post('/api/login', json={'password': 'previous-household-password'}, headers=MUTATION_HEADERS)
        assert response.status_code == 200
        legacy_cookie = client.cookies.get('solar_session')
    monkeypatch.setenv('SOLAR_AUTH_MODE', 'cloudflare')
    monkeypatch.setenv('SOLAR_CF_TEAM_DOMAIN', TEAM)
    monkeypatch.setenv('SOLAR_CF_AUD', AUDIENCE)
    monkeypatch.setenv('SOLAR_DEV', 'true')
    with TestClient(create_app(store, collect=False), base_url=ORIGIN) as client:
        client.cookies.set('solar_session', legacy_cookie)
        assert client.get('/api/settings').status_code == 401
        assert client.get('/api/session').json()['authenticated'] is False
        assert client.post('/api/login', json={'password': 'previous-household-password'}, headers=MUTATION_HEADERS).status_code == 409
