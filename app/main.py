import asyncio
import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .energy import build_intervals, coverage_seconds
from .foxess import FoxClient, FoxError, parse_time, utc_string
from .store import Store
from .tariffs import calculate_costs, validate_tariff

STATIC = Path(__file__).parent / 'static'
LOCAL_ZONE = ZoneInfo('Europe/London')


def create_app(store=None, collect=True):
    store = store or Store(os.environ.get('SOLAR_DATA_DIR', 'data'))
    password = os.environ.get('SOLAR_PASSWORD', '')
    signing_key = (os.environ.get('SOLAR_SESSION_SECRET') or secrets.token_hex(32)) + password
    dev = os.environ.get('SOLAR_DEV') == 'true'
    origin = os.environ.get('SOLAR_PUBLIC_ORIGIN', 'http://127.0.0.1:3050').rstrip('/')
    client = FoxClient(store)
    failures = {}
    cloud_lock = asyncio.Lock()
    last_cloud_call = 0.0

    async def cloud_call(fn, *args):
        nonlocal last_cloud_call
        async with cloud_lock:
            delay = 1.1 - (time.monotonic() - last_cloud_call)
            if delay > 0:
                await asyncio.sleep(delay)
            try:
                return await asyncio.to_thread(fn, *args)
            finally:
                last_cloud_call = time.monotonic()

    async def collector():
        while True:
            config = store.get('fox', {})
            if config.get('key') and config.get('sn'):
                try:
                    sample = await cloud_call(client.poll, config['key'], config['sn'])
                    store.add_sample(sample)
                    store.set('collector', {'last_success': utc_string(), 'error': None})
                except (FoxError, RuntimeError) as exc:
                    store.set('collector', {'last_attempt': utc_string(), 'error': str(exc)})
                except Exception:
                    # No upstream response bodies or credentials in errors/logs.
                    store.set('collector', {'last_attempt': utc_string(), 'error': 'Collection failed. Retrying at the next poll.'})
            await asyncio.sleep(300)

    @asynccontextmanager
    async def lifespan(app):
        if not password and not dev:
            raise RuntimeError('Set SOLAR_PASSWORD (or SOLAR_DEV=true for local development only).')
        task = asyncio.create_task(collector()) if collect else None
        yield
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    app = FastAPI(title='Solar / home energy', lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store = store

    def authenticated(request):
        if dev and not password:
            return True
        cookie = request.cookies.get('solar_session', '')
        try:
            payload, signature = cookie.split('.')
            expected = hmac.new(signing_key.encode(), payload.encode(), hashlib.sha256).hexdigest()
            return hmac.compare_digest(signature, expected) and int(payload) > time.time()
        except (ValueError, TypeError):
            return False

    @app.middleware('http')
    async def security(request, call_next):
        if request.url.path.startswith('/api/') and request.url.path not in ('/api/health', '/api/session', '/api/login'):
            if not authenticated(request):
                return JSONResponse({'detail': 'Sign in to continue.'}, status_code=401)
        if request.method in ('POST', 'PUT', 'DELETE'):
            # Custom header and same-origin checks prevent cross-site requests,
            # including hostile pages attempting to reach a local development server.
            if request.headers.get('x-solar-request') != '1' or request.headers.get('origin') not in (None, origin):
                return JSONResponse({'detail': 'Invalid request origin.'}, status_code=403)
            try:
                size = int(request.headers.get('content-length', '0') or '0')
            except ValueError:
                return JSONResponse({'detail': 'Invalid content length.'}, status_code=400)
            if size > 16384:
                return JSONResponse({'detail': 'Request is too large.'}, status_code=413)
            # Bound streamed/chunked bodies too, before JSON parsing.
            chunks = bytearray()
            async for chunk in request.stream():
                chunks.extend(chunk)
                if len(chunks) > 16384:
                    return JSONResponse({'detail': 'Request is too large.'}, status_code=413)
            request._body = bytes(chunks)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'same-origin'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        if request.url.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.get('/api/health')
    def health():
        return {'status': 'ok'}

    @app.exception_handler(json.JSONDecodeError)
    async def bad_json(request, exc):
        return JSONResponse({'detail': 'Provide valid JSON.'}, status_code=422)

    @app.get('/api/session')
    def session(request: Request):
        return {'authenticated': authenticated(request)}

    @app.post('/api/login')
    async def login(request: Request):
        ip = request.client.host if request.client else 'unknown'
        now = time.monotonic()
        # Never trust user-supplied forwarding headers for the throttle key.
        recent = [t for t in failures.get(ip, []) if t > now - 300]
        failures[ip] = recent
        if len(recent) >= 8:
            raise HTTPException(429, 'Too many attempts. Try again in five minutes.')
        body = await request.json()
        if not isinstance(body, dict) or not password or not hmac.compare_digest(str(body.get('password', '')).encode(), password.encode()):
            failures[ip].append(now)
            raise HTTPException(401, 'Incorrect password.')
        failures.pop(ip, None)
        payload = str(int(time.time()) + 60 * 60 * 12)
        signature = hmac.new(signing_key.encode(), payload.encode(), hashlib.sha256).hexdigest()
        response = JSONResponse({'authenticated': True})
        response.set_cookie('solar_session', f'{payload}.{signature}', max_age=43200, httponly=True, secure=origin.startswith('https:'), samesite='strict')
        return response

    @app.post('/api/logout')
    def logout():
        response = JSONResponse({'authenticated': False})
        response.delete_cookie('solar_session')
        return response

    @app.get('/api/settings')
    def settings():
        config = store.get('fox', {})
        return {'connected': bool(config.get('key') and config.get('sn')), 'has_key': bool(config.get('key')),
                'selected_sn': config.get('sn'), 'devices': store.get('devices', []),
                'tariffs': store.tariffs(), 'timezone': 'Europe/London'}

    @app.post('/api/connection')
    async def connect(request: Request):
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(422, 'Provide connection settings.')
        previous = store.get('fox', {})
        key = str(body.get('api_key') or previous.get('key') or '').strip()
        if not key or len(key) > 512:
            raise HTTPException(422, 'Enter a valid API key.')
        try:
            devices = await cloud_call(client.devices, key)
            if not devices:
                raise HTTPException(422, 'No inverters are available to this API key.')
            sn = body.get('sn') or previous.get('sn')
            if sn not in [d['sn'] for d in devices]:
                sn = devices[0]['sn'] if len(devices) == 1 else None
            if previous.get('sn') and previous['sn'] != sn:
                raise HTTPException(409, 'This dashboard tracks one inverter. Use a separate data volume to change device without mixing history.')
            store.set('fox', {'key': key, 'sn': sn})
            store.set('devices', devices)
            if sn:
                sample = await cloud_call(client.poll, key, sn)
                store.add_sample(sample)
                store.set('collector', {'last_success': utc_string(), 'error': None})
            return {'connected': bool(sn), 'devices': devices, 'selected_sn': sn}
        except (FoxError, RuntimeError) as exc:
            raise HTTPException(502, str(exc)) from None

    @app.post('/api/tariffs')
    async def add_tariff(request: Request):
        try:
            tariff = validate_tariff(await request.json())
            if tariff['timezone'] != 'Europe/London':
                raise ValueError('This dashboard uses Europe/London tariffs.')
            store.save_tariff(tariff)
        except sqlite3.IntegrityError:
            raise HTTPException(409, 'A tariff already starts on this date. Choose a new effective date to preserve history.') from None
        except (ValueError, TypeError, KeyError) as exc:
            raise HTTPException(422, str(exc)) from None
        return {'tariffs': store.tariffs()}

    @app.get('/api/dashboard')
    def dashboard(start: str | None = None, end: str | None = None):
        today = datetime.now(LOCAL_ZONE).date()
        try:
            first = date.fromisoformat(start) if start else today
            last = date.fromisoformat(end) if end else first
            if last < first or (last - first).days > 30 or last > today:
                raise ValueError()
        except ValueError:
            raise HTTPException(422, 'Choose a date range of up to 31 days, ending today or earlier.') from None
        begin = datetime.combine(first, datetime.min.time(), LOCAL_ZONE).astimezone(timezone.utc)
        finish = min(datetime.combine(last + timedelta(days=1), datetime.min.time(), LOCAL_ZONE).astimezone(timezone.utc), datetime.now(timezone.utc))
        samples = store.samples(utc_string(begin), utc_string(finish))
        intervals = build_intervals(samples)
        costs = calculate_costs(intervals, store.tariffs(), begin, finish)
        covered = coverage_seconds(intervals, begin, finish)
        elapsed = max(1, (finish - begin).total_seconds())
        latest = store.latest()
        age = (datetime.now(timezone.utc) - parse_time(latest['time'])).total_seconds() if latest else None
        return {'start': first.isoformat(), 'end': last.isoformat(), 'timezone': 'Europe/London',
                'latest': latest, 'stale': age is None or age > 900, 'age_seconds': age,
                'costs': costs, 'coverage': {'seconds': covered, 'expected_seconds': elapsed, 'percent': min(100, covered / elapsed * 100)},
                'series': [s for s in samples if s['time'] >= utc_string(begin)],
                'collector': store.get('collector', {}), 'connected': bool(store.get('fox', {}).get('sn')),
                'calls_today': store.call_count(utc_string(datetime.now(timezone.utc) - timedelta(hours=24))),
                'tariff_configured': bool(store.tariffs())}

    app.mount('/static', StaticFiles(directory=STATIC), name='static')

    @app.get('/')
    def index():
        return FileResponse(STATIC / 'index.html')

    return app


app = create_app()
