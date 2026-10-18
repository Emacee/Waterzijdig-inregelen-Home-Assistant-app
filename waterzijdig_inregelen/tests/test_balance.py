import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import balance as b  # noqa: E402


def _project(emitters, **settings):
    return {"settings": settings, "valve_types": b.DEFAULT_VALVE_TYPES, "emitters": emitters}


def _em(eid, t_in, t_out, power=None, demand=None, preset=None, valve="danfoss_ra_n",
        typ="radiator", t_room=20.0):
    ms = [{"id": "m", "ts": "2026-01-01T00:00:00", "t_in": t_in, "t_out": t_out,
           "t_room": t_room, "preset": preset}]
    return {"id": eid, "name": eid, "type": typ, "power_w": power, "demand_w": demand,
            "valve_type": valve, "preset": preset, "measurements": ms}


def by_id(res):
    return {r["id"]: r for r in res["emitters"]}


def test_lmtd_nominal():
    assert b.lmtd(75, 65, 20) == pytest.approx(49.83, abs=0.01)
    assert b.lmtd(40, 40, 20) == 20
    assert b.lmtd(20, 15, 20) is None


def test_heat_output_nominal_equals_rated():
    assert b.heat_output(1000, 1.3, [75, 65, 20], 75, 65, 20) == pytest.approx(1000)


def test_solve_t_out_roundtrip():
    q = b.heat_output(1500, 1.3, [75, 65, 20], 60, 45, 20)
    t_out, sat = b.solve_t_out(q, 1500, 1.3, [75, 65, 20], 60, 20)
    assert not sat and t_out == pytest.approx(45, abs=0.01)
    _, sat = b.solve_t_out(10000, 500, 1.3, [75, 65, 20], 60, 20)
    assert sat


def test_on_target_is_ok():
    res = b.analyze(_project([_em("a", 70, 50, power=1000, preset=4)], target_dt=20,
                             keep_total_flow=False))
    r = by_id(res)["a"]
    assert r["ratio"] == pytest.approx(1.0, abs=1e-6)
    assert r["status"] == "ok"


def test_small_dt_means_close_large_dt_means_open():
    # a heeft te veel debiet (kleine ΔT), c te weinig (grote ΔT)
    ems = [_em("a", 70, 62, power=1000, preset=5), _em("b", 70, 50, power=1000, preset=5),
           _em("c", 70, 35, power=1000, preset=5)]
    res = by_id(b.analyze(_project(ems, target_dt=20)))
    assert res["a"]["status"] == "dicht" and res["a"]["preset_advice"] < 5
    assert res["c"]["status"] == "open" and res["c"]["preset_advice"] > 5


def test_keep_total_flow_preserves_sum():
    ems = [_em("a", 70, 62, power=1200), _em("b", 70, 45, power=800), _em("c", 68, 40, power=1500)]
    res = b.analyze(_project(ems, target_dt=20, keep_total_flow=True))
    rows = res["emitters"]
    assert sum(r["flow_target"] for r in rows) == pytest.approx(sum(r["flow_act"] for r in rows),
                                                                rel=1e-3)


def test_ratio_independent_of_power_without_normalization():
    with_p = by_id(b.analyze(_project([_em("a", 60, 52, power=900)], keep_total_flow=False,
                                      target_dt=15)))["a"]
    without = by_id(b.analyze(_project([_em("a", 60, 52)], keep_total_flow=False,
                                       target_dt=15)))["a"]
    assert with_p["ratio"] == pytest.approx(without["ratio"], rel=1e-6)
    assert with_p["ratio"] < 1


def test_demand_mode_redistributes_by_demand():
    # gelijke radiatoren, gelijk gemeten, maar b's ruimte vraagt 2x zo veel
    ems = [_em("a", 60, 45, power=1000, demand=500), _em("b", 60, 45, power=1000, demand=1000)]
    res = b.analyze(_project(ems))
    assert res["method"] == "vraag"
    r = by_id(res)
    assert r["a"]["status"] == "dicht" and r["b"]["status"] == "open"
    assert r["a"]["q_target"] + r["b"]["q_target"] == pytest.approx(
        r["a"]["q_act"] + r["b"]["q_act"], rel=1e-3)


def test_demand_mode_requires_all():
    ems = [_em("a", 60, 45, power=1000, demand=500), _em("b", 60, 45, power=1000)]
    res = b.analyze(_project(ems))
    assert res["method"] == "dt"
    assert res["summary"]["notes"]


def test_invalid_measurements():
    ems = [_em("a", 50, 50.1), _em("b", 19, 18)]
    r = by_id(b.analyze(_project(ems)))
    assert r["a"]["status"] == "ongeldig" and r["b"]["status"] == "ongeldig"


def test_no_measurement():
    em = _em("a", 60, 40)
    em["measurements"] = []
    assert by_id(b.analyze(_project([em])))["a"]["status"] == "geen_meting"


def test_valve_inverse_and_labels():
    v = b.DEFAULT_VALVE_TYPES[0]
    for s in (1, 2.5, 4, 7.5):
        assert b.setting_for_kv(v, b.kv_at(v, s))[0] == pytest.approx(s)
    assert b.setting_for_kv(v, 10)[1] == "max"
    assert b.setting_for_kv(v, 0.001)[1] == "min"
    assert b.setting_label(v, 8) == "N"
    assert b.round_setting(v, 3.3) == 3.5


def test_valve_at_max_warns():
    ems = [_em("a", 70, 30, power=1000, preset=8), _em("b", 70, 66, power=1000, preset=4)]
    r = by_id(b.analyze(_project(ems, target_dt=20)))["a"]
    assert r["status"] == "open" and r["valve_limit"] == "max"
    assert any("niet verder open" in w for w in r["warnings"])


def test_flowmeter_scales_linearly():
    ems = [_em("a", 35, 33, power=1500, preset=2.0, valve="flowmeter_lpm", typ="vloerverwarming")]
    r = by_id(b.analyze(_project(ems, target_dt=5, keep_total_flow=False)))["a"]
    assert r["preset_advice"] == pytest.approx(round(2.0 * r["ratio"], 1), abs=0.051)


def test_preset_changed_after_measurement_warns():
    em = _em("a", 70, 60, power=1000, preset=4)
    em["preset"] = 3
    r = by_id(b.analyze(_project([em], keep_total_flow=False)))["a"]
    assert r["preset_basis"] == 4
    assert any("gewijzigd" in w for w in r["warnings"])


def test_pump_advice():
    # alle elementen kleine ΔT: totaal debiet te hoog -> pomp kan lager
    ems = [_em("a", 70, 64, power=1000), _em("b", 70, 63, power=1000)]
    s = b.analyze(_project(ems, target_dt=20))["summary"]
    g = s["groups"][0]
    assert g["pump_factor"] < 0.85 and "lager" in g["pump_advice"]
    assert s["pump_advice"] == [g["pump_advice"]]


def test_single_emitter_is_not_normalized():
    # één element: niets te verdelen, dus het ruwe advies (ΔT 8 vs doel 20 -> dicht)
    r = by_id(b.analyze(_project([_em("a", 70, 62, power=1500, preset=4)], target_dt=20)))["a"]
    assert r["status"] == "dicht"


def test_mixed_known_and_unknown_power():
    # alleen a heeft een vermogen; a mag daardoor niet op x1.00 vastgepind worden
    ems = [_em("a", 70, 62, power=1500, preset=4), _em("b", 70, 40, preset=4),
           _em("c", 70, 45, preset=4)]
    r = by_id(b.analyze(_project(ems, target_dt=20)))
    assert r["a"]["status"] == "dicht"
    assert r["b"]["status"] == "open"


def test_floor_heating_is_its_own_group():
    ems = [_em("r1", 70, 50, power=1000), _em("r2", 70, 50, power=1000),
           _em("v1", 35, 30, power=1500, typ="vloerverwarming", valve="flowmeter_lpm"),
           _em("v2", 35, 30, power=1500, typ="vloerverwarming", valve="flowmeter_lpm")]
    res = b.analyze(_project(ems, target_dt=20, ufh_target_dt=5))
    r = by_id(res)
    assert all(r[k]["status"] == "ok" for k in r)
    assert {g["key"] for g in res["summary"]["groups"]} == {"rad", "vloer"}
    assert not res["summary"]["pump_advice"]


def test_cv_supply_temp_used_when_t_in_missing():
    ems = [_em("a", None, 50, preset=4), _em("v", None, 30, typ="vloerverwarming", preset=2,
                                              valve="flowmeter_lpm")]
    res = by_id(b.analyze(_project(ems, supply_temp=70, ufh_supply_temp=35)))
    assert res["a"]["t_in"] == 70 and res["a"]["dt"] == 20 and res["a"]["t_in_source"] == "cv"
    assert res["v"]["t_in"] == 35 and res["v"]["dt"] == 5
    # zonder eigen vloerverwarmingsaanvoer geldt de cv-aanvoer
    res = by_id(b.analyze(_project(ems, supply_temp=40)))
    assert res["v"]["t_in"] == 40 and res["v"]["dt"] == 10


def test_measured_t_in_wins_over_cv_supply_temp():
    res = by_id(b.analyze(_project([_em("a", 65, 50)], supply_temp=70)))
    assert res["a"]["t_in"] == 65 and "t_in_source" not in res["a"]


def test_missing_t_in_without_cv_supply_temp_is_invalid():
    res = by_id(b.analyze(_project([_em("a", None, 50)])))
    assert res["a"]["status"] == "ongeldig"
