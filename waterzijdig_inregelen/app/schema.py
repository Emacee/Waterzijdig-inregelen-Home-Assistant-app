"""Hydraulisch schema: van plattegronden met leidingverloop naar een boomstructuur.

Per plattegrond (verdieping) worden de ingetekende leidingen tot een boom gemaakt:

* een leiding is altijd een aanvoer/retour-paar en loopt vanaf het beginpunt;
* de eerste leiding (en elke leiding die nergens op aansluit) begint bij de
  aansluiting van de verdieping (stijgleiding/verdeler);
* een latere leiding die met een uiteinde op een eerdere leiding begint, is daar
  een aftakking (getekend vanaf het andere uiteinde wordt ze omgedraaid);
* een radiator/convector hangt aan het dichtstbijzijnde punt van de leidingen;
  liggen er geen leidingen in de buurt, dan direct aan de verdieping;
* vloerverwarmingsgroepen komen samen op één verdeler per verdieping.

Kinderen van een tak staan in de volgorde langs de leiding (vanaf de aansluiting),
zodat het schema de werkelijke volgorde van de elementen laat zien. De front-end
tekent de boom; componenten (pomp, buffervat, ...) koppelen aan een knoop via
``attach``: ``source``, ``main``, ``fp:<plattegrond>`` of ``ufh:<plattegrond>``.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

SNAP = 0.02      # uiteinde binnen 2 % van de breedte van een andere leiding = aftakking
ATTACH = 0.12    # element binnen 12 % van de breedte van een leiding = aangesloten

COMPONENT_TYPES = ("pomp", "boilervat", "buffervat", "thermostaat", "mengklep")
COMPONENT_LABELS = {"pomp": "Secundaire pomp", "boilervat": "Boilervat",
                    "buffervat": "Buffervat", "thermostaat": "Thermostaat",
                    "mengklep": "Mengklep"}

Pt = Tuple[float, float]


def _seg(p: Pt, a: Pt, b: Pt) -> Tuple[float, float]:
    """Afstand van p tot segment ab en de positie t (0..1) van het voetpunt."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    ll = dx * dx + dy * dy
    t = 0.0 if ll == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / ll))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy), t


def locate(p: Pt, pts: Sequence[Pt]) -> Tuple[float, float]:
    """(afstand, booglengte vanaf het begin) van het dichtstbijzijnde punt op een polylijn."""
    best, s_best, s = math.inf, 0.0, 0.0
    for a, b in zip(pts, pts[1:]):
        d, t = _seg(p, a, b)
        seg_len = math.hypot(b[0] - a[0], b[1] - a[1])
        if d < best - 1e-12:
            best, s_best = d, s + t * seg_len
        s += seg_len
    return best, s_best


def _nearest(p: Pt, pipes: List[Dict[str, Any]]) -> Tuple[float, Optional[int], float]:
    best: Tuple[float, Optional[int], float] = (math.inf, None, 0.0)
    for i, pipe in enumerate(pipes):
        d, s = locate(p, pipe["pts"])
        if d < best[0]:
            best = (d, i, s)
    return best


def _aspect(fp: Dict[str, Any]) -> float:
    w, h = fp.get("width") or 0, fp.get("height") or 0
    return h / w if w > 0 and h > 0 else 1.0


def _sort_x(emitters: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(emitters, key=lambda e: (e.get("x") or 0, e.get("y") or 0))


def _simplify(node: Dict[str, Any]) -> Dict[str, Any]:
    """Een leidingtak met maar één kind tekenen we als dat kind."""
    if "children" in node:
        node["children"] = [_simplify(c) for c in node["children"]]
        node["children"] = [c for c in node["children"]
                            if not (c["kind"] == "branch" and not c["children"])]
        if node["kind"] == "branch" and len(node["children"]) == 1:
            return node["children"][0]
    return node


def build_floor(fp: Dict[str, Any], emitters: List[Dict[str, Any]],
                notes: List[str]) -> Dict[str, Any]:
    a = _aspect(fp)
    pipes: List[Dict[str, Any]] = []
    for raw in fp.get("pipes") or []:
        pts = [(float(x), float(y) * a) for x, y in raw.get("points") or []]
        if len(pts) < 2:
            continue
        pipe = {"id": raw["id"], "name": raw.get("name") or "", "pts": pts,
                "items": [], "parent": None}
        if pipes:
            d0, j0, s0 = _nearest(pts[0], pipes)
            d1, j1, s1 = _nearest(pts[-1], pipes)
            if d1 < d0 and d1 <= SNAP:
                pipe["pts"] = pts[::-1]
                d0, j0, s0 = d1, j1, s1
            if d0 <= SNAP:
                pipe["parent"] = (j0, s0)
        pipes.append(pipe)

    root_items: List[Tuple[float, Dict[str, Any]]] = []
    loose: List[Dict[str, Any]] = []

    def attach(p: Pt, node: Dict[str, Any]) -> bool:
        d, j, s = _nearest(p, pipes)
        if j is not None and d <= ATTACH:
            pipes[j]["items"].append((s, node))
            return True
        return False

    def pos(e: Dict[str, Any]) -> Pt:
        return (float(e.get("x") or 0), float(e.get("y") or 0) * a)

    ufh = [e for e in emitters if e.get("type") == "vloerverwarming"]
    for e in _sort_x([e for e in emitters if e.get("type") != "vloerverwarming"]):
        node = {"kind": "emitter", "id": e["id"]}
        if not attach(pos(e), node):
            loose.append(node)
    if ufh:
        verdeler = {"kind": "verdeler", "id": f"ufh:{fp['id']}", "label": "Verdeler vloerverwarming",
                    "children": [{"kind": "emitter", "id": e["id"]} for e in _sort_x(ufh)]}
        closest = min(ufh, key=lambda e: _nearest(pos(e), pipes)[0])
        if not attach(pos(closest), verdeler):
            loose.append(verdeler)

    nodes = [{"kind": "branch", "id": p["id"], "label": p["name"], "children": []} for p in pipes]
    for i, p in enumerate(pipes):
        if p["parent"] is None:
            root_items.append((0.0, nodes[i]))
        else:
            j, s = p["parent"]
            pipes[j]["items"].append((s, nodes[i]))
    for i, p in enumerate(pipes):
        nodes[i]["children"] = [n for _, n in sorted(p["items"], key=lambda it: it[0])]

    children = [n for _, n in root_items] + loose
    if pipes and loose:
        n_loose = sum(1 for n in loose if n["kind"] == "emitter") + \
            sum(len(n["children"]) for n in loose if n["kind"] == "verdeler")
        notes.append(f"{fp.get('name') or 'Plattegrond'}: {n_loose} element(en) liggen niet bij "
                     "een ingetekende leiding en zijn direct op de verdieping aangesloten.")
    floor = _simplify({"kind": "floor", "id": fp["id"], "label": fp.get("name") or "",
                       "children": children})
    # één doorgaande leiding vanaf de aansluiting: geen extra niveau tekenen
    if len(floor["children"]) == 1 and floor["children"][0]["kind"] == "branch":
        floor["children"] = floor["children"][0]["children"]
    return floor


def build_schema(project: Dict[str, Any]) -> Dict[str, Any]:
    notes: List[str] = []
    fps = project.get("floorplans") or []
    known = {f["id"] for f in fps}
    emitters = project.get("emitters") or []
    floors = [build_floor(fp, [e for e in emitters if e.get("floorplan_id") == fp["id"]], notes)
              for fp in fps]
    orphans = [e for e in emitters if e.get("floorplan_id") not in known]
    if orphans:
        floors.append(build_floor({"id": "none", "name": "Zonder plattegrond"}, orphans, notes))
    floors = [f for f in floors if f["children"]]

    comps = project.get("components") or []
    by_attach: Dict[str, List[str]] = {}
    for c in comps:
        by_attach.setdefault(c.get("attach") or "main", []).append(c.get("type"))
    if "buffervat" in by_attach.get("source", []) and "pomp" not in by_attach.get("main", []):
        notes.append("Er is een buffervat maar geen pomp op de hoofdleiding: na een buffervat "
                     "(hydraulische scheiding) is een secundaire pomp nodig.")
    for f in floors:
        if "mengklep" in by_attach.get(f"ufh:{f['id']}", []) and \
                "pomp" not in by_attach.get(f"ufh:{f['id']}", []):
            notes.append(f"{f['label']}: een mengklep voor de vloerverwarming werkt alleen met een "
                         "eigen (secundaire) pomp op de verdeler.")
    heat_source = (project.get("settings") or {}).get("heat_source", "ketel")
    return {"source": heat_source, "floors": floors, "notes": notes}
