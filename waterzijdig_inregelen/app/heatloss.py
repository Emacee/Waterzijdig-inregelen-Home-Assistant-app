"""Warmteverliesberekening inlezen: ruimtes met ontwerptemperatuur en warmteverlies.

Rapporten van warmteverliesberekeningen (ISSO 51/53) hebben geen vaste indeling. Daarom
wordt een bestand eerst teruggebracht tot een tabel (rijen met cellen) en daar worden de
ruimtes uit gehaald:

* **met kopregel** (CSV, Excel): de kolommen voor ruimtenaam, ontwerptemperatuur en
  warmteverlies worden aan hun kop herkend;
* **zonder bruikbare kopregel** (tekst uit een PDF): per regel een naam, een temperatuur
  (10–28 °C) en het grootste vermogen.

Het resultaat is altijd een *voorstel*: de gebruiker controleert en koppelt de ruimtes in
de UI voordat er iets wordt opgeslagen.
"""
from __future__ import annotations

import csv
import io
import re
from typing import Any, Dict, List, Optional, Sequence, Tuple

MAX_ROWS = 5000
MAX_COLS = 60
MAX_ROOMS = 300

Table = List[List[str]]

_NAME_HDR = re.compile(r"ruimte|vertrek|naam|room|omschrijving|zone|space", re.I)
_TEMP_HDR = re.compile(r"temp|θ|theta|°c|\bt[\s_]?i\b|setpoint", re.I)
_TEMP_BAD = re.compile(r"buiten|aanvoer|retour|supply|return|outside|grond|aangrenz", re.I)
_LOSS_HDR = re.compile(r"verlies|φ|phi|heat\s?loss|vermogen|warmtevraag|warmtebehoefte|totaal|"
                       r"total|watt|capaciteit|\bk?w\b|\bhl\b", re.I)
_LOSS_BAD = re.compile(r"w\s*/\s*m|per\s*m|/m[2²]|geïnstalleerd|geinstalleerd|opgesteld|radiator",
                       re.I)
_LOSS_PART = re.compile(r"transmissie|ventilatie|infiltratie|opwarm|toeslag", re.I)
_SKIP_NAME = re.compile(r"^(sub)?tota+l|^som\b|^totalen|^pagina\b|^datum\b|^gebouw\b|^woning\b|"
                        r"^project\b|^blad\b", re.I)
_NUM = re.compile(r"(?<![\w.,])(-?\d[\d.,]*)\s*(°\s*c|℃|kw\b|w\s*/\s*m[2²]?|w\b|m[2²3³]|%|k\b)?",
                  re.I)


def to_number(text: Any) -> Optional[float]:
    """Getal uit een cel; komma of punt als decimaalteken, punt/spatie als duizendtal."""
    if isinstance(text, bool) or text is None:
        return None
    if isinstance(text, (int, float)):
        return float(text)
    s = str(text).strip().replace(" ", "").replace(" ", "")
    m = re.match(r"^-?\d[\d.,]*", s)
    if not m:
        return None
    s = m.group(0).rstrip(".,")
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"-?\d{1,3}(\.\d{3})+", s):
        s = s.replace(".", "")
    try:
        return float(s)
    except ValueError:
        return None


def _is_text(cell: str) -> bool:
    return len(re.findall(r"[^\W\d_]", cell)) >= 2


def _clean_name(cell: str) -> str:
    name = re.sub(r"\s+", " ", cell).strip(" :;-–\t")
    return name[:100]


def _room(name: str, temp: Optional[float], loss: Optional[float]) -> Optional[Dict[str, Any]]:
    name = _clean_name(name)
    if not name or not _is_text(name) or _SKIP_NAME.search(name):
        return None
    if loss is None or not 0 < loss <= 100000:
        return None
    if temp is not None and not 5 <= temp <= 30:
        temp = None
    return {"name": name, "temp": temp, "loss_w": round(loss)}


# ---- met kopregel -------------------------------------------------------------

def _loss_score(head: str) -> int:
    if not _LOSS_HDR.search(head) or _LOSS_BAD.search(head):
        return -1
    score = 1
    if re.search(r"tota+l|\bhl\b", head, re.I):
        score += 3
    if re.search(r"verlies|heat\s?loss|warmtevraag|warmtebehoefte", head, re.I):
        score += 2
    if _LOSS_PART.search(head) and not re.search(r"tota+l", head, re.I):
        score -= 2
    return max(score, 0)


def _find_header(table: Table) -> Optional[Tuple[int, int, Optional[int], int, float]]:
    """(rij, naamkolom, temperatuurkolom, verlieskolom, factor naar W) of None."""
    for i, row in enumerate(table[:40]):
        name_c = temp_c = None
        loss_c, best = None, -1
        for j, cell in enumerate(row):
            head = cell.strip()
            if not head or to_number(head) is not None:
                continue
            if name_c is None and _NAME_HDR.search(head) and not _TEMP_HDR.search(head):
                name_c = j
                continue
            if temp_c is None and _TEMP_HDR.search(head) and not _TEMP_BAD.search(head):
                temp_c = j
                continue
            score = _loss_score(head)
            if score > best:
                loss_c, best = j, score
        if name_c is not None and loss_c is not None:
            factor = 1000.0 if re.search(r"\bkw\b", row[loss_c], re.I) else 1.0
            return i, name_c, temp_c, loss_c, factor
    return None


def _with_header(table: Table) -> List[Dict[str, Any]]:
    found = _find_header(table)
    if not found:
        return []
    start, name_c, temp_c, loss_c, factor = found
    out = []
    for row in table[start + 1:]:
        def cell(j: Optional[int]) -> str:
            return row[j] if j is not None and j < len(row) else ""
        loss = to_number(cell(loss_c))
        room = _room(cell(name_c), to_number(cell(temp_c)), loss * factor if loss else None)
        if room:
            out.append(room)
    return out


# ---- zonder kopregel ------------------------------------------------------------

def _from_row(row: Sequence[str]) -> Optional[Dict[str, Any]]:
    cells = [c.strip() for c in row if c and c.strip()]
    name, rest = None, ""
    for i, c in enumerate(cells):
        if _is_text(c) and not re.fullmatch(r"(°\s*c|kw|w|m[2²3³]|w/m[2²]?)", c, re.I):
            name, rest = c, "  ".join(cells[i + 1:])
            break
    if name is None:
        return None
    if not rest.strip():
        # alles in één cel: de naam is de tekst vóór de afsluitende reeks getallen
        m = re.match(r"^(.*?[^\W\d_][^\d]*?)\s+((?:-?\d[\d.,]*\s*(?:°\s*c|℃|kw|w|m[2²3³]|%|k)?\s*)+)$",
                     name, re.I)
        if not m:
            return None
        name, rest = m.group(1), m.group(2)
    temp, temp_unit = None, False
    watts: List[float] = []
    plain: List[float] = []
    for m in _NUM.finditer(rest):
        val = to_number(m.group(1))
        if val is None:
            continue
        unit = re.sub(r"\s+", "", (m.group(2) or "").lower())
        if unit in ("°c", "℃"):
            if not temp_unit and 5 <= val <= 30:
                temp, temp_unit = val, True
        elif unit == "w":
            watts.append(val)
        elif unit == "kw":
            watts.append(val * 1000)
        elif not unit:
            plain.append(val)
    if temp is None:
        for val in plain:
            if 10 <= val <= 28:
                temp = val
                plain.remove(val)
                break
    if temp is None:
        return None
    cand = watts or [v for v in plain if v >= 30]
    return _room(name, temp, max(cand) if cand else None)


def _without_header(table: Table) -> List[Dict[str, Any]]:
    return [r for r in (_from_row(row) for row in table) if r]


def detect(table: Table, headerless: bool = False) -> List[Dict[str, Any]]:
    """Ruimtes uit een tabel; dubbele namen worden samengevoegd (eerste telt)."""
    rooms = [] if headerless else _with_header(table)
    if not rooms:
        rooms = _without_header(table)
    out, seen = [], set()
    for r in rooms:
        key = r["name"].casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
        if len(out) >= MAX_ROOMS:
            break
    return out


# ---- bestanden ----------------------------------------------------------------

def read_text(data: bytes, tabs_only: bool = False) -> Table:
    """CSV/TSV of platte tekst. ``tabs_only``: tekst uit een PDF, cellen gescheiden door tabs."""
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("cp1252", errors="replace")
    lines = text.splitlines()[:MAX_ROWS]
    sample = "\n".join(lines[:50])
    delim = "\t" if tabs_only else max(("\t", ";", ","), key=sample.count)
    if sample.count(delim) == 0:
        return [re.split(r"\s{2,}", ln.strip()) for ln in lines if ln.strip()]
    rows = csv.reader(io.StringIO("\n".join(lines)), delimiter=delim)
    return [[c.strip() for c in row[:MAX_COLS]] for row in rows if any(c.strip() for c in row)]


def read_xlsx(data: bytes) -> List[Table]:
    """Alle werkbladen van een Excel-bestand als tabellen (berekende waarden, geen formules)."""
    from openpyxl import load_workbook  # alleen nodig bij een Excel-upload

    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    tables = []
    try:
        for ws in wb.worksheets[:20]:
            table: Table = []
            for row in ws.iter_rows(max_row=MAX_ROWS, max_col=MAX_COLS, values_only=True):
                cells = ["" if v is None else _cell(v) for v in row]
                if any(cells):
                    table.append(cells)
            tables.append(table)
    finally:
        wb.close()
    return tables


def _cell(v: Any) -> str:
    if isinstance(v, float):
        return repr(round(v, 4)).replace(".", ",")  # ondubbelzinnig voor to_number
    return str(v).strip()


def parse(data: bytes, headerless: bool = False) -> List[Dict[str, Any]]:
    """Herken het bestandstype en geef de gevonden ruimtes. ValueError bij een onleesbaar bestand."""
    if data[:4] == b"PK\x03\x04":
        try:
            tables = read_xlsx(data)
        except Exception as exc:  # openpyxl gooit uiteenlopende fouten bij kapotte bestanden
            raise ValueError("Excel-bestand kon niet gelezen worden") from exc
        return max((detect(t) for t in tables), key=len, default=[])
    if data[:5] == b"%PDF-":
        raise ValueError("Een PDF wordt in de browser naar tekst omgezet; probeer het opnieuw")
    if b"\x00" in data[:4096]:
        raise ValueError("Onbekend bestandstype: gebruik CSV, Excel (.xlsx) of PDF")
    return detect(read_text(data, tabs_only=headerless), headerless)
