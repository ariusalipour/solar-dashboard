"""The production frontend is served locally under the existing CSP."""
import re

import pytest
from fastapi.testclient import TestClient
from app.main import WEB, create_app
from app.store import Store


@pytest.mark.skipif(not (WEB / 'index.html').is_file(), reason='Run npm run build for frontend delivery checks')
def test_built_frontend_and_assets_are_served_with_same_origin_policy(tmp_path, monkeypatch):
    monkeypatch.setenv('SOLAR_DEV','true')
    monkeypatch.delenv('SOLAR_PASSWORD',raising=False)
    monkeypatch.setenv('SOLAR_AUTH_MODE','password')
    with TestClient(create_app(Store(tmp_path),collect=False)) as client:
        page=client.get('/')
        assert page.status_code == 200
        assert page.headers['cache-control'] == 'no-cache'
        assert "script-src 'self'" in page.headers['content-security-policy']
        assets=re.findall(r'(?:src|href)="(/assets/[^\"]+)"',page.text)
        assert assets
        assert 'https://' not in page.text
        for asset in assets:
            assert client.get(asset).status_code == 200
        assert client.get('/theme-init.js').status_code == 200
        assert client.get('/assets/licenses.md').status_code == 200
