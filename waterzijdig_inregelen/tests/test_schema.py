import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import schema as sc  # noqa: E402


def _em(eid, x, y, typ="radiator"):
    return {"id": eid, "type": typ, "x": x, "y": y, "floorplan_id": "f1"}


def _fp(pipes):
    return {"id": "f1", "name": "BG", "width": 100, "height": 100,
            "pipes": [{"id": f"p{i}", "points": pts} for i, pts in enumerate(pipes)]}


def _ids(node):
    return [c["id"] for c in node["children"]]


def test_emitters_ordered_along_pipe():
    # leiding van rechts naar links: volgorde volgt de leiding, niet de x-positie
    fp = _fp([[[0.9, 0.5], [0.1, 0.5]]])
    ems = [_em("a", 0.2, 0.55), _em("b", 0.8, 0.45), _em("c", 0.5, 0.52)]
    floor = sc.build_floor(fp, ems, [])
    assert _ids(floor) == ["b", "c", "a"]


def test_branch_snaps_and_reverses():
    main = [[0.1, 0.5], [0.9, 0.5]]
    branch = [[0.5, 0.9], [0.5, 0.505]]  # getekend vanaf het einde: wordt omgedraaid
    fp = _fp([main, branch])
    ems = [_em("a", 0.2, 0.52), _em("b", 0.52, 0.8), _em("c", 0.52, 0.7), _em("d", 0.8, 0.52)]
    floor = sc.build_floor(fp, ems, [])
    assert floor["children"][0]["id"] == "a"
    br = floor["children"][1]
    assert br["kind"] == "branch" and _ids(br) == ["c", "b"]
    assert floor["children"][2]["id"] == "d"


def test_ufh_on_verdeler_and_loose_emitters():
    notes = []
    fp = _fp([[[0.1, 0.1], [0.3, 0.1]]])
    ems = [_em("v1", 0.2, 0.12, "vloerverwarming"), _em("v2", 0.25, 0.3, "vloerverwarming"),
           _em("far", 0.9, 0.9)]
    floor = sc.build_floor(fp, ems, notes)
    kinds = [c["kind"] for c in floor["children"]]
    assert kinds == ["verdeler", "emitter"]
    assert _ids(floor["children"][0]) == ["v1", "v2"]
    assert notes and "niet bij" in notes[0]


def test_no_pipes_all_on_floor():
    floor = sc.build_floor(_fp([]), [_em("b", 0.6, 0.1), _em("a", 0.1, 0.1)], [])
    assert _ids(floor) == ["a", "b"]


def test_buffer_without_pump_note():
    p = {"floorplans": [], "emitters": [], "settings": {},
         "components": [{"id": "x", "type": "buffervat", "attach": "source"}]}
    assert any("buffervat" in n for n in sc.build_schema(p)["notes"])
    p["components"].append({"id": "y", "type": "pomp", "attach": "main"})
    assert not sc.build_schema(p)["notes"]
