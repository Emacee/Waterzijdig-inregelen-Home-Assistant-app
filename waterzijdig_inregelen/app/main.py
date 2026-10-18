"""FastAPI-app: serveert de ingress-UI en een kleine JSON-API.

Alle links in de front-end zijn relatief, zodat de app achter Home Assistant
ingress werkt (die serveert haar onder /api/hassio_ingress/<token>/).
Elke wijziging geeft het volledige project plus de herberekende analyse terug.
"""
from __future__ import annotations

import csv
import io
import json
import logging
import os
from typing import Any, Dict, List, Literal, Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from . import __version__
from .balance import analyze, settings_of, supply_temp
from .store import NotFound, Store, find, new_id, now_iso

_WEB = os.path.join(os.path.dirname(__file__), "web")
_LOGGER = logging.getLogger(__name__)


def _options() -> Dict[str, Any]:
    try:
        with open(os.environ.get("OPTIONS_FILE", "/data/options.json"), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


OPTIONS = _options()
MAX_UPLOAD = int(OPTIONS.get("max_upload_mb", 25)) * 1024 * 1024
store = Store(os.environ.get("DATA_DIR", "/data"))

app = FastAPI(title="Waterzijdig Inregelen", version=__version__)
app.mount("/static", StaticFiles(directory=os.path.join(_WEB, "static")), name="static")


@app.exception_handler(NotFound)
async def _not_found(_: Request, exc: NotFound):
    return JSONResponse({"detail": "Niet gevonden"}, status_code=404)


def _out(p: Dict[str, Any]) -> Dict[str, Any]:
    return {"project": p, "analysis": analyze(p)}


# ---- payloads ----------------------------------------------------------------

class _M(BaseModel):
    model_config = ConfigDict(extra="ignore")


class ProjectCreate(_M):
    name: str = Field("Nieuw project", max_length=200)
    address: str = Field("", max_length=300)
    heat_source: Literal["ketel", "warmtepomp", "anders"] = "ketel"


class Settings(_M):
    heat_source: Optional[Literal["ketel", "warmtepomp", "anders"]] = None
    target_dt: Optional[float] = Field(None, ge=0.5, le=60)
    ufh_target_dt: Optional[float] = Field(None, ge=0.5, le=30)
    room_temp: Optional[float] = Field(None, ge=0, le=35)
    supply_temp: Optional[float] = Field(None, ge=20, le=95)
    ufh_supply_temp: Optional[float] = Field(None, ge=20, le=60)
    tolerance_pct: Optional[float] = Field(None, ge=0, le=100)
    keep_total_flow: Optional[bool] = None
    method: Optional[Literal["auto", "dt"]] = None
    radiator_exponent: Optional[float] = Field(None, ge=0.8, le=2.0)
    ufh_exponent: Optional[float] = Field(None, ge=0.8, le=2.0)
    radiator_nominal: Optional[List[float]] = Field(None, min_length=3, max_length=3)
    ufh_nominal: Optional[List[float]] = Field(None, min_length=3, max_length=3)


# Deze instellingen mogen expliciet leeg (null) gemaakt worden.
_NULLABLE_SETTINGS = ("supply_temp", "ufh_supply_temp")


class ValveType(_M):
    id: str = Field(..., min_length=1, max_length=40)
    name: str = Field(..., max_length=100)
    resolution: float = Field(0.5, ge=0, le=100)
    steps: List[List[Any]] = Field(..., min_length=1, max_length=100)


class ProjectUpdate(_M):
    name: Optional[str] = Field(None, max_length=200)
    address: Optional[str] = Field(None, max_length=300)
    notes: Optional[str] = Field(None, max_length=20000)
    settings: Optional[Settings] = None
    valve_types: Optional[List[ValveType]] = None


class EmitterIn(_M):
    floorplan_id: Optional[str] = None
    x: Optional[float] = Field(None, ge=0, le=1)
    y: Optional[float] = Field(None, ge=0, le=1)
    type: Optional[Literal["radiator", "vloerverwarming", "convector"]] = None
    name: Optional[str] = Field(None, max_length=100)
    room: Optional[str] = Field(None, max_length=100)
    power_w: Optional[float] = Field(None, ge=0, le=100000)
    demand_w: Optional[float] = Field(None, ge=0, le=100000)
    valve_type: Optional[str] = Field(None, max_length=40)
    preset: Optional[float] = Field(None, ge=0, le=1000)
    notes: Optional[str] = Field(None, max_length=5000)


class MeasurementIn(_M):
    t_in: Optional[float] = Field(None, ge=-10, le=110)  # leeg = cv-aanvoertemperatuur
    t_out: float = Field(..., ge=-10, le=110)
    t_room: Optional[float] = Field(None, ge=-10, le=40)
    ts: Optional[str] = None


class BatchItem(MeasurementIn):
    emitter_id: str


class Batch(_M):
    items: List[BatchItem] = Field(..., max_length=500)


# ---- pagina ------------------------------------------------------------------

@app.get("/")
async def index():
    return FileResponse(os.path.join(_WEB, "index.html"),
                        headers={"Cache-Control": "no-cache"})


@app.get("/api/health")
async def health():
    return {"ok": True, "version": __version__}


# ---- projecten ---------------------------------------------------------------

@app.get("/api/projects")
async def list_projects():
    return store.list()


@app.post("/api/projects")
async def create_project(body: ProjectCreate):
    settings = {"heat_source": body.heat_source,
                "target_dt": 5.0 if body.heat_source == "warmtepomp" else 20.0}
    return _out(store.create(body.name, body.address, settings))


@app.get("/api/projects/{pid}")
async def get_project(pid: str):
    return _out(store.get(pid))


@app.put("/api/projects/{pid}")
async def update_project(pid: str, body: ProjectUpdate):
    p = store.get(pid)
    for k in ("name", "address", "notes"):
        v = getattr(body, k)
        if v is not None:
            p[k] = v
    if body.settings:
        p["settings"].update(body.settings.model_dump(exclude_none=True))
        for k in _NULLABLE_SETTINGS:
            if k in body.settings.model_fields_set and getattr(body.settings, k) is None:
                p["settings"][k] = None
    if body.valve_types is not None:
        p["valve_types"] = [v.model_dump() for v in body.valve_types]
    return _out(store.save(p))


@app.delete("/api/projects/{pid}")
async def delete_project(pid: str):
    store.delete(pid)
    return {"ok": True}


@app.get("/api/projects/{pid}/export.csv")
async def export_csv(pid: str):
    p = store.get(pid)
    a = {r["id"]: r for r in analyze(p)["emitters"]}
    fps = {f["id"]: f["name"] for f in p["floorplans"]}
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["Plattegrond", "Ruimte", "Naam", "Type", "Vermogen (W)", "Warmtevraag (W)",
                "Ventiel", "Stand", "Gemeten op", "Aanvoer", "Retour", "Ruimte °C", "ΔT",
                "Debiet (l/h)", "Doeldebiet (l/h)", "Factor", "Advies stand", "Advies"])
    for e in p["emitters"]:
        r = a.get(e["id"], {})
        w.writerow([fps.get(e.get("floorplan_id"), ""), e.get("room", ""), e.get("name", ""),
                    e.get("type", ""), e.get("power_w") or "", e.get("demand_w") or "",
                    e.get("valve_type") or "", e.get("preset") if e.get("preset") is not None else "",
                    r.get("measured_at", ""), r.get("t_in", ""), r.get("t_out", ""),
                    r.get("t_room", ""), r.get("dt", ""), _r(r.get("flow_act")),
                    _r(r.get("flow_target")), _r(r.get("ratio"), 2),
                    r.get("preset_advice_label", ""), r.get("advice", "")])
    name = "".join(c for c in p["name"] if c.isalnum() or c in " -_").strip() or "project"
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}.csv"'})


def _r(v, nd=0):
    return "" if v is None else (f"{v:.{nd}f}".replace(".", ","))


# ---- plattegronden ---------------------------------------------------------

_MAGIC = {
    b"\x89PNG\r\n\x1a\n": "png",
    b"\xff\xd8\xff": "jpg",
    b"GIF87a": "gif",
    b"GIF89a": "gif",
}


def _sniff(data: bytes) -> Optional[str]:
    for magic, ext in _MAGIC.items():
        if data.startswith(magic):
            return ext
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


@app.post("/api/projects/{pid}/floorplans")
async def upload_floorplan(pid: str, file: UploadFile = File(...), name: str = Form(""),
                           width: int = Form(0), height: int = Form(0)):
    store.get(pid)
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, f"Bestand groter dan {MAX_UPLOAD // 1024 // 1024} MB")
    ext = _sniff(data)
    if not ext:
        raise HTTPException(415, "Alleen PNG, JPG, GIF of WebP (PDF wordt in de browser omgezet)")
    if not name:
        name = os.path.splitext(file.filename or "")[0][:100]
    return _out(store.add_floorplan(pid, name[:100], ext, data, max(width, 0), max(height, 0)))


@app.get("/api/projects/{pid}/floorplans/{fid}/image")
async def floorplan_image(pid: str, fid: str):
    p = store.get(pid)
    fp = find(p["floorplans"], fid)
    path = store.floorplan_path(pid, fp)
    if not os.path.exists(path):
        raise NotFound(fid)
    return FileResponse(path, headers={"Cache-Control": "private, max-age=86400",
                                       "X-Content-Type-Options": "nosniff"})


@app.put("/api/projects/{pid}/floorplans/{fid}")
async def rename_floorplan(pid: str, fid: str, body: Dict[str, Any]):
    p = store.get(pid)
    fp = find(p["floorplans"], fid)
    name = str(body.get("name") or "").strip()[:100]
    if name:
        fp["name"] = name
    if isinstance(body.get("order"), int):
        p["floorplans"].remove(fp)
        p["floorplans"].insert(max(0, min(body["order"], len(p["floorplans"]))), fp)
    return _out(store.save(p))


@app.delete("/api/projects/{pid}/floorplans/{fid}")
async def delete_floorplan(pid: str, fid: str):
    return _out(store.delete_floorplan(pid, fid))


# ---- afgifte-elementen ------------------------------------------------------

def _default_valve(p: Dict[str, Any], etype: str) -> str:
    ids = [v["id"] for v in p["valve_types"]]
    want = "flowmeter_lpm" if etype == "vloerverwarming" else "danfoss_ra_n"
    return want if want in ids else (ids[0] if ids else "")


@app.post("/api/projects/{pid}/emitters")
async def create_emitter(pid: str, body: EmitterIn):
    p = store.get(pid)
    data = body.model_dump(exclude_none=True)
    if data.get("floorplan_id"):
        find(p["floorplans"], data["floorplan_id"])
    etype = data.get("type", "radiator")
    count = sum(1 for e in p["emitters"] if e.get("type") == etype) + 1
    label = {"radiator": "Radiator", "vloerverwarming": "Vloerverwarming",
             "convector": "Convector"}[etype]
    em = {"id": new_id(), "floorplan_id": None, "x": 0.5, "y": 0.5, "type": etype,
          "name": f"{label} {count}", "room": "", "power_w": None, "demand_w": None,
          "valve_type": _default_valve(p, etype), "preset": None, "notes": "",
          "measurements": [], "created": now_iso()}
    em.update(data)
    p["emitters"].append(em)
    out = _out(store.save(p))
    out["created_id"] = em["id"]
    return out


@app.put("/api/projects/{pid}/emitters/{eid}")
async def update_emitter(pid: str, eid: str, body: EmitterIn):
    p = store.get(pid)
    em = find(p["emitters"], eid)
    data = body.model_dump(exclude_unset=True)
    if data.get("floorplan_id"):
        find(p["floorplans"], data["floorplan_id"])
    em.update(data)
    return _out(store.save(p))


@app.delete("/api/projects/{pid}/emitters/{eid}")
async def delete_emitter(pid: str, eid: str):
    p = store.get(pid)
    find(p["emitters"], eid)
    p["emitters"] = [e for e in p["emitters"] if e["id"] != eid]
    return _out(store.save(p))


# ---- metingen ---------------------------------------------------------------

def _add_measurement(p: Dict[str, Any], em: Dict[str, Any], m: MeasurementIn) -> None:
    if m.t_in is None and supply_temp(settings_of(p), em.get("type") == "vloerverwarming") is None:
        raise HTTPException(422, f"{em.get('name') or 'Element'}: vul de aanvoertemperatuur in "
                                 "of stel de cv-aanvoertemperatuur in bij de projectinstellingen")
    em.setdefault("measurements", []).append({
        "id": new_id(), "ts": m.ts or now_iso(), "t_in": m.t_in, "t_out": m.t_out,
        "t_room": m.t_room, "preset": em.get("preset"),
    })


@app.post("/api/projects/{pid}/emitters/{eid}/measurements")
async def add_measurement(pid: str, eid: str, body: MeasurementIn):
    p = store.get(pid)
    _add_measurement(p, find(p["emitters"], eid), body)
    return _out(store.save(p))


@app.post("/api/projects/{pid}/measurements")
async def add_measurements(pid: str, body: Batch):
    p = store.get(pid)
    ts = now_iso()
    for it in body.items:
        it.ts = it.ts or ts
        _add_measurement(p, find(p["emitters"], it.emitter_id), it)
    return _out(store.save(p))


@app.delete("/api/projects/{pid}/emitters/{eid}/measurements/{mid}")
async def delete_measurement(pid: str, eid: str, mid: str):
    p = store.get(pid)
    em = find(p["emitters"], eid)
    find(em.get("measurements") or [], mid)
    em["measurements"] = [m for m in em["measurements"] if m["id"] != mid]
    return _out(store.save(p))
