# Solar

A private home energy dashboard for the official FoxESS Cloud Open API. Runs as a single container with a persistent SQLite database. Public source; private credentials, readings, and tariff configuration.

## What it does

- Solar, household, grid and battery power with the inverter's measurement timestamp.
- A historical power chart for a selected range of up to 31 days.
- Editable peak/off-peak import rates and off-peak start/end times, export rate and daily standing charge. Prices are entered in **pence**, costs displayed in **GBP**.
- Effective-dated tariffs: adding a new tariff preserves earlier rates. Effective dates are unique and existing tariff records are immutable.
- Overnight schedules and UK daylight-saving time (`Europe/London`).
- Separate import cost, export credit, standing charge and net cost, with explicit data coverage.
- Password-protected household access, secure session cookies on HTTPS, same-origin request protection, and server-side cloud credentials.

## Run in Docker

Requires Docker Compose. Copy `.env.example` to `.env` and set a long unique `SOLAR_PASSWORD` and random `SOLAR_SESSION_SECRET`. Never commit `.env` or `data/`.

```sh
mkdir -p data
# Alternatively set SOLAR_UID / SOLAR_GID to your non-root host user IDs in .env.
# The default container runs as uid 10001; the bind mount must be writable by it.
sudo chown 10001:10001 data
docker compose up -d --build
```

The port binds to **127.0.0.1:3050**. Put HTTPS and private access in front of it (for example Cloudflare Tunnel plus Access). Set `SOLAR_PUBLIC_ORIGIN` to the exact HTTPS origin. Do not expose the container port directly. For local HTTP use set that variable to `http://127.0.0.1:3050` so cookies are usable.

Sign in using the configured household password. Open **Settings**, enter a FoxESS API key, discover/select your inverter, and add your tariff. You do not need to provide your FoxESS password to this application. The API key is stored in the private SQLite volume and is never returned to the browser. It is not encrypted at rest: protect the NAS volume and its backups as credentials.

Obtain a key at the [FoxESS developer portal](https://developer-eu.foxesscloud.com/apiKeys). See the [official Open API documentation](https://www.foxesscloud.com/public/i18n/en/OpenApiDocument.html).

## Accuracy and coverage

This is an **estimate from inverter readings**, not an electricity bill or a replacement for your supplier's revenue meter.

Energy is derived from differences in cumulative `gridConsumption` and `feedin` counters. Intervals are only accepted when both counters have aligned timestamps, are nondecreasing, and the interval is at most 20 minutes. Resets, missing counters, long outages and implausible household readings become coverage gaps. We do not invent missing energy or silently integrate instantaneous power readings. Some installations may not expose the required counters; verify compatibility after connecting.

Energy is distributed uniformly within each measured interval when it crosses a tariff boundary. Costs cover **accepted intervals only**. Check the coverage percentage before interpreting a total; uncovered consumption is excluded. A full standing charge applies once per local calendar date selected, including today. Cost totals are unavailable if any selected date has no tariff. Solar production must not be confused with inverter AC generation, which can include battery discharge.

Collection starts after connection. The first interval requires two distinct cloud measurements. Historical backfill is not implemented in this first version; the dashboard retains readings it collects going forward. One inverter is supported per database; changing devices is blocked to prevent mixing households' histories.

The collector polls every five minutes (288 scheduled calls/day), with a persistent local cap of 1,000 attempts in a rolling 24 hours including setup calls. FoxESS documents 1,440 calls/day per inverter, but other apps using the account can consume the shared upstream allowance. There is no guaranteed cloud refresh interval; stale readings are marked after 15 minutes. The browser refreshes the local database view, not the upstream API.

## Local development

Python 3.13 recommended:

```sh
python -m venv .venv
# Activate the environment for your shell, then:
python -m pip install -r requirements-dev.txt
python -m pytest -q
# Local-only development, never set SOLAR_DEV in a deployed container:
SOLAR_DEV=true SOLAR_PUBLIC_ORIGIN=http://127.0.0.1:3050 uvicorn app.main:app --host 127.0.0.1 --port 3050
```

PowerShell equivalent for development: `$env:SOLAR_DEV='true'`, then run `.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 3050`. The origin defaults to that local URL.

## Operations

- `GET /api/health` is a deliberately minimal unauthenticated container health probe.
- Use a single Uvicorn worker: the collector and throttle are per process.
- Back up the complete private `data/` directory with SQLite's backup API or while the container is stopped. A live file copy of just the `.sqlite3` file can miss WAL transactions.
- Rotate the household password or session secret in `.env`, then recreate the container; this invalidates existing sessions.
- `docker compose logs --tail=50` contains access/status logs, never intentionally logs cloud keys or response bodies.
- To upgrade, update the checkout and run `docker compose up -d --build`. Preserve `.env` and `data/`.

No inverter control endpoints are implemented. Scheduling, battery control, multi-inverter aggregation, supplier integration and historical backfill can be added separately.

## Licence

MIT. This project is independent of FoxESS and is not endorsed by the manufacturer.
