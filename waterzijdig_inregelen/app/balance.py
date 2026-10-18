"""Waterzijdig inregelen: van gemeten aanvoer/retour naar advies per afgifte-element.

Model
-----
Het afgegeven vermogen van een radiator (of vloerverwarmingsgroep) volgt de
EN 442-karakteristiek::

    Q = P_nom * (LMTD / LMTD_nom) ** n

met LMTD het logaritmisch temperatuurverschil tussen water en ruimte. Het
debiet volgt uit ``Q = 1.163 * debiet[l/h] * ΔT``.

Per element wordt een *doeldebiet* bepaald en vergeleken met het huidige
debiet; de verhouding ``r = doel / huidig`` is het advies (r > 1: verder open).

* **ΔT-methode** (standaard): elk element moet bij zijn eigen aanvoertemperatuur
  het doel-ΔT van het project halen. Het nominale vermogen valt dan weg uit
  ``r`` en dient alleen als weging; zonder vermogen werkt de methode dus ook.
* **Cv-aanvoertemperatuur**: per project kan één aanvoertemperatuur worden
  ingesteld (en eventueel een eigen voor de vloerverwarming). Metingen zonder
  aanvoertemperatuur rekenen daarmee, zodat alleen de retour per element gemeten
  hoeft te worden; ΔT = cv-aanvoer − retour.
* **Warmtevraag-methode**: als bij álle gemeten elementen het vermogen én de
  warmtevraag van de ruimte zijn ingevuld, wordt het huidige totaal geleverde
  vermogen verdeeld naar rato van de warmtevraag.

Omdat dichtdraaien van het ene ventiel het andere meer water geeft, worden de
doeldebieten standaard herschaald zodat het totale (pomp)debiet gelijk blijft
(``keep_total_flow``). Wat dan nog afwijkt van het doel-ΔT is een pompadvies.

De vertaling naar een nieuwe voorinstelling gaat via de kv-tabel van het
ventieltype: bij een (ongeveer) gelijk drukverschil is het debiet evenredig
met kv, dus ``kv_nieuw = kv_huidig * r``.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

CP_WH_PER_L_K = 1.163  # warmtecapaciteit water [Wh/(l·K)]
MIN_DT = 0.3           # kleiner gemeten ΔT is niet bruikbaar
RATIO_CAP = 4.0        # meer dan 4x debiet is in de praktijk "volledig open"

# Elke groep is een eigen watercircuit met eigen doel-ΔT en pompadvies.
GROUPS = [("rad", "Radiatoren"), ("vloer", "Vloerverwarming")]

DEFAULT_SETTINGS: Dict[str, Any] = {
    "heat_source": "ketel",          # ketel | warmtepomp | anders
    "target_dt": 20.0,               # radiatoren / convectoren
    "ufh_target_dt": 5.0,            # vloerverwarming (eigen groep)
    "room_temp": 20.0,
    "supply_temp": None,             # cv-aanvoertemperatuur; None = per meting invullen
    "ufh_supply_temp": None,         # eigen aanvoer vloerverwarming; None = supply_temp
    "tolerance_pct": 10.0,
    "keep_total_flow": True,
    "method": "auto",                # auto | dt
    "radiator_exponent": 1.3,
    "ufh_exponent": 1.1,
    "radiator_nominal": [75.0, 65.0, 20.0],
    "ufh_nominal": [35.0, 30.0, 20.0],
}

# Indicatieve kv-waarden; per project aan te passen in de instellingen.
# Alleen de verhoudingen tussen standen tellen, de eenheid is dus vrij.
DEFAULT_VALVE_TYPES: List[Dict[str, Any]] = [
    {
        "id": "danfoss_ra_n",
        "name": "Danfoss RA-N (1–7, N)",
        "resolution": 0.5,
        "steps": [[1, 0.04, ""], [2, 0.08, ""], [3, 0.12, ""], [4, 0.19, ""],
                  [5, 0.25, ""], [6, 0.33, ""], [7, 0.42, ""], [8, 0.56, "N"]],
    },
    {
        "id": "heimeier_vexact",
        "name": "Heimeier V-exact II (1–6, N)",
        "resolution": 0.5,
        "steps": [[1, 0.05, ""], [2, 0.09, ""], [3, 0.15, ""], [4, 0.24, ""],
                  [5, 0.36, ""], [6, 0.48, ""], [7, 0.65, "N"]],
    },
    {
        "id": "lockshield_turns",
        "name": "Retourkoppeling / voetventiel (slagen open)",
        "resolution": 0.25,
        "steps": [[0.25, 0.05, ""], [0.5, 0.12, ""], [1, 0.3, ""], [1.5, 0.5, ""],
                  [2, 0.7, ""], [2.5, 0.85, ""], [3, 0.95, ""], [4, 1.0, ""]],
    },
    {
        "id": "flowmeter_lpm",
        "name": "Verdeler met debietmeter (l/min)",
        "resolution": 0.1,
        "steps": [[0.1, 0.1, ""], [6, 6, ""]],
    },
    {
        "id": "percent",
        "name": "Generiek 0–100 %",
        "resolution": 5,
        "steps": [[5, 5, ""], [100, 100, ""]],
    },
]


def lmtd(t_in: float, t_out: float, t_room: float) -> Optional[float]:
    """Logaritmisch temperatuurverschil; None als het water niet warmer is dan de ruimte."""
    a = t_in - t_room
    b = t_out - t_room
    if a <= 0 or b <= 0:
        return None
    if abs(a - b) < 1e-9:
        return a
    return (a - b) / math.log(a / b)


def heat_output(p_nom: float, n: float, nominal: Sequence[float],
                t_in: float, t_out: float, t_room: float) -> Optional[float]:
    lm = lmtd(t_in, t_out, t_room)
    lm_nom = lmtd(*nominal)
    if lm is None or not lm_nom:
        return None
    return p_nom * (lm / lm_nom) ** n


def solve_t_out(q_target: float, p_nom: float, n: float, nominal: Sequence[float],
                t_in: float, t_room: float) -> Tuple[Optional[float], bool]:
    """Retourtemperatuur waarbij het element ``q_target`` afgeeft.

    Geeft (t_out, saturated); saturated=True als het element dat vermogen bij deze
    aanvoertemperatuur niet kan leveren (dan is "volledig open" het beste).
    """
    lo, hi = t_room + 1e-3, t_in - 1e-3
    if hi <= lo:
        return None, True
    q_max = heat_output(p_nom, n, nominal, t_in, hi, t_room) or 0.0
    if q_target >= q_max * 0.98:
        return None, True
    for _ in range(80):
        mid = (lo + hi) / 2
        q = heat_output(p_nom, n, nominal, t_in, mid, t_room) or 0.0
        if q < q_target:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2, False


# ---- ventielen -------------------------------------------------------------

def _steps(valve: Dict[str, Any]) -> List[Tuple[float, float, str]]:
    out = []
    for s in valve.get("steps") or []:
        try:
            out.append((float(s[0]), float(s[1]), str(s[2]) if len(s) > 2 and s[2] else ""))
        except (TypeError, ValueError, IndexError):
            continue
    out.sort(key=lambda s: s[0])
    return out


def kv_at(valve: Dict[str, Any], setting: float) -> Optional[float]:
    st = _steps(valve)
    if not st:
        return None
    if setting <= st[0][0]:
        # lineair naar (0, 0) onder de laagste stand
        return st[0][1] * max(setting, 0.0) / st[0][0] if st[0][0] > 0 else st[0][1]
    for (s0, k0, _), (s1, k1, _) in zip(st, st[1:]):
        if setting <= s1:
            return k0 + (k1 - k0) * (setting - s0) / (s1 - s0)
    return st[-1][1]


def setting_for_kv(valve: Dict[str, Any], kv: float) -> Tuple[Optional[float], str]:
    """Inverse van kv_at. Geeft (stand, 'ok'|'max'|'min')."""
    st = _steps(valve)
    if not st:
        return None, "ok"
    if kv >= st[-1][1] * 1.001:
        return st[-1][0], "max"
    if kv < st[0][1]:
        # onder de laagste stand: zo ver mogelijk dicht
        return st[0][0], "min"
    for (s0, k0, _), (s1, k1, _) in zip(st, st[1:]):
        if k0 <= kv <= k1 and k1 > k0:
            return s0 + (s1 - s0) * (kv - k0) / (k1 - k0), "ok"
    return st[-1][0], "max"


def round_setting(valve: Dict[str, Any], s: float) -> float:
    res = float(valve.get("resolution") or 0)
    if res > 0:
        s = round(s / res) * res
    st = _steps(valve)
    if st:
        s = min(max(s, st[0][0]), st[-1][0])
    return round(s, 3)


def setting_label(valve: Optional[Dict[str, Any]], s: Optional[float]) -> str:
    if s is None:
        return ""
    if valve:
        for set_, _, label in _steps(valve):
            if label and abs(set_ - s) < 1e-6:
                return label
    return f"{s:g}".replace(".", ",")


# ---- analyse ---------------------------------------------------------------

def settings_of(project: Dict[str, Any]) -> Dict[str, Any]:
    s = dict(DEFAULT_SETTINGS)
    s.update({k: v for k, v in (project.get("settings") or {}).items() if v is not None})
    return s


def _num(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def supply_temp(cfg: Dict[str, Any], is_ufh: bool) -> Optional[float]:
    """Ingestelde aanvoertemperatuur voor deze groep (None als niet ingesteld)."""
    t = _num(cfg.get("ufh_supply_temp")) if is_ufh else None
    return t if t is not None else _num(cfg.get("supply_temp"))


def latest_measurement(emitter: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    ms = emitter.get("measurements") or []
    if not ms:
        return None
    return max(ms, key=lambda m: m.get("ts") or "")


def analyze(project: Dict[str, Any]) -> Dict[str, Any]:
    cfg = settings_of(project)
    valves = {v["id"]: v for v in (project.get("valve_types") or DEFAULT_VALVE_TYPES)}
    tol = max(float(cfg["tolerance_pct"]), 0.0) / 100.0

    rows: List[Dict[str, Any]] = []
    for em in project.get("emitters") or []:
        is_ufh = em.get("type") == "vloerverwarming"
        n = float(cfg["ufh_exponent"] if is_ufh else cfg["radiator_exponent"])
        nominal = cfg["ufh_nominal"] if is_ufh else cfg["radiator_nominal"]
        m = latest_measurement(em)
        row: Dict[str, Any] = {
            "id": em["id"], "name": em.get("name") or "", "status": "geen_meting",
            "warnings": [], "n": n, "nominal": nominal,
            "power_w": _num(em.get("power_w")), "demand_w": _num(em.get("demand_w")),
            "_group": "vloer" if is_ufh else "rad", "_scale": 1.0,
        }
        rows.append(row)
        if not m:
            row["advice"] = "Nog geen meting"
            continue
        t_in, t_out = _num(m.get("t_in")), _num(m.get("t_out"))
        if t_in is None:
            t_in = supply_temp(cfg, is_ufh)
            if t_in is not None:
                row["t_in_source"] = "cv"
        t_room = _num(m.get("t_room"))
        if t_room is None:
            t_room = float(cfg["room_temp"])
        row.update(t_in=t_in, t_out=t_out, t_room=t_room, measured_at=m.get("ts"),
                   preset_measured=_num(m.get("preset")))
        if t_in is None or t_out is None:
            row.update(status="ongeldig", advice="Aanvoer- en retourtemperatuur nodig "
                                                 "(of stel de cv-aanvoertemperatuur in)")
            continue
        dt = t_in - t_out
        row["dt"] = round(dt, 2)
        if dt < MIN_DT:
            row.update(status="ongeldig",
                       advice="Retour is (bijna) even warm als aanvoer: controleer de meting "
                              "of de sensorpositie (aanvoer/retour verwisseld?)")
            continue
        if t_in <= t_room + 1:
            row.update(status="ongeldig", advice="Aanvoer is niet warmer dan de ruimte")
            continue
        t_out_eff = t_out
        if t_out <= t_room + 0.5:
            t_out_eff = t_room + 0.5
            row["warnings"].append("Retour is op kamertemperatuur: er stroomt nauwelijks water "
                                   "door dit element (staat het ventiel dicht?)")
        lm_m = lmtd(t_in, t_out_eff, t_room)
        dt_eff = t_in - t_out_eff
        row["_lm_m"], row["_dt_eff"] = lm_m, dt_eff
        if row["power_w"]:
            q = heat_output(row["power_w"], n, nominal, t_in, t_out_eff, t_room)
            row["q_act"] = q
            row["flow_act"] = q / (CP_WH_PER_L_K * dt_eff) if q else None
        row["status"] = "gemeten"

    groups: List[Dict[str, Any]] = []
    notes: List[str] = []
    for key, label in GROUPS:
        members = [r for r in rows if r["_group"] == key]
        if not members:
            continue
        g = _distribute(key, label, members, cfg, notes)
        groups.append(g)

    for r in rows:
        if r["status"] != "gemeten":
            continue
        ratio = min(r["ratio_raw"] * r["_scale"], RATIO_CAP)
        r["ratio"] = ratio
        if r.get("flow_act"):
            r["flow_target"] = r["flow_act"] * ratio
        _advise(r, ratio, tol, valves, project)

    counts = {k: 0 for k in ("ok", "open", "dicht", "ongeldig", "geen_meting")}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    methods = {g["method"] for g in groups if g["measured"]}
    summary = {"counts": counts, "notes": notes, "total": len(rows), "groups": groups,
               "pump_advice": [g["pump_advice"] for g in groups if g.get("pump_advice")]}
    for r in rows:
        for k in ("_lm_m", "_dt_eff", "_group", "_scale", "nominal", "n"):
            r.pop(k, None)
        for k, v in list(r.items()):
            if isinstance(v, float):
                r[k] = round(v, 3)
    return {"method": "vraag" if methods == {"vraag"} else "dt", "summary": summary,
            "emitters": rows}


def _distribute(key: str, label: str, members: List[Dict[str, Any]], cfg: Dict[str, Any],
                notes: List[str]) -> Dict[str, Any]:
    """Bepaal ratio_raw en de normalisatiefactor voor één groep (één watercircuit)."""
    measured = [r for r in members if r["status"] == "gemeten"]
    target_dt = max(float(cfg["ufh_target_dt"] if key == "vloer" else cfg["target_dt"]), 0.5)
    g: Dict[str, Any] = {"key": key, "label": label, "target_dt": target_dt,
                         "members": len(members), "measured": len(measured), "method": "dt"}
    if not measured:
        return g
    use_demand = cfg["method"] == "auto" and all(r["power_w"] and r["demand_w"] for r in measured)
    scale = 1.0
    if use_demand:
        g["method"] = "vraag"
        f = sum(r["q_act"] for r in measured) / sum(r["demand_w"] for r in measured)
        for r in measured:
            q_t = f * r["demand_w"]
            r["q_target"] = q_t
            t_o, sat = solve_t_out(q_t, r["power_w"], r["n"], r["nominal"],
                                   r["t_in"], r["t_room"])
            if sat:
                r["ratio_raw"] = RATIO_CAP
                r["warnings"].append("Element is te klein voor de warmtevraag bij deze "
                                     "aanvoertemperatuur: volledig open zetten")
            else:
                r["target_t_out"] = t_o
                flow_t = q_t / (CP_WH_PER_L_K * (r["t_in"] - t_o))
                r["ratio_raw"] = flow_t / r["flow_act"]
    else:
        if cfg["method"] == "auto" and any(r["demand_w"] for r in measured):
            notes.append(f"{label}: vul bij álle gemeten elementen vermogen én warmtevraag in om "
                         "op warmtevraag in te regelen; nu wordt op gelijk ΔT ingeregeld.")
        for r in measured:
            t_o_target = r["t_in"] - target_dt
            if t_o_target <= r["t_room"] + 1:
                t_o_target = r["t_room"] + 1
                r["warnings"].append(f"Doel-ΔT {target_dt:g} K is bij {r['t_in']:g} °C aanvoer "
                                     "niet haalbaar; gerekend met de laagst mogelijke retour")
            r["target_t_out"] = t_o_target
            lm_t = lmtd(r["t_in"], t_o_target, r["t_room"])
            dt_t = r["t_in"] - t_o_target
            r["ratio_raw"] = (lm_t / r["_lm_m"]) ** r["n"] * r["_dt_eff"] / dt_t
        # Met één element valt er niets te verdelen: dan geldt het ruwe advies.
        if cfg["keep_total_flow"] and len(measured) >= 2:
            known = [r["flow_act"] for r in measured if r.get("flow_act")]
            # onbekend debiet: schat als het gemiddelde van de bekende (anders gelijk gewicht)
            fill = sum(known) / len(known) if known else 1.0
            w = [r.get("flow_act") or fill for r in measured]
            scale = sum(w) / sum(wi * r["ratio_raw"] for wi, r in zip(w, measured))
            if 0 < len(known) < len(measured):
                notes.append(f"{label}: niet bij alle elementen is het vermogen bekend; voor die "
                             "elementen is het gemiddelde debiet aangenomen.")
            g["pump_factor"] = round(1 / scale, 2)
            g["pump_advice"] = _pump_text(label, 1 / scale, target_dt)
    for r in members:
        r["_scale"] = scale

    flows = [r for r in measured if r.get("flow_act")]
    g["dt_mean"] = round(sum(r["dt"] for r in measured) / len(measured), 2)
    if flows:
        tot = sum(r["flow_act"] for r in flows)
        g["flow_total"] = round(tot, 1)
        g["dt_weighted"] = round(sum(r["flow_act"] * r["_dt_eff"] for r in flows) / tot, 2)
        g["q_total"] = round(sum(r["q_act"] for r in flows))
        if use_demand:
            need = sum(r["flow_act"] * min(r["ratio_raw"], RATIO_CAP) for r in flows) / tot
            g["pump_factor"] = round(need, 2)
            g["pump_advice"] = _pump_text(label, need, None)
    return g


def _pump_text(label: str, need: float, target_dt: Optional[float]) -> Optional[str]:
    """need = benodigd totaal debiet t.o.v. het huidige."""
    goal = f"overal ΔT {target_dt:g} K te halen" if target_dt else "de warmtevraag te verdelen"
    if need > 1.15:
        return (f"{label}: om {goal} is ~{(need - 1) * 100:.0f}% meer totaal debiet nodig — "
                "zet de pomp hoger (of accepteer een grotere ΔT).")
    if need < 0.85:
        return (f"{label}: het totale debiet is ~{(1 - need) / need * 100:.0f}% hoger dan nodig "
                f"om {goal} — de pomp kan lager, dat geeft een lagere retourtemperatuur.")
    return None


def _advise(r: Dict[str, Any], ratio: float, tol: float,
            valves: Dict[str, Dict[str, Any]], project: Dict[str, Any]) -> None:
    em = next(e for e in project["emitters"] if e["id"] == r["id"])
    valve = valves.get(em.get("valve_type") or "")
    pct = (ratio - 1) * 100
    if abs(ratio - 1) <= tol:
        status = "ok"
    elif ratio > 1:
        status = "open"
    else:
        status = "dicht"
    strong = ratio > 1.3 or ratio < 1 / 1.3
    r["severity"] = "flink" if strong and status != "ok" else ("iets" if status != "ok" else "")

    preset = r.get("preset_measured")
    current = _num(em.get("preset"))
    if preset is None:
        preset = current
    elif current is not None and abs(current - preset) > 1e-6:
        r["stale"] = True
        r["warnings"].append(f"Stand is na de laatste meting gewijzigd "
                             f"({setting_label(valve, preset)} → {setting_label(valve, current)}); "
                             "doe een nieuwe meting")
    r["preset_basis"] = preset
    r["preset_basis_label"] = setting_label(valve, preset)

    if valve and preset is not None:
        kv = kv_at(valve, preset)
        if kv and kv > 0:
            raw, limit = setting_for_kv(valve, kv * ratio)
            new = round_setting(valve, raw)
            r["preset_advice"] = new
            r["preset_advice_label"] = setting_label(valve, new)
            r["valve_limit"] = limit
            if limit == "max" and status == "open":
                r["warnings"].append("Ventiel kan niet verder open: zet dit element volledig open; "
                                     "de rest dichter draaien of de pomp hoger zetten helpt")
            if limit == "min" and status == "dicht":
                r["warnings"].append("Ventiel staat al op de laagste stand: knijp af met de "
                                     "retourkoppeling of zet de pomp lager")
            if (status != "ok" and limit == "ok"
                    and abs(new - round_setting(valve, preset)) < 1e-6):
                status = "ok"
                r["severity"] = ""
                r["warnings"].append("Afwijking is kleiner dan één stap van het ventiel")
        else:
            r["warnings"].append("Ventiel staat dicht volgens de opgegeven stand")
    r["status"] = status

    if status == "ok":
        txt = "Goed ingeregeld"
    else:
        word = "verder open" if status == "open" else "verder dicht"
        txt = f"{'Flink' if r['severity'] == 'flink' else 'Iets'} {word} ({pct:+.0f}% debiet)"
    if r.get("preset_advice") is not None and status != "ok":
        txt += f" → stand {r['preset_basis_label']} naar {r['preset_advice_label']}"
    r["advice"] = txt
