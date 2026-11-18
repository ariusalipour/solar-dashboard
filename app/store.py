"""Private SQLite persistence. All timestamps are UTC; no cloud credentials in responses."""
import json
import math
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .foxess import parse_time, utc_string

CHART_FIELDS = frozenset(('pvPower', 'loadsPower', 'gridConsumptionPower', 'feedinPower',
                          'batChargePower', 'batDischargePower', 'SoC'))


class Store:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / 'solar.sqlite3'
        with self.connect() as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS samples (time TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS tariffs (effective_from TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS tariff_revisions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    effective_from TEXT NOT NULL,
                    data TEXT NOT NULL,
                    changed_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS calls (time TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS chart_points (
                    time TEXT NOT NULL,
                    variable TEXT NOT NULL,
                    value REAL NOT NULL,
                    PRIMARY KEY (time, variable)
                );
            ''')
        # Backfill and its marker commit together. Concurrent application starts
        # serialize here, and an interrupted migration safely retries in full.
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if not db.execute("SELECT 1 FROM config WHERE key='chart_points_migrated_v1'").fetchone():
                for row in db.execute('SELECT data FROM samples ORDER BY time'):
                    self._add_chart_points(db, json.loads(row['data']))
                db.execute("INSERT INTO config VALUES ('chart_points_migrated_v1', 'true')")
        os.chmod(self.path, 0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            yield db
            db.commit()
        finally:
            db.close()

    def get(self, key, default=None):
        with self.connect() as db:
            row = db.execute('SELECT value FROM config WHERE key=?', (key,)).fetchone()
        return json.loads(row['value']) if row else default

    def set(self, key, value):
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO config VALUES (?,?)', (key, json.dumps(value)))

    def tariffs(self):
        with self.connect() as db:
            return [json.loads(r['data']) for r in db.execute('SELECT data FROM tariffs ORDER BY effective_from')]

    def save_tariff(self, tariff):
        with self.connect() as db:
            db.execute('INSERT INTO tariffs VALUES (?,?)', (tariff['effective_from'], json.dumps(tariff)))

    def correct_tariff(self, tariff):
        """Atomically retain the previous tariff and replace its same-date values.

        Returns False without creating a revision if the tariff does not exist.
        Corrections intentionally recalculate historical estimates from this date.
        """
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            previous = db.execute('SELECT data FROM tariffs WHERE effective_from=?',
                                  (tariff['effective_from'],)).fetchone()
            if previous is None:
                return False
            changed_at = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
            db.execute('INSERT INTO tariff_revisions (effective_from, data, changed_at) VALUES (?,?,?)',
                       (tariff['effective_from'], previous['data'], changed_at))
            db.execute('UPDATE tariffs SET data=? WHERE effective_from=?',
                       (json.dumps(tariff), tariff['effective_from']))
        return True

    def first_sample_at(self):
        with self.connect() as db:
            return db.execute('SELECT min(time) FROM samples').fetchone()[0]

    def add_sample(self, sample):
        with self.connect() as db:
            db.execute('INSERT OR IGNORE INTO samples VALUES (?,?)', (sample['time'], json.dumps(sample)))
            # Counter timestamps can repeat while power/battery timestamps move.
            # Keep every field reading independently of the metering snapshot.
            self._add_chart_points(db, sample)

    @staticmethod
    def _add_chart_points(db, sample):
        for variable in CHART_FIELDS:
            value = sample.get('values', {}).get(variable)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                continue
            try:
                stamp = utc_string(parse_time(sample.get('times', {}).get(variable)))
            except (ValueError, TypeError, OverflowError, OSError):
                continue
            db.execute('INSERT OR REPLACE INTO chart_points VALUES (?,?,?)', (stamp, variable, value))

    def chart_series(self, start, end):
        """Return sparse packets grouped by authoritative field UTC timestamps.

        Bounds are inclusive start/exclusive end. Missing fields are absent,
        rather than null: chart consumers should build each line independently.
        """
        with self.connect() as db:
            rows = db.execute('SELECT time,variable,value FROM chart_points WHERE time>=? AND time<? ORDER BY time,variable',
                              (start, end)).fetchall()
        packets = []
        for row in rows:
            if not packets or packets[-1]['time'] != row['time']:
                packets.append({'time': row['time'], 'values': {}, 'times': {}})
            packets[-1]['values'][row['variable']] = row['value']
            packets[-1]['times'][row['variable']] = row['time']
        return packets

    def samples(self, start, end):
        with self.connect() as db:
            # One preceding measurement establishes the first interval of the day.
            rows = db.execute('SELECT data FROM samples WHERE time>=? AND time<=? ORDER BY time', (start, end)).fetchall()
            prev = db.execute('SELECT data FROM samples WHERE time<? ORDER BY time DESC LIMIT 1', (start,)).fetchone()
        return ([json.loads(prev['data'])] if prev else []) + [json.loads(r['data']) for r in rows]

    def latest(self):
        with self.connect() as db:
            row = db.execute('SELECT data FROM samples ORDER BY time DESC LIMIT 1').fetchone()
        return json.loads(row['data']) if row else None

    def register_call(self, now):
        """Reserve quota before every attempted cloud call, across restarts."""
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute("DELETE FROM calls WHERE time < strftime('%Y-%m-%dT%H:%M:%SZ', ?, '-25 hours')", (now,))
            count = db.execute("SELECT count(*) FROM calls WHERE time >= strftime('%Y-%m-%dT%H:%M:%SZ', ?, '-24 hours')", (now,)).fetchone()[0]
            if count >= 1000:
                raise RuntimeError('Local daily API budget reached; collection will resume automatically.')
            db.execute('INSERT INTO calls VALUES (?)', (now,))

    def call_count(self, start):
        with self.connect() as db:
            return db.execute('SELECT count(*) FROM calls WHERE time>=?', (start,)).fetchone()[0]
