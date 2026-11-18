"""Chart telemetry keeps field timestamps independent of energy counters."""
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.store import Store


def packet(anchor, field_time, **values):
    return {'time': anchor, 'values': {'gridConsumption': 10, 'feedin': 2, **values},
            'times': {'gridConsumption': anchor, 'feedin': anchor,
                      **{key: field_time for key in values}}}


@pytest.fixture
def dashboard(tmp_path, monkeypatch):
    monkeypatch.setenv('SOLAR_AUTH_MODE', 'password')
    monkeypatch.setenv('SOLAR_DEV', 'true')
    monkeypatch.delenv('SOLAR_PASSWORD', raising=False)
    store = Store(tmp_path)
    with TestClient(create_app(store, collect=False)) as client:
        yield client, store


def test_fresh_battery_with_repeated_stale_counters_survives_and_cost_samples_do_not_change(dashboard):
    client, store = dashboard
    anchor = '2026-01-01T23:55:00Z'
    store.add_sample(packet(anchor, '2026-01-02T00:00:00Z', batChargePower=1))
    store.add_sample(packet(anchor, '2026-01-02T00:05:00Z', batChargePower=2))
    data = client.get('/api/dashboard?start=2026-01-02').json()
    assert data['series'] == []  # Backward-compatible counter-anchored series.
    assert [p['time'] for p in data['chart_series']] == ['2026-01-02T00:00:00Z', '2026-01-02T00:05:00Z']
    assert [p['values']['batChargePower'] for p in data['chart_series']] == [1, 2]
    assert data['has_energy_intervals'] is False
    assert len(store.samples('2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z')) == 1


def test_chart_uses_field_bounds_sorts_merges_and_dedupes(dashboard):
    client, store = dashboard
    # Anchor after selection; fields inside it must still be discoverable.
    store.add_sample(packet('2026-01-03T01:00:00Z', '2026-01-02T12:05:00+00:00', pvPower=2))
    store.add_sample(packet('2026-01-02T10:00:00Z', '2026-01-02T12:00:00Z', pvPower=1, batDischargePower=.5))
    store.add_sample(packet('2026-01-02T10:05:00Z', '2026-01-02T12:00:00Z', pvPower=1.5))
    store.add_sample(packet('2026-01-02T10:10:00Z', '2026-01-03T00:00:00Z', pvPower=3))
    data = client.get('/api/dashboard?start=2026-01-02').json()
    points = data['chart_series']
    assert [p['time'] for p in points] == ['2026-01-02T12:00:00Z', '2026-01-02T12:05:00Z']
    assert points[0]['values'] == {'batDischargePower': .5, 'pvPower': 1.5}
    assert points[0]['times'] == {'batDischargePower': '2026-01-02T12:00:00Z', 'pvPower': '2026-01-02T12:00:00Z'}
    assert 'batDischargePower' not in points[1]['values']  # Sparse, never invented nulls.


@pytest.mark.parametrize('day,begin,end,inside', [
    ('2026-03-29', '2026-03-29T00:00:00Z', '2026-03-29T23:00:00Z', ['2026-03-29T00:30:00Z', '2026-03-29T01:30:00Z']),
    ('2026-10-25', '2026-10-24T23:00:00Z', '2026-10-26T00:00:00Z', ['2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z']),
])
def test_uk_dst_bounds_keep_distinct_repeated_hour_instants(dashboard, day, begin, end, inside):
    client, store = dashboard
    for stamp in [begin, *inside, end]:
        store.add_sample(packet('2026-01-01T00:00:00Z', stamp, pvPower=1))
    data = client.get(f'/api/dashboard?start={day}').json()
    assert data['chart_start'] == begin
    assert data['chart_end'] == end
    assert [p['time'] for p in data['chart_series']] == [begin, *inside]


def test_chart_rejects_missing_ambiguous_and_nonfinite_field_data(tmp_path):
    store = Store(tmp_path)
    sample = packet('2026-01-01T00:00:00Z', '2026-01-02T12:00:00Z',
                    pvPower=float('nan'), loadsPower=float('inf'), batChargePower=True,
                    batDischargePower=1, SoC=70, arbitraryVariable=12)
    sample['times']['batDischargePower'] = '2026-01-02 12:00:00'  # No UTC offset.
    del sample['times']['SoC']
    store.add_sample(sample)
    assert store.chart_series('2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z') == []


def legacy_database(directory, samples):
    # Represents a database produced before the chart_points migration existed.
    directory.mkdir()
    with sqlite3.connect(directory / 'solar.sqlite3') as db:
        db.execute('CREATE TABLE samples (time TEXT PRIMARY KEY, data TEXT NOT NULL)')
        db.executemany('INSERT INTO samples VALUES (?,?)', [(s['time'], json.dumps(s)) for s in samples])


def test_existing_database_chart_backfill_runs_once(tmp_path):
    directory = tmp_path / 'legacy'
    sample = packet('2026-01-01T23:55:00Z', '2026-01-02T00:05:00Z', pvPower=1)
    legacy_database(directory, [sample])
    store = Store(directory)
    expected = store.chart_series('2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z')
    assert expected[0]['values']['pvPower'] == 1
    # A second startup must not replace a newer correction with old sample blobs.
    store.add_sample(packet(sample['time'], '2026-01-02T00:05:00Z', pvPower=2))
    reopened = Store(directory)
    assert reopened.chart_series('2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z')[0]['values']['pvPower'] == 2
    assert reopened.get('chart_points_migrated_v1') is True


def test_backfill_and_marker_rollback_together_after_failure(tmp_path, monkeypatch):
    directory = tmp_path / 'legacy'
    samples = [packet(f'2026-01-02T00:0{i}:00Z', f'2026-01-02T00:0{i}:00Z', pvPower=i) for i in (1, 2)]
    legacy_database(directory, samples)
    original = Store._add_chart_points
    count = 0

    def interrupted(db, sample):
        nonlocal count
        count += 1
        if count == 2:
            raise RuntimeError('migration interrupted')
        original(db, sample)

    with monkeypatch.context() as patch:
        patch.setattr(Store, '_add_chart_points', staticmethod(interrupted))
        with pytest.raises(RuntimeError, match='interrupted'):
            Store(directory)
    with sqlite3.connect(directory / 'solar.sqlite3') as db:
        assert db.execute('SELECT count(*) FROM chart_points').fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM config WHERE key='chart_points_migrated_v1'").fetchone()[0] == 0
    recovered = Store(directory)
    assert len(recovered.chart_series('2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z')) == 2
