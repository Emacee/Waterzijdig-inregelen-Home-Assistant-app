import os
import sys
from datetime import date

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import balance as b  # noqa: E402
from app import stooklijn as s  # noqa: E402

# 2 jaar maandverbruik met bekende graaddagen: gas = 0,6 m³/dag + 0,12 m³/graaddag
GD = [480, 430, 380, 250, 120, 40, 15, 20, 90, 230, 340, 450] * 2


def _months(a=0.6, bb=0.12, dd=True):
    out, d = [], date(2023, 1, 1)
    for gd in GD:
        nxt = date(d.year + d.month // 12, d.month % 12 + 1, 1)
        days = (nxt - d).days
        out.append({"start": d.isoformat(), "end": nxt.isoformat(),
                    "gas_m3": a * days + bb * gd, "degree_days": gd if dd else None})
        d = nxt
    return out


def _em(eid, room, power, typ="radiator"):
    return {"id": eid, "name": eid, "type": typ, "room": room, "power_w": power, "measurements": []}


def _project(emitters=(), rooms=(), periods=(), **settings):
    return {"settings": settings, "emitters": list(emitters), "gas_periods": list(periods),
            "rooms": [{"id": f"r{i}", **r} for i, r in enumerate(rooms)], "knmi": {}}


# ---- invoer -----------------------------------------------------------------------

def test_parse_date():
    assert s.parse_date("2024-03-05") == (date(2024, 3, 5), False)
    assert s.parse_date("5-3-2024") == (date(2024, 3, 5), False)
    assert s.parse_date("05/03/2024 07:00") == (date(2024, 3, 5), False)
    assert s.parse_date("2024-03") == (date(2024, 3, 1), True)
    assert s.parse_date("3-2024") == (date(2024, 3, 1), True)
    assert s.parse_date("maart 2024") == (date(2024, 3, 1), True)
    assert s.parse_date("okt. 2023") == (date(2023, 10, 1), True)
    assert s.parse_date("31-2-2024") is None and s.parse_date("Woonkamer") is None


def test_parse_meter_readings():
    text = "Datum\tMeterstand\n1-1-2024\t10.250,5\n1-2-2024\t10.512\n1-3-2024\t10.700,5\n"
    periods, msg = s.parse_periods(text)
    assert "meterstanden" in msg
    assert periods == [
        {"start": "2024-01-01", "end": "2024-02-01", "gas_m3": 261.5, "degree_days": None},
        {"start": "2024-02-01", "end": "2024-03-01", "gas_m3": 188.5, "degree_days": None}]


def test_parse_monthly_and_ranges():
    periods, _ = s.parse_periods("maand;m3;graaddagen\njan 2024;250;480\nfebruari 2024;210\n")
    assert periods[0] == {"start": "2024-01-01", "end": "2024-02-01", "gas_m3": 250,
                          "degree_days": 480}
    assert periods[1]["end"] == "2024-03-01" and periods[1]["degree_days"] is None
    periods, _ = s.parse_periods("2024-01-01\t2024-04-01\t700\n2024-04-01\t2023-01-01\t5\n")
    assert len(periods) == 1 and periods[0]["gas_m3"] == 700  # einde vóór begin: overgeslagen


def test_parse_usage_per_date():
    periods, msg = s.parse_periods("2024-01-01;12\n2024-01-02;9\n2024-01-03;14\n")
    assert "verbruik" in msg
    assert [(p["start"], p["end"], p["gas_m3"]) for p in periods] == [
        ("2024-01-01", "2024-01-02", 12), ("2024-01-02", "2024-01-03", 9),
        ("2024-01-03", "2024-01-04", 14)]


# ---- gasverbruik -------------------------------------------------------------------

def test_regression_recovers_heat_loss_coefficient():
    g = s.gas_analysis(_project(periods=_months()), b.settings_of(_project()))
    assert g["ok"] and g["method"] == "regressie"
    assert g["base_m3_day"] == pytest.approx(0.6) and g["m3_per_dd"] == pytest.approx(0.12)
    h = 0.12 * 9.77 * 0.9 * 1000 / 24
    assert g["h_w_per_k"] == pytest.approx(h) and g["p_design_w"] == pytest.approx(h * 28)
    assert g["r2"] == pytest.approx(1)
    assert g["dhw_m3_year"] == pytest.approx(219)


def test_winter_only_needs_hot_water_setting():
    winter = [p for p in _months() if p["degree_days"] >= 340][:4]
    cfg = b.settings_of(_project())
    g = s.gas_analysis(_project(periods=winter[:2]), cfg)
    assert g["method"] == "zonder_warm_water" and any("warm water" in n for n in g["notes"])
    cfg["dhw_gas_m3_year"] = 0.6 * 365
    g = s.gas_analysis(_project(periods=winter[:2]), cfg)
    assert g["method"] == "warm_water" and g["m3_per_dd"] == pytest.approx(0.12)


def test_degree_days_from_knmi_temperatures():
    p = _project(periods=[{"start": "2024-01-01", "end": "2024-01-04", "gas_m3": 30,
                           "degree_days": None}])
    p["knmi"] = {"station": 260, "temps": {"2024-01-01": 5.0, "2024-01-02": 20.0}}
    g = s.gas_analysis(p, b.settings_of(p))
    assert g["periods"][0]["dd"] is None and not g["ok"]  # 3 januari ontbreekt
    p["knmi"]["temps"]["2024-01-03"] = 10.5
    g = s.gas_analysis(p, b.settings_of(p))
    assert g["periods"][0]["dd"] == 13 + 0 + 7.5 and g["periods"][0]["dd_source"] == "knmi"
    assert s.periods_span(p["gas_periods"]) == (date(2024, 1, 1), date(2024, 1, 3))


# ---- stooklijn ---------------------------------------------------------------------

def test_single_radiator_curve():
    p = _project([_em("a", "Kamer", 1500)], [{"name": "Kamer", "temp": 20, "loss_w": 1000}],
                 target_dt=10)
    res = s.analyze(p)
    assert res["basis"] == "warmteverlies"
    g = res["groups"][0]
    ts = g["design_supply"]
    assert b.heat_output(1500, 1.3, [75, 65, 20], ts, ts - 10, 20) == pytest.approx(1000, rel=0.01)
    pts = g["points"]
    assert pts[0]["t_out"] == -10 and pts[0]["supply"] == pytest.approx(ts, abs=0.1)
    assert pts[-1]["t_out"] == 18 and pts[-1]["supply"] == 20  # geen last bij de stookgrens
    assert all(x["supply"] >= y["supply"] for x, y in zip(pts, pts[1:]))
    line = g["line"]
    for pt in pts:
        on_line = line["end"] + (line["foot"] - line["end"]) * (pt["t_out"] + 10) / 28
        assert on_line >= pt["supply"] - 1e-6
    assert line["slope"] > 0 and line["foot"] >= 20


def test_critical_room_sets_the_curve():
    ems = [_em("bad", "Badkamer", 600), _em("slk", "Slaapkamer", 1200)]
    rooms = [{"name": "Badkamer", "temp": 24, "loss_w": 500},
             {"name": "Slaapkamer", "temp": 18, "loss_w": 500}]
    g = s.analyze(_project(ems, rooms, target_dt=10))["groups"][0]
    assert g["critical"][0]["id"] == "bad" and g["second_supply"] < g["design_supply"]


def test_gas_scales_calculation():
    ems = [_em("a", "Kamer", 2000), _em("b", "Hal", 800)]
    rooms = [{"name": "Kamer", "temp": 20, "loss_w": 3000}, {"name": "Hal", "temp": 18, "loss_w": 1000}]
    res = s.analyze(_project(ems, rooms, _months()))
    assert res["basis"] == "gas_geschaald"
    p_gas = res["gas"]["p_design_w"]
    assert res["scale"] == pytest.approx(p_gas / 4000, abs=1e-3)
    assert res["calc_vs_gas"] == pytest.approx(4000 / p_gas, abs=0.01)
    assert sum(pt["load_w"] for pt in res["groups"][0]["points"][:1]) == pytest.approx(p_gas, abs=2)
    only_calc = s.analyze(_project(ems, rooms, _months(), curve_basis="warmteverlies"))
    assert only_calc["basis"] == "warmteverlies"
    assert only_calc["groups"][0]["design_supply"] > res["groups"][0]["design_supply"]


def test_gas_without_rooms_distributes_by_power():
    res = s.analyze(_project([_em("a", "", 1000), _em("b", "", 3000)], periods=_months()))
    assert res["basis"] == "gas"
    crit = {c["id"]: c for c in res["groups"][0]["critical"]}
    assert crit["b"]["q"] == pytest.approx(3 * crit["a"]["q"], abs=1)


def test_ufh_gets_its_own_curve_and_heat_pump_warning():
    ems = [_em("v", "Woonkamer", 3000, typ="vloerverwarming"), _em("r", "Hal", 500)]
    rooms = [{"name": "Woonkamer", "temp": 21, "loss_w": 1500}, {"name": "Hal", "temp": 18, "loss_w": 600}]
    res = s.analyze(_project(ems, rooms, heat_source="warmtepomp", target_dt=5))
    keys = {g["key"]: g for g in res["groups"]}
    assert keys["vloer"]["design_supply"] < keys["rad"]["design_supply"]
    assert any("warmtepomp" in n for n in res["notes"])


def test_unreachable_element_is_reported():
    res = s.analyze(_project([_em("a", "Kamer", 100), _em("b", "Hal", 1000)],
                             [{"name": "Kamer", "temp": 20, "loss_w": 2000},
                              {"name": "Hal", "temp": 20, "loss_w": 500}]))
    g = res["groups"][0]
    assert g["unreachable"] == ["a (Kamer)"] and g["design_supply"] < 100


def test_loss_factor_scales_design():
    ems = [_em("a", "Kamer", 1500)]
    rooms = [{"name": "Kamer", "temp": 20, "loss_w": 1000}]
    full = b.design(_project(ems, rooms), b.settings_of(_project(design_supply_temp=55)))[0]["a"]
    half = b.design(_project(ems, rooms), b.settings_of(_project(design_supply_temp=55,
                                                                 loss_factor=0.5)))[0]["a"]
    assert half["design_q"] == pytest.approx(full["design_q"] / 2)
