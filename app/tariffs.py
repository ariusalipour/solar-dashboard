"""Estimated energy costs from uniformly distributed interval readings.

Rates are pence; returned monetary amounts are pounds. Meter intervals cannot
reveal precisely when energy was consumed, so splitting them assumes a uniform
flow. Standing charges apply once per local date touched by the query, including
partial days. Unknown tariff periods yield null monetary totals, never free use.
"""
from datetime import date, datetime, time, timedelta, timezone as dt_timezone
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

UTC = dt_timezone.utc
RATE_FIELDS = ("peak_rate", "offpeak_rate", "export_rate", "standing_charge")


def _decimal(value, name):
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        raise ValueError(f"{name} must be a finite nonnegative number") from None
    if not result.is_finite() or result < 0:
        raise ValueError(f"{name} must be a finite nonnegative number")
    return result


def _zone(value):
    try:
        return ZoneInfo(value)
    except (ZoneInfoNotFoundError, TypeError, ValueError):
        raise ValueError("timezone must be a valid IANA timezone") from None


def _aware(value):
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
        if not isinstance(result, datetime) or result.tzinfo is None or result.utcoffset() is None:
            raise ValueError()
        return result.astimezone(UTC)
    except (TypeError, ValueError, AttributeError):
        raise ValueError("timestamps must be timezone-aware ISO datetimes") from None


def validate_tariff(tariff):
    """Validate and return a JSON-safe normalized tariff; rates are pence."""
    if not isinstance(tariff, dict):
        raise ValueError("tariff must be an object")
    fields = (*RATE_FIELDS, "effective_from", "timezone", "offpeak_start", "offpeak_end")
    result = {key: tariff[key] for key in fields if key in tariff}
    try:
        effective = date.fromisoformat(result["effective_from"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("effective_from must be YYYY-MM-DD") from None
    result["effective_from"] = effective.isoformat()
    result["timezone"] = result.get("timezone", "Europe/London")
    _zone(result["timezone"])
    for name in RATE_FIELDS:
        if name not in result:
            raise ValueError(f"{name} is required")
        amount = _decimal(result[name], name)
        if amount > 1_000_000:
            raise ValueError(f"{name} must not exceed 1000000 pence")
        result[name] = float(amount)
    for name in ("offpeak_start", "offpeak_end"):
        value = result.get(name)
        try:
            parsed = time.fromisoformat(value)
            if len(value) != 5 or parsed.second or parsed.tzinfo:
                raise ValueError()
        except (TypeError, ValueError):
            raise ValueError(f"{name} must be HH:MM") from None
        result[name] = parsed.strftime("%H:%M")
    if result["offpeak_start"] == result["offpeak_end"]:
        raise ValueError("off-peak start and end must differ")
    return result


def rate_at(instant, tariff):
    """Return (peak/offpeak, Decimal pence/kWh) at an aware instant."""
    local = _aware(instant).astimezone(_zone(tariff.get("timezone", "Europe/London")))
    clock = local.strftime("%H:%M")
    start, end = tariff["offpeak_start"], tariff["offpeak_end"]
    offpeak = start <= clock < end if start < end else clock >= start or clock < end
    label = "offpeak" if offpeak else "peak"
    return label, _decimal(tariff[f"{label}_rate"], f"{label}_rate")


def calculate_costs(intervals, tariffs, start, end, timezone="Europe/London"):
    """Clip non-overlapping readings to [start,end) and estimate tariff costs.

    Effective dates use the query timezone. All tariff schedules must use that
    same timezone. Repeated DST minutes are charged twice; skipped minutes have
    no elapsed time. No tariff is backdated before its effective date.
    """
    start, end = _aware(start), _aware(end)
    if end <= start:
        raise ValueError("end must be after start")
    zone = _zone(timezone)
    plans = sorted((validate_tariff(t) for t in tariffs), key=lambda t: t["effective_from"])
    if len({p["effective_from"] for p in plans}) != len(plans):
        raise ValueError("tariff effective dates must be unique")
    if any(p["timezone"] != timezone for p in plans):
        raise ValueError("tariffs must use the query timezone")

    def plan_for(day):
        return next((p for p in reversed(plans) if p["effective_from"] <= day.isoformat()), None)

    totals = {key: Decimal(0) for key in ("import_kwh", "export_kwh", "peak_kwh", "offpeak_kwh", "peak_cost", "offpeak_cost", "import_cost", "export_credit", "standing_charge", "unpriced_import_kwh")}
    unknown = False
    day = start.astimezone(zone).date()
    last_day = (end - timedelta(microseconds=1)).astimezone(zone).date()
    while day <= last_day:
        plan = plan_for(day)
        if plan is None:
            unknown = True
        else:
            totals["standing_charge"] += _decimal(plan["standing_charge"], "standing_charge") / 100
        day += timedelta(days=1)

    readings = []
    for interval in intervals:
        a, b = _aware(interval["start"]), _aware(interval["end"])
        if b <= a:
            raise ValueError("interval end must be after start")
        imported = _decimal(interval["import_kwh"], "import_kwh")
        exported = _decimal(interval["export_kwh"], "export_kwh")
        readings.append((a, b, imported, exported))
    readings.sort(key=lambda r: r[0])
    if any(right[0] < left[1] for left, right in zip(readings, readings[1:])):
        raise ValueError("energy intervals must not overlap")
    for a, b, imported, exported in readings:
        cursor, stop = max(a, start), min(b, end)
        duration = Decimal(str((b - a).total_seconds()))
        while cursor < stop:
            boundary = cursor.replace(second=0, microsecond=0) + timedelta(minutes=1)
            next_time = min(boundary, stop)
            fraction = Decimal(str((next_time - cursor).total_seconds())) / duration
            imp, exp = imported * fraction, exported * fraction
            totals["import_kwh"] += imp
            totals["export_kwh"] += exp
            plan = plan_for(cursor.astimezone(zone).date())
            if plan is None:
                totals["unpriced_import_kwh"] += imp
                unknown = True
            else:
                label, rate = rate_at(cursor, plan)
                totals[f"{label}_kwh"] += imp
                totals[f"{label}_cost"] += imp * rate / 100
                totals["import_cost"] += imp * rate / 100
                totals["export_credit"] += exp * _decimal(plan["export_rate"], "export_rate") / 100
            cursor = next_time
    totals["net_cost"] = totals["import_cost"] + totals["standing_charge"] - totals["export_credit"]
    money = {"peak_cost", "offpeak_cost", "import_cost", "export_credit", "standing_charge", "net_cost"}
    return {key: None if unknown and key in money else float(value) for key, value in totals.items()}
