"""Read-only official FoxESS Open API client. Never logs tokens or response bodies."""
import hashlib
import json
import math
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

BASE = 'https://www.foxesscloud.com'
VARIABLES = ['pvPower', 'loadsPower', 'gridConsumptionPower', 'feedinPower', 'SoC',
             'batChargePower', 'batDischargePower', 'gridConsumption', 'feedin',
             'PVEnergyTotal', 'generation', 'invTemperation']


def utc_string(value=None):
    return (value or datetime.now(timezone.utc)).astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def parse_time(value):
    if isinstance(value, (float, int)):
        return datetime.fromtimestamp(value / 1000 if value > 100000000000 else value, timezone.utc)
    if not isinstance(value, str):
        raise ValueError('Missing measurement time')
    # V1 documents inverter-local time with a zone name and numeric offset.
    # Accept ISO plus Java-style '2026-07-01 13:00:00 BST+0100'.
    value = re.sub(r'\s+[A-Za-z]+(?=[+-]\d{2}:?\d{2}$)', '', value.strip())
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Measurement time has no timezone offset')
    return parsed.astimezone(timezone.utc)


class FoxError(Exception):
    pass


class FoxClient:
    def __init__(self, store):
        self.store = store

    def request(self, path, body, api_key):
        self.store.register_call(utc_string())
        stamp = str(int(time.time() * 1000))
        signature = hashlib.md5(f'{path}\r\n{api_key}\r\n{stamp}'.encode()).hexdigest()
        request = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers={
            'Content-Type': 'application/json', 'token': api_key, 'timestamp': stamp,
            'signature': signature, 'lang': 'en', 'User-Agent': 'SolarDashboard/0.1 (home energy monitor)',
        }, method='POST')
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                result = json.load(response)
        except (urllib.error.URLError, TimeoutError, ValueError):
            raise FoxError('FoxESS could not be reached or returned an invalid response. Retrying at the next scheduled poll.') from None
        if not isinstance(result, dict) or result.get('errno') != 0:
            code = result.get('errno', 'unknown') if isinstance(result, dict) else 'unknown'
            raise FoxError(f'FoxESS rejected the request (code {code}). Check your API key and device access.')
        return result.get('result')

    def devices(self, api_key):
        result = self.request('/op/v0/device/list', {'currentPage': 1, 'pageSize': 100}, api_key)
        if isinstance(result, dict):
            result = result.get('data', result.get('devices', []))
        return [{'sn': str(d.get('deviceSN') or d.get('sn') or ''),
                 'name': str(d.get('deviceType') or d.get('stationName') or 'FoxESS inverter')}
                for d in (result or []) if isinstance(d, dict) and (d.get('deviceSN') or d.get('sn'))]

    def poll(self, key, sn):
        result = self.request('/op/v1/device/real/query', {'sns': [sn], 'variables': VARIABLES}, key)
        if not isinstance(result, list) or not result:
            raise FoxError('No readings returned for this inverter.')
        device = next((d for d in result if (d.get('deviceSN') or d.get('sn')) == sn), None)
        if not device:
            raise FoxError('The selected inverter was not returned by FoxESS.')
        values, times = {}, {}
        for row in device.get('datas', []):
            try:
                value = float(row['value'])
                if not math.isfinite(value):
                    continue
                stamp = parse_time(row.get('time') or device.get('time'))
                if stamp > datetime.now(timezone.utc):
                    continue
                values[row['variable']] = value
                times[row['variable']] = utc_string(stamp)
            except (KeyError, ValueError, TypeError, OverflowError):
                continue
        if not times:
            raise FoxError('FoxESS returned no timestamped measurements. Waiting for the inverter.')
        # Counters must share their measurement time to be costed together.
        counter_times = [times[k] for k in ('gridConsumption', 'feedin') if k in times]
        sample_time = min(counter_times) if counter_times else min(times.values())
        return {'time': sample_time, 'received_at': utc_string(), 'values': values, 'times': times}
