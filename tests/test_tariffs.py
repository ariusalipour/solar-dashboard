from datetime import datetime

import pytest

from app.tariffs import calculate_costs, rate_at, validate_tariff


def tariff(**overrides):
    return dict(effective_from="2026-01-01", peak_rate=30, offpeak_rate=10,
                offpeak_start="23:00", offpeak_end="06:00", export_rate=15,
                standing_charge=50, **overrides)


def reading(start, end, imported, exported=0):
    return dict(start=start, end=end, import_kwh=imported, export_kwh=exported)


def test_overnight_and_boundary():
    t = tariff()
    assert rate_at(datetime.fromisoformat("2026-01-02T05:59:00+00:00"), t)[0] == "offpeak"
    assert rate_at(datetime.fromisoformat("2026-01-02T06:00:00+00:00"), t)[0] == "peak"
    start, end = "2026-01-01T22:00:00Z", "2026-01-02T07:00:00Z"
    result = calculate_costs([reading(start, end, 9, 2)], [t], start, end)
    assert result["offpeak_kwh"] == pytest.approx(7)
    assert result["peak_kwh"] == pytest.approx(2)
    assert result["peak_cost"] == pytest.approx(.6)
    assert result["offpeak_cost"] == pytest.approx(.7)
    assert result["peak_cost"] + result["offpeak_cost"] == pytest.approx(result["import_cost"])
    assert result["net_cost"] == pytest.approx(2)


def test_effective_date_and_partial_range():
    first = tariff()
    second = {**first, "effective_from": "2026-01-02", "offpeak_rate": 20}
    start, end = "2026-01-01T23:00:00Z", "2026-01-02T01:00:00Z"
    result = calculate_costs([reading(start, end, 4)], [second, first], "2026-01-01T23:30:00Z", end)
    assert result["import_kwh"] == pytest.approx(3)
    assert result["import_cost"] == pytest.approx(.5)
    assert result["standing_charge"] == 1


@pytest.mark.parametrize("start,end,hours,offpeak", [
    ("2026-03-29T00:00:00Z", "2026-03-29T23:00:00Z", 23, 6),
    ("2026-10-24T23:00:00Z", "2026-10-26T00:00:00Z", 25, 8),
])
def test_dst_elapsed_energy_and_local_day(start, end, hours, offpeak):
    result = calculate_costs([reading(start, end, hours)], [tariff()], start, end)
    assert result["import_kwh"] == pytest.approx(hours)
    assert result["offpeak_kwh"] == pytest.approx(offpeak)
    assert result["standing_charge"] == .5


def test_unknown_tariff_never_looks_free():
    start, end = "2025-12-31T23:00:00Z", "2026-01-01T01:00:00Z"
    result = calculate_costs([reading(start, end, 2)], [tariff()], start, end)
    assert result["unpriced_import_kwh"] == pytest.approx(1)
    assert result["net_cost"] is None
    assert result["peak_cost"] is None
    assert result["offpeak_cost"] is None
    empty = calculate_costs([], [], start, end)
    assert empty["import_cost"] is None


def test_validation_normalizes_known_fields_and_bounds_prices():
    result = validate_tariff({**tariff(), "api_key": "must-not-persist", "peak_rate": "30.25"})
    assert "api_key" not in result
    assert result["peak_rate"] == 30.25
    assert result["timezone"] == "Europe/London"
    with pytest.raises(ValueError):
        validate_tariff({**tariff(), "peak_rate": "1e999"})
    with pytest.raises(ValueError):
        validate_tariff([("effective_from", "2026-01-01")])


@pytest.mark.parametrize("field,value", [("peak_rate", -1), ("export_rate", "NaN"), ("standing_charge", float("inf")), ("offpeak_start", "25:00"), ("offpeak_end", "23:00"), ("effective_from", "bad"), ("timezone", "Unknown/Zone")])
def test_invalid_tariffs(field, value):
    with pytest.raises(ValueError):
        validate_tariff({**tariff(), field: value})


def test_negative_energy_naive_time_and_overlap():
    start, end = "2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z"
    for readings in ([reading(start, end, -1)], [reading(start, end, 1)] * 2):
        with pytest.raises(ValueError):
            calculate_costs(readings, [tariff()], start, end)
    with pytest.raises(ValueError):
        calculate_costs([], [], datetime(2026, 1, 1), end)
