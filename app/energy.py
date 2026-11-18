"""Derive metered energy deltas without silently bridging resets or outages."""
from datetime import timedelta
from .foxess import parse_time


def build_intervals(samples):
    intervals = []
    for before, after in zip(samples, samples[1:]):
        start, end = parse_time(before['time']), parse_time(after['time'])
        seconds = (end - start).total_seconds()
        if seconds <= 0 or seconds > 1200:
            continue
        deltas = {}
        for key in ('gridConsumption', 'feedin'):
            try:
                # Do not pair stale counters with newer timestamps from other variables.
                if any(abs((parse_time(s['times'][key]) - parse_time(s['time'])).total_seconds()) > 60 for s in (before, after)):
                    break
                delta = after['values'][key] - before['values'][key]
                # Negative/reset counters and implausible >100 kW household rates are gaps.
                if delta < 0 or delta > seconds / 3600 * 100:
                    break
                deltas[key] = delta
            except (KeyError, TypeError, ValueError):
                break
        if len(deltas) == 2:
            intervals.append({'start': before['time'], 'end': after['time'],
                              'import_kwh': deltas['gridConsumption'], 'export_kwh': deltas['feedin']})
    return intervals


def coverage_seconds(intervals, start, end):
    return sum(max(0, (min(parse_time(i['end']), end) - max(parse_time(i['start']), start)).total_seconds()) for i in intervals)
