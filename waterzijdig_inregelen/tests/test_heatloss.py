import io
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import balance as b  # noqa: E402
from app import heatloss as h  # noqa: E402


def _em(eid, room, power, t_in=None, t_out=None, typ="radiator", t_room=None, preset=None):
    ms = [] if t_out is None else [{"id": "m", "ts": "2026-01-01T00:00:00", "t_in": t_in,
                                    "t_out": t_out, "t_room": t_room, "preset": preset}]
    return {"id": eid, "name": eid, "type": typ, "room": room, "power_w": power,
            "valve_type": "danfoss_ra_n", "preset": preset, "measurements": ms}


def _project(emitters, rooms, **settings):
    return {"settings": settings, "valve_types": b.DEFAULT_VALVE_TYPES, "emitters": emitters,
            "rooms": [{"id": f"r{i}", **r} for i, r in enumerate(rooms)]}


def by_id(res):
    return {r["id"]: r for r in res["emitters"]}


# ---- getallen en tabellen -------------------------------------------------------

def test_to_number_dutch_formats():
    assert h.to_number("1.234") == 1234
    assert h.to_number("1.234,5") == 1234.5
    assert h.to_number("20,5 °C") == 20.5
    assert h.to_number("20.5") == 20.5
    assert h.to_number("850 W") == 850
    assert h.to_number("Woonkamer") is None


def test_csv_with_header_prefers_total_column():
    data = ("Project;Woning\n\n"
            "Ruimte;Oppervlak (m2);Ontwerptemperatuur (°C);Transmissie (W);Ventilatie (W);"
            "Totaal warmteverlies (W)\n"
            "Woonkamer;32,5;22;1.150;420;1.870\n"
            "Slaapkamer 1;14;20;380;150;610\n"
            "Badkamer;6;24;290;210;640\n"
            "Totaal;;;1820;780;3120\n").encode("utf-8")
    rooms = h.parse(data)
    assert rooms == [{"name": "Woonkamer", "temp": 22, "loss_w": 1870},
                     {"name": "Slaapkamer 1", "temp": 20, "loss_w": 610},
                     {"name": "Badkamer", "temp": 24, "loss_w": 640}]


def test_csv_in_kw_and_without_temperature():
    rooms = h.parse(b"naam,warmteverlies [kW]\nKeuken,1.25\nHal,0.4\n")
    assert rooms == [{"name": "Keuken", "temp": None, "loss_w": 1250},
                     {"name": "Hal", "temp": None, "loss_w": 400}]


def test_pdf_text_rows_without_header():
    text = ("Warmteverliesberekening ISSO 51\tPagina 1 van 4\n"
            "0.01\tWoonkamer / keuken\t22 °C\t38,4 m²\t1.240 W\t610 W\t2.130 W\n"
            "1.02\tSlaapkamer 2\t20\t11,2\t310\t140\t505\n"
            "Datum\t12-03-2024\n"
            "Totaal\t20\t100\t2000\t800\t2635\n").encode("utf-8")
    rooms = h.parse(text, headerless=True)
    assert rooms == [{"name": "Woonkamer / keuken", "temp": 22, "loss_w": 2130},
                     {"name": "Slaapkamer 2", "temp": 20, "loss_w": 505}]


def test_single_cell_line():
    assert h.detect([["Badkamer 24 6,1 640"]]) == [{"name": "Badkamer", "temp": 24, "loss_w": 640}]


def test_xlsx_roundtrip():
    openpyxl = pytest.importorskip("openpyxl")
    wb = openpyxl.Workbook()
    wb.active.append(["iets anders"])
    ws = wb.create_sheet("Ruimtes")
    ws.append(["Vertrek", "θi [°C]", "Φ HL totaal [W]"])
    ws.append(["Woonkamer", 22, 1870.4])
    ws.append(["Slaapkamer", 18.5, 455])
    buf = io.BytesIO()
    wb.save(buf)
    assert h.parse(buf.getvalue()) == [{"name": "Woonkamer", "temp": 22, "loss_w": 1870},
                                       {"name": "Slaapkamer", "temp": 18.5, "loss_w": 455}]


def test_rejects_binary_and_pdf():
    for data in (b"%PDF-1.7 ...", b"\xd0\xcf\x11\xe0\x00\x00\x00\x00", b"PK\x03\x04kapot"):
        with pytest.raises(ValueError):
            h.parse(data)


# ---- ontwerpwaarden ---------------------------------------------------------------

def test_design_return_differs_per_room_temperature():
    # twee gelijke radiatoren met gelijk warmteverlies; de badkamer is 24 °C, de slaapkamer 18 °C
    ems = [_em("bad", "Badkamer", 1000), _em("slk", "Slaapkamer", 1000)]
    rooms = [{"name": "badkamer", "temp": 24, "loss_w": 400},
             {"name": "Slaapkamer", "temp": 18, "loss_w": 400}]
    r = by_id(b.analyze(_project(ems, rooms, design_supply_temp=55)))
    assert r["bad"]["design_t_out"] > r["slk"]["design_t_out"] + 5
    assert r["bad"]["design_flow"] > r["slk"]["design_flow"]
    for k, theta in (("bad", 24), ("slk", 18)):
        q = b.heat_output(1000, 1.3, [75, 65, 20], 55, r[k]["design_t_out"], theta)
        assert q == pytest.approx(400, rel=1e-3)
        assert r[k]["design_flow"] == pytest.approx(
            400 / (1.163 * (55 - r[k]["design_t_out"])), rel=1e-3)


def test_room_loss_is_shared_over_emitters_in_room():
    ems = [_em("a", "Woonkamer", 1500), _em("b", "woonkamer ", 500)]
    res = b.analyze(_project(ems, [{"name": "Woonkamer", "temp": 21, "loss_w": 1000}],
                             design_supply_temp=60))
    r = by_id(res)
    assert r["a"]["design_q"] == pytest.approx(750) and r["b"]["design_q"] == pytest.approx(250)
    assert r["a"]["design_t_out"] == pytest.approx(r["b"]["design_t_out"], abs=0.01)
    room = res["rooms"]["rooms"][0]
    assert room["complete"] and room["emitters"] == ["a", "b"]


def test_incomplete_rooms_report_why():
    ems = [_em("a", "Woonkamer", None), _em("b", "Hal", 500), _em("c", "", 500)]
    rooms = [{"name": "Woonkamer", "temp": 21, "loss_w": 1000},
             {"name": "Zolder", "temp": 18, "loss_w": 300}]
    res = b.analyze(_project(ems, rooms, design_supply_temp=60))
    info = {r["name"]: r for r in res["rooms"]["rooms"]}
    assert "Vermogen ontbreekt" in info["Woonkamer"]["warnings"][0]
    assert "Geen element" in info["Zolder"]["warnings"][0]
    assert res["rooms"]["unmatched"] == ["Hal"] and res["rooms"]["no_room"] == 1
    assert "design_q" not in by_id(res)["a"]
    # zonder ontwerp-aanvoer (en zonder cv-temperatuur) valt er niets te rekenen
    res = b.analyze(_project([_em("a", "Woonkamer", 900)], rooms))
    assert res["rooms"]["need_supply"] and not res["rooms"]["rooms"][0]["complete"]


def test_undersized_emitter_is_flagged():
    res = b.analyze(_project([_em("a", "Woonkamer", 500, 45, 40)],
                             [{"name": "Woonkamer", "temp": 22, "loss_w": 2000}],
                             design_supply_temp=45))
    r = by_id(res)["a"]
    assert r["design_sat"] and "design_t_out" not in r
    assert "te klein" in res["rooms"]["rooms"][0]["warnings"][0]
    assert r["status"] == "open"


def test_design_method_targets_design_flow():
    rooms = [{"name": "Badkamer", "temp": 24, "loss_w": 400},
             {"name": "Slaapkamer", "temp": 18, "loss_w": 400}]
    base = by_id(b.analyze(_project([_em("bad", "Badkamer", 1000), _em("slk", "Slaapkamer", 1000)],
                                    rooms, design_supply_temp=55)))
    # gemeten precies op het ontwerp: goed, en de doelretour is de ontwerpretour
    ems = [_em("bad", "Badkamer", 1000, 55, base["bad"]["design_t_out"], preset=4),
           _em("slk", "Slaapkamer", 1000, 55, base["slk"]["design_t_out"], preset=4)]
    res = b.analyze(_project(ems, rooms, design_supply_temp=55))
    assert res["method"] == "ontwerp" and res["summary"]["groups"][0]["method"] == "ontwerp"
    r = by_id(res)
    for k in ("bad", "slk"):
        assert r[k]["status"] == "ok" and r[k]["ratio"] == pytest.approx(1, abs=0.01)
        assert r[k]["t_room"] == (24 if k == "bad" else 18)  # ontwerptemperatuur als standaard
        assert r[k]["target_t_out"] == pytest.approx(base[k]["design_t_out"], abs=0.05)
    # beide op dezelfde retour gemeten: de badkamer krijgt te weinig, de slaapkamer te veel
    ems = [_em("bad", "Badkamer", 1000, 55, 40, preset=4),
           _em("slk", "Slaapkamer", 1000, 55, 40, preset=4)]
    r = by_id(b.analyze(_project(ems, rooms, design_supply_temp=55)))
    assert r["bad"]["status"] == "open" and r["slk"]["status"] == "dicht"


def test_design_target_follows_measured_supply():
    # gemeten bij een lagere aanvoer dan het ontwerp: de doelretour schuift mee, het debiet niet
    rooms = [{"name": "Kamer", "temp": 20, "loss_w": 600}]
    d = by_id(b.analyze(_project([_em("a", "Kamer", 1200)], rooms, design_supply_temp=60)))["a"]
    t_out = b.flow_return(d["design_flow"], 1200, 1.3, [75, 65, 20], 45, 20)
    r = by_id(b.analyze(_project([_em("a", "Kamer", 1200, 45, t_out, t_room=20)], rooms,
                                 design_supply_temp=60)))["a"]
    assert r["ratio"] == pytest.approx(1, abs=0.01) and r["status"] == "ok"
    assert r["target_t_out"] == pytest.approx(t_out, abs=0.05) and t_out < d["design_t_out"]


def test_falls_back_with_note_when_design_is_incomplete():
    rooms = [{"name": "Kamer", "temp": 20, "loss_w": 600}]
    ems = [_em("a", "Kamer", 1200, 60, 45), _em("b", "Onbekend", 800, 60, 45)]
    res = b.analyze(_project(ems, rooms, design_supply_temp=60))
    assert res["method"] == "dt"
    assert any("warmteverliesberekening" in n and "b" in n for n in res["summary"]["notes"])
    # methode 'altijd gelijk ΔT' negeert de warmteverliesberekening
    res = b.analyze(_project(ems[:1], rooms, design_supply_temp=60, method="dt"))
    assert res["method"] == "dt" and not res["summary"]["notes"]


def test_ufh_uses_its_own_design_supply():
    ems = [_em("v", "Woonkamer", 2000, typ="vloerverwarming"), _em("r", "Hal", 800)]
    rooms = [{"name": "Woonkamer", "temp": 21, "loss_w": 1200},
             {"name": "Hal", "temp": 18, "loss_w": 300}]
    r = by_id(b.analyze(_project(ems, rooms, design_supply_temp=55, ufh_supply_temp=35)))
    assert r["v"]["design_supply"] == 35 and r["r"]["design_supply"] == 55
    assert 21 < r["v"]["design_t_out"] < 35
