"""Private SQLite persistence. All timestamps are UTC; no cloud credentials in responses."""
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


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
            ''')
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
