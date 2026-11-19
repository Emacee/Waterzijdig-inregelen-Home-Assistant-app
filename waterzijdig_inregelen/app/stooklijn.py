"""Stooklijn: van historisch gasverbruik en graaddagen naar de benodigde aanvoertemperatuur.

1. **Warmteverliescoëfficiënt uit het gasverbruik.** Per periode geldt ongeveer::

       gas [m³] = a · dagen + b · graaddagen

   met ``a`` het gas voor warm water en koken per dag en ``b`` het gas per graaddag. Met
   genoeg perioden (ook zomermaanden) volgen ``a`` en ``b`` uit een kleinste-kwadratenfit;
   anders wordt ``a`` uit de instelling *warm water en koken* gehaald. Graaddagen zijn
   ongewogen: per dag ``max(0, stookgrens − etmaalgemiddelde)``. Dan::

       H [W/K] = b · kWh/m³ · rendement · 1000 / 24
       P_ontwerp = H · (stookgrens − ontwerp-buitentemperatuur)

   De stookgrens (standaard 18 °C) verdisconteert de interne warmte (zon, mensen,
   apparaten): onder de stookgrens is de warmtevraag evenredig met het verschil.

2. **Last per element.** Uit de warmteverliesberekening (aandeel per element, zie
   ``balance.design``), eventueel geschaald zodat het totaal gelijk is aan ``P_ontwerp``
   uit het gasverbruik. Zonder warmteverliesberekening wordt ``P_ontwerp`` over de
   elementen verdeeld naar vermogen. Bij buitentemperatuur ``T`` is de last
   ``q · (stookgrens − T) / (stookgrens − ontwerp-buitentemperatuur)``.

3. **Stooklijn per groep** (radiatoren, vloerverwarming). Ontwerppunt: de laagste
   aanvoer waarbij élk element zijn last haalt met het doel-ΔT van de groep; het element
   dat die aanvoer bepaalt is het *kritische* element. De debieten liggen daarmee vast
   (ingeregeld, thermostaatkranen open). Bij elke buitentemperatuur is de benodigde
   aanvoer de hoogste over alle elementen bij dat vaste debiet. Omdat ketels meestal een
   rechte stooklijn hebben, wordt ook de rechte lijn door het ontwerppunt gegeven die
   overal minstens de benodigde aanvoer levert.
"""
from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import heatloss
from .balance import CP_WH_PER_L_K, _num, design, heat_output, settings_of, solve_t_out

KNMI_URL = "https://www.daggegevens.knmi.nl/klimatologie/daggegevens"
KNMI_STATIONS: List[Tuple[int, str]] = [
    (260, "De Bilt"), (240, "Schiphol"), (269, "Lelystad"), (235, "De Kooy"),
    (270, "Leeuwarden"), (280, "Eelde"), (279, "Hoogeveen"), (278, "Heino"),
    (290, "Twenthe"), (283, "Hupsel"), (275, "Deelen"), (356, "Herwijnen"),
    (348, "Cabauw"), (344, "Rotterdam"), (330, "Hoek van Holland"), (310, "Vlissingen"),
    (350, "Gilze-Rijen"), (370, "Eindhoven"), (375, "Volkel"), (391, "Arcen"),
    (380, "Maastricht"),
]
STATION_IDS = {s for s, _ in KNMI_STATIONS}
MAX_PERIODS = 4000
MAX_FETCH_DAYS = 3700
T_MAX = 110.0  # hoger dan dit rekent de stooklijn niet


# ---- datums en invoer -------------------------------------------------------

_MONTHS = {"jan": 1, "feb": 2, "mrt": 3, "maa": 3, "mar": 3, "apr": 4, "mei": 5, "may": 5,
           "jun": 6, "jul": 7, "aug": 8, "sep": 9, "okt": 10, "oct": 10, "nov": 11, "dec": 12}


def parse_date(text: Any) -> Optional[Tuple[date, bool]]:
    """(datum, is_maand) uit '2024-01-31', '31-1-2024', '2024-01', '1-2024' of 'jan 2024'."""
    s = str(text or "").strip().lower()
    try:
        m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t].*)?$", s)
        if m:
            return date(int(m[1]), int(m[2]), int(m[3])), False
        m = re.match(r"^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:\s.*)?$", s)
        if m:
            return date(int(m[3]), int(m[2]), int(m[1])), False
        m = re.match(r"^(\d{4})[-/](\d{1,2})$", s)
        if m:
            return date(int(m[1]), int(m[2]), 1), True
        m = re.match(r"^(\d{1,2})[-/](\d{4})$", s)
        if m:
            return date(int(m[2]), int(m[1]), 1), True
        m = re.match(r"^([a-z]{3})[a-z]*\.?[\s'-]*(\d{4})$", s)
        if m and m[1] in _MONTHS:
            return date(int(m[2]), _MONTHS[m[1]], 1), True
    except ValueError:
        return None
    return None


def _next_month(d: date) -> date:
    return date(d.year + d.month // 12, d.month % 12 + 1, 1)


def parse_periods(text: str) -> Tuple[List[Dict[str, Any]], str]:
    """Perioden uit geplakte tekst (bijv. uit Excel). Geeft (perioden, uitleg).

    Herkent per regel: twee datums + verbruik [+ graaddagen]; een maand + verbruik
    [+ graaddagen]; of een datum + getal. Datum + getal zijn **meterstanden** als de
    getallen oplopen, anders het verbruik vanaf die datum tot de volgende regel.
    """
    rows = heatloss.read_text(text.encode("utf-8"))
    periods: List[Dict[str, Any]] = []
    singles: List[Tuple[date, float]] = []
    kinds = set()
    for row in rows:
        dates, nums = [], []
        for cell in row:
            d = parse_date(cell)
            if d:
                dates.append(d)
                continue
            v = heatloss.to_number(cell)
            if v is not None:
                nums.append(v)
        if not nums:
            continue
        dd = nums[1] if len(nums) > 1 else None
        if len(dates) >= 2:
            periods.append(_period(dates[0][0], dates[1][0], nums[0], dd))
            kinds.add("van–tot")
        elif len(dates) == 1 and dates[0][1]:
            periods.append(_period(dates[0][0], _next_month(dates[0][0]), nums[0], dd))
            kinds.add("per maand")
        elif len(dates) == 1:
            singles.append((dates[0][0], nums[0]))
    if len(singles) >= 2:
        singles.sort()
        vals = [v for _, v in singles]
        rising = all(b >= a for a, b in zip(vals, vals[1:]))
        if rising and vals[0] >= 0.5 * (vals[-1] - vals[0]):
            kinds.add("meterstanden")
            for (d0, v0), (d1, v1) in zip(singles, singles[1:]):
                periods.append(_period(d0, d1, v1 - v0, None))
        else:
            kinds.add("verbruik vanaf datum")
            for i, (d0, v0) in enumerate(singles):
                d1 = singles[i + 1][0] if i + 1 < len(singles) else d0 + (d0 - singles[i - 1][0])
                periods.append(_period(d0, d1, v0, None))
    periods = sorted((p for p in periods if p), key=lambda p: p["start"])[:MAX_PERIODS]
    msg = f"{len(periods)} periode(n) herkend" + (f" ({', '.join(sorted(kinds))})" if kinds else "")
    return periods, msg


def _period(start: date, end: date, gas: float, dd: Optional[float]) -> Optional[Dict[str, Any]]:
    if end <= start or not 0 <= gas < 100000 or (end - start).days > MAX_FETCH_DAYS:
        return None
    if dd is not None and not 0 <= dd < 10000:
        dd = None
    return {"start": start.isoformat(), "end": end.isoformat(), "gas_m3": round(gas, 3),
            "degree_days": dd}


# ---- KNMI -----------------------------------------------------------------------

def fetch_knmi(station: int, start: date, end: date) -> Dict[str, float]:
    """Etmaalgemiddelde temperatuur [°C] per dag (inclusief ``end``) van een KNMI-station."""
    data = urllib.parse.urlencode({"start": start.strftime("%Y%m%d"), "end": end.strftime("%Y%m%d"),
                                   "vars": "TG", "stns": str(station), "fmt": "json"}).encode()
    req = urllib.request.Request(KNMI_URL, data=data,
                                 headers={"User-Agent": "waterzijdig-inregelen"})
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 (vaste https-URL)
        rows = json.loads(resp.read(20 * 1024 * 1024))
    out = {}
    for r in rows:
        if isinstance(r, dict) and r.get("TG") is not None and r.get("date"):
            out[str(r["date"])[:10]] = round(float(r["TG"]) / 10, 1)
    return out


def periods_span(periods: Sequence[Dict[str, Any]]) -> Optional[Tuple[date, date]]:
    """Eerste en laatste dag waarvoor temperaturen nodig zijn."""
    if not periods:
        return None
    start = min(date.fromisoformat(p["start"]) for p in periods)
    end = max(date.fromisoformat(p["end"]) for p in periods) - timedelta(days=1)
    return start, end


# ---- gasverbruik → H ----------------------------------------------------------

def _degree_days(p: Dict[str, Any], temps: Dict[str, float], base: float) -> Tuple[Optional[float], str]:
    if _num(p.get("degree_days")) is not None:
        return float(p["degree_days"]), "handmatig"
    d, end = date.fromisoformat(p["start"]), date.fromisoformat(p["end"])
    total = 0.0
    while d < end:
        t = temps.get(d.isoformat())
        if t is None:
            return None, ""
        total += max(0.0, base - t)
        d += timedelta(days=1)
    return round(total, 1), "knmi"


def gas_analysis(project: Dict[str, Any], cfg: Dict[str, Any]) -> Dict[str, Any]:
    base = float(cfg["heating_limit_temp"])
    t_d = float(cfg["outdoor_design_temp"])
    temps = (project.get("knmi") or {}).get("temps") or {}
    rows, notes = [], []
    for p in project.get("gas_periods") or []:
        days = (date.fromisoformat(p["end"]) - date.fromisoformat(p["start"])).days
        dd, src = _degree_days(p, temps, base)
        rows.append({**p, "days": days, "dd": dd, "dd_source": src,
                     "gas_per_day": p["gas_m3"] / days, "dd_per_day": dd / days if dd is not None else None})
    out: Dict[str, Any] = {"periods": rows, "ok": False, "notes": notes}
    use = [r for r in rows if r["dd"] is not None]
    if len(use) < len(rows):
        notes.append(f"{len(rows) - len(use)} periode(n) zonder graaddagen: haal ze op bij het KNMI "
                     "of vul ze in.")
    if any(r["dd_source"] == "handmatig" for r in use) and abs(base - 18) > 0.05:
        notes.append("Handmatig ingevulde graaddagen gaan meestal uit van 18 °C; de stookgrens staat "
                     f"op {base:g} °C.")
    if not use or sum(r["dd"] for r in use) <= 0:
        return out
    d = [r["days"] for r in use]
    g = [r["dd"] for r in use]
    y = [r["gas_m3"] for r in use]
    sdd = sum(x * x for x in d)
    sdg = sum(a * b for a, b in zip(d, g))
    sgg = sum(x * x for x in g)
    sdy = sum(a * b for a, b in zip(d, y))
    sgy = sum(a * b for a, b in zip(g, y))
    det = sdd * sgg - sdg * sdg
    dhw = _num(cfg.get("dhw_gas_m3_year"))
    method = None
    if dhw is None and len(use) >= 3 and det > 0.02 * sdd * sgg:
        a = (sdy * sgg - sgy * sdg) / det
        b = (sdd * sgy - sdg * sdy) / det
        if a >= 0 and b > 0:
            method = "regressie"
    if method is None:
        a = (dhw or 0.0) / 365
        b = (sum(y) - a * sum(d)) / sum(g)
        method = "warm_water" if dhw is not None else "zonder_warm_water"
        if dhw is None:
            notes.append("Te weinig variatie in de perioden om warm water en koken van verwarming te "
                         "scheiden (neem ook zomermaanden mee). Nu telt al het gas als verwarming: de "
                         "warmtebehoefte is daardoor te hoog. Vul anders 'warm water en koken' in.")
    if b <= 0:
        notes.append("Het gas voor warm water en koken is groter dan het totale verbruik: controleer "
                     "de invoer.")
        return out
    # R² op het verbruik per dag (gewogen naar lengte)
    yd = [yy / dd_ for yy, dd_ in zip(y, d)]
    xd = [gg / dd_ for gg, dd_ in zip(g, d)]
    w_tot = sum(d)
    mean = sum(v * w for v, w in zip(yd, d)) / w_tot
    ss_tot = sum(w * (v - mean) ** 2 for v, w in zip(yd, d))
    ss_res = sum(w * (v - (a + b * x)) ** 2 for v, x, w in zip(yd, xd, d))
    kwh, eta = float(cfg["gas_kwh_per_m3"]), float(cfg["boiler_efficiency"])
    h = b * kwh * eta * 1000 / 24
    out.update(ok=True, method=method, base_m3_day=a, m3_per_dd=b, h_w_per_k=h,
               p_design_w=h * (base - t_d), r2=(1 - ss_res / ss_tot) if ss_tot > 0 else None,
               days=w_tot, gas_total=sum(y), dd_total=sum(g),
               heating_m3_year=b * sum(g) / w_tot * 365, dhw_m3_year=a * 365)
    if out["r2"] is not None and out["r2"] < 0.7 and method == "regressie":
        notes.append(f"De perioden passen matig op het model (R² {out['r2']:.2f}): controleer "
                     "afwijkende perioden (vakantie, andere bewoning, open haard).")
    return out


# ---- stooklijn --------------------------------------------------------------------

def supply_needed(q: float, p_nom: float, n: float, nominal: Sequence[float], theta: float,
                  dt: float) -> Optional[float]:
    """Laagste aanvoer waarbij het element ``q`` afgeeft met ΔT = ``dt``; None als > T_MAX."""
    lo, hi = theta + dt + 1e-3, T_MAX
    if (heat_output(p_nom, n, nominal, hi, hi - dt, theta) or 0) < q:
        return None
    for _ in range(50):
        mid = (lo + hi) / 2
        if (heat_output(p_nom, n, nominal, mid, mid - dt, theta) or 0) < q:
            lo = mid
        else:
            hi = mid
    return hi


def supply_at_flow(q: float, flow: float, p_nom: float, n: float, nominal: Sequence[float],
                   theta: float) -> float:
    """Aanvoer waarbij het element ``q`` afgeeft bij een vast debiet [l/h]."""
    if q <= 0:
        return theta
    dt = q / (CP_WH_PER_L_K * flow)
    lo, hi = theta + dt + 1e-3, T_MAX + 10
    if (heat_output(p_nom, n, nominal, hi, hi - dt, theta) or 0) < q:
        return hi
    for _ in range(50):
        mid = (lo + hi) / 2
        if (heat_output(p_nom, n, nominal, mid, mid - dt, theta) or 0) < q:
            lo = mid
        else:
            hi = mid
    return hi


def _loads(project: Dict[str, Any], cfg: Dict[str, Any], gas: Dict[str, Any],
           notes: List[str]) -> Tuple[str, List[Dict[str, Any]], Optional[float]]:
    """(basis, lasten per element bij ontwerp-buitentemperatuur, schaalfactor)."""
    # aandelen uit de warmteverliesberekening, ongeschaald en ook zonder ontwerp-aanvoer
    c2 = dict(cfg, loss_factor=1.0)
    c2["design_supply_temp"] = c2.get("design_supply_temp") or c2.get("supply_temp") or 55.0
    c2["ufh_design_supply_temp"] = (c2.get("ufh_design_supply_temp") or c2.get("ufh_supply_temp")
                                    or 35.0)
    per, _ = design(project, c2)
    ems = [e for e in project.get("emitters") or [] if _num(e.get("power_w"))]
    calc = [{"em": e, "q": per[e["id"]]["design_q"], "theta": per[e["id"]]["room_temp"]}
            for e in ems if per.get(e["id"], {}).get("design_q")]
    want = cfg.get("curve_basis") or "auto"
    if want == "warmteverlies" or (want == "auto" and not gas.get("ok")):
        if calc and len(calc) < len(ems):
            notes.append(f"{len(ems) - len(calc)} element(en) met vermogen zitten niet in een complete "
                         "ruimte van de warmteverliesberekening en tellen niet mee.")
        return ("warmteverlies" if calc else ""), calc, None
    if not gas.get("ok"):
        return "", [], None
    p = gas["p_design_w"]
    if calc:
        k = p / sum(c["q"] for c in calc)
        if len(calc) < len(ems):
            notes.append(f"{len(ems) - len(calc)} element(en) met vermogen zitten niet in een complete "
                         "ruimte van de warmteverliesberekening en tellen niet mee.")
        return "gas_geschaald", [dict(c, q=c["q"] * k) for c in calc], k
    if not ems:
        return "", [], None
    tot = sum(float(e["power_w"]) for e in ems)
    theta = float(cfg["room_temp"])
    return "gas", [{"em": e, "q": p * float(e["power_w"]) / tot,
                    "theta": per.get(e["id"], {}).get("room_temp", theta)} for e in ems], None


def _curve(label: str, items: List[Dict[str, Any]], n: float, nominal: Sequence[float],
           dt: float, t_d: float, base: float) -> Dict[str, Any]:
    reqs = []
    all_items, items = items, []
    for it in all_items:
        em = it["em"]
        t = supply_needed(it["q"], float(em["power_w"]), n, nominal, it["theta"], dt)
        reqs.append({"id": em["id"], "name": em.get("name") or "", "room": em.get("room") or "",
                     "q": round(it["q"]), "theta": it["theta"],
                     "supply": round(t, 1) if t is not None else None})
        if t is not None:
            items.append(it)
    out: Dict[str, Any] = {"label": label, "target_dt": dt, "elements": len(all_items)}
    unreachable = [r for r in reqs if r["supply"] is None]
    if unreachable:
        out["unreachable"] = [f"{r['name']} ({r['room']})" if r["room"] else r["name"]
                              for r in unreachable]
    reach = [r for r in reqs if r["supply"] is not None]
    if not reach:
        return out
    t_sd = max(r["supply"] for r in reach)
    crit = sorted(reach, key=lambda r: -r["supply"])
    out["critical"] = crit[:5]
    # debieten bij het ontwerppunt (ingeregeld): elk element haalt precies zijn last
    flows = []
    for it in items:
        p_nom = float(it["em"]["power_w"])
        t_r, sat = solve_t_out(it["q"], p_nom, n, nominal, t_sd, it["theta"])
        flows.append(it["q"] / (CP_WH_PER_L_K * (t_sd - t_r)) if not sat and t_r is not None
                     else it["q"] / (CP_WH_PER_L_K * 0.5))
    points = []
    t_o = t_d
    while t_o <= base + 1e-9:
        f = max(0.0, (base - t_o) / (base - t_d))
        ts = max(supply_at_flow(it["q"] * f, m, float(it["em"]["power_w"]), n, nominal, it["theta"])
                 for it, m in zip(items, flows))
        tot = sum(flows)
        tr = sum(m * (ts - it["q"] * f / (CP_WH_PER_L_K * m)) for it, m in zip(items, flows)) / tot
        points.append({"t_out": round(t_o, 1), "supply": round(ts, 1), "return": round(tr, 1),
                       "load_w": round(sum(it["q"] for it in items) * f)})
        t_o += 1.0
    # rechte lijn door het ontwerppunt die nergens onder de benodigde aanvoer komt
    end = _ceil_half(t_sd)
    foot = max((end + (pt["supply"] - end) * (base - t_d) / (pt["t_out"] - t_d)
                for pt in points if pt["t_out"] > t_d + 1e-6), default=end)
    foot = _ceil_half(max(foot, max(r["theta"] for r in reach)))
    out.update(design_supply=round(t_sd, 1), design_return=points[0]["return"],
               flow_total=round(sum(flows)), points=points,
               line={"t_design": t_d, "end": end, "t_base": base, "foot": foot,
                     "slope": round((end - foot) / (base - t_d), 2),
                     "at_0": round(foot + (end - foot) * base / (base - t_d), 1)})
    if len(crit) > 1:
        out["second_supply"] = crit[1]["supply"]
    return out


def _ceil_half(v: float) -> float:
    return -(-round(v * 2, 6) // 1) / 2


def analyze(project: Dict[str, Any]) -> Dict[str, Any]:
    cfg = settings_of(project)
    gas = gas_analysis(project, cfg)
    notes = gas["notes"]
    t_d, base = float(cfg["outdoor_design_temp"]), float(cfg["heating_limit_temp"])
    rooms_loss = sum(_num(r.get("loss_w")) or 0 for r in project.get("rooms") or [])
    out: Dict[str, Any] = {"gas": gas, "notes": notes, "groups": [], "rooms_loss_w": rooms_loss,
                           "stations": KNMI_STATIONS,
                           "knmi": {k: v for k, v in (project.get("knmi") or {}).items()
                                    if k != "temps"}}
    if gas.get("ok") and rooms_loss:
        ratio = rooms_loss / gas["p_design_w"]
        out["calc_vs_gas"] = round(ratio, 2)
        if ratio > 1.8:
            notes.append(f"De warmteverliesberekening ({rooms_loss:.0f} W) is {ratio:.1f}× zo groot als wat "
                         f"het gasverbruik laat zien ({gas['p_design_w']:.0f} W). Zo'n groot verschil wijst "
                         "meestal op een fout: controleer de perioden (ontbrekende maanden, m³ i.p.v. "
                         "meterstanden), het rendement en of de woning toen bewoond en verwarmd werd.")
        elif ratio > 1.15:
            notes.append(f"De warmteverliesberekening ({rooms_loss:.0f} W) ligt {(ratio - 1) * 100:.0f}% "
                         f"boven wat het gasverbruik laat zien ({gas['p_design_w']:.0f} W). Dat is "
                         "gebruikelijk (veilige aannames, interne warmte); de stooklijn rekent "
                         "standaard met het werkelijke verbruik.")
        elif ratio < 0.85:
            notes.append(f"Het gasverbruik wijst op een hogere warmtebehoefte ({gas['p_design_w']:.0f} W) "
                         f"dan de warmteverliesberekening ({rooms_loss:.0f} W). Controleer het rendement, "
                         "het gas voor warm water en of de woning destijds anders werd gestookt.")
    if base - t_d < 5:
        notes.append("Stookgrens en ontwerp-buitentemperatuur liggen te dicht bij elkaar.")
        return out
    basis, loads, k = _loads(project, cfg, gas, notes)
    out.update(basis=basis, scale=round(k, 3) if k else None)
    if not loads:
        return out
    for key, label, is_ufh in (("rad", "Radiatoren", False), ("vloer", "Vloerverwarming", True)):
        items = [it for it in loads if (it["em"].get("type") == "vloerverwarming") == is_ufh]
        if not items:
            continue
        n = float(cfg["ufh_exponent"] if is_ufh else cfg["radiator_exponent"])
        nominal = cfg["ufh_nominal"] if is_ufh else cfg["radiator_nominal"]
        dt = max(float(cfg["ufh_target_dt"] if is_ufh else cfg["target_dt"]), 0.5)
        g = _curve(label, items, n, nominal, dt, t_d, base)
        g["key"] = key
        out["groups"].append(g)
        src = cfg["heat_source"]
        ts = g.get("design_supply")
        if ts is None:
            continue
        if src == "warmtepomp" and ts > 55:
            notes.append(f"{label}: bij {t_d:g} °C buiten is {ts:.0f} °C aanvoer nodig. Een warmtepomp "
                         "werkt het zuinigst onder ~45 °C en haalt boven 55 °C vaak niet: vergroot "
                         "de afgifte in de ruimtes die de stooklijn bepalen.")
        if src == "ketel" and not is_ufh and g["design_return"] > 55:
            notes.append(f"{label}: de retour bij {t_d:g} °C buiten is ~{g['design_return']:.0f} °C. "
                         "Boven ~55 °C condenseert een HR-ketel niet; dat is alleen op de koudste "
                         "dagen het geval.")
    return out
