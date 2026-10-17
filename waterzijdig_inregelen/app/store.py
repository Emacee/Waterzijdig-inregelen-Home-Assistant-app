"""Opslag van projecten als JSON in /data (en dus in elke Home Assistant-back-up).

    /data/projects/<project_id>/project.json
    /data/projects/<project_id>/floorplans/<floorplan_id>.<ext>
"""
from __future__ import annotations

import copy
import json
import os
import shutil
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .balance import DEFAULT_SETTINGS, DEFAULT_VALVE_TYPES


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def _valid_id(pid: str) -> bool:
    return bool(pid) and len(pid) <= 32 and all(c in "0123456789abcdef" for c in pid)


class NotFound(Exception):
    pass


class Store:
    def __init__(self, data_dir: str):
        self.root = os.path.join(data_dir, "projects")
        os.makedirs(self.root, exist_ok=True)
        self._lock = threading.RLock()

    # ---- paden -------------------------------------------------------------
    def _dir(self, pid: str) -> str:
        if not _valid_id(pid):
            raise NotFound(pid)
        return os.path.join(self.root, pid)

    def _file(self, pid: str) -> str:
        return os.path.join(self._dir(pid), "project.json")

    def floorplan_path(self, pid: str, fp: Dict[str, Any]) -> str:
        return os.path.join(self._dir(pid), "floorplans", fp["file"])

    # ---- projecten -----------------------------------------------------------
    def list(self) -> List[Dict[str, Any]]:
        out = []
        with self._lock:
            for pid in os.listdir(self.root):
                try:
                    p = self.get(pid)
                except (NotFound, ValueError, OSError):
                    continue
                out.append({
                    "id": p["id"], "name": p["name"], "created": p["created"],
                    "updated": p["updated"], "address": p.get("address", ""),
                    "floorplans": len(p["floorplans"]), "emitters": len(p["emitters"]),
                    "cover": p["floorplans"][0]["id"] if p["floorplans"] else None,
                })
        out.sort(key=lambda p: p["updated"], reverse=True)
        return out

    def get(self, pid: str) -> Dict[str, Any]:
        path = self._file(pid)
        with self._lock:
            if not os.path.exists(path):
                raise NotFound(pid)
            with open(path, "r", encoding="utf-8") as fh:
                p = json.load(fh)
        p.setdefault("settings", {})
        for k, v in DEFAULT_SETTINGS.items():
            p["settings"].setdefault(k, copy.deepcopy(v))
        p.setdefault("valve_types", copy.deepcopy(DEFAULT_VALVE_TYPES))
        p.setdefault("floorplans", [])
        p.setdefault("emitters", [])
        return p

    def save(self, p: Dict[str, Any]) -> Dict[str, Any]:
        p["updated"] = now_iso()
        d = self._dir(p["id"])
        with self._lock:
            os.makedirs(os.path.join(d, "floorplans"), exist_ok=True)
            tmp = self._file(p["id"]) + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(p, fh, ensure_ascii=False, indent=1)
            os.replace(tmp, self._file(p["id"]))
        return p

    def create(self, name: str, address: str = "", settings: Optional[Dict] = None) -> Dict:
        p = {
            "id": new_id(), "name": name.strip() or "Nieuw project", "address": address,
            "notes": "", "created": now_iso(), "updated": now_iso(),
            "settings": {**copy.deepcopy(DEFAULT_SETTINGS), **(settings or {})},
            "valve_types": copy.deepcopy(DEFAULT_VALVE_TYPES),
            "floorplans": [], "emitters": [],
        }
        return self.save(p)

    def delete(self, pid: str) -> None:
        d = self._dir(pid)
        with self._lock:
            if not os.path.isdir(d):
                raise NotFound(pid)
            shutil.rmtree(d)

    # ---- plattegronden ---------------------------------------------------
    def add_floorplan(self, pid: str, name: str, ext: str, data: bytes,
                      width: int, height: int) -> Dict[str, Any]:
        with self._lock:
            p = self.get(pid)
            fid = new_id()
            fp = {"id": fid, "name": name or f"Plattegrond {len(p['floorplans']) + 1}",
                  "file": f"{fid}.{ext}", "width": width, "height": height}
            os.makedirs(os.path.join(self._dir(pid), "floorplans"), exist_ok=True)
            with open(self.floorplan_path(pid, fp), "wb") as fh:
                fh.write(data)
            p["floorplans"].append(fp)
            return self.save(p)

    def delete_floorplan(self, pid: str, fid: str) -> Dict[str, Any]:
        with self._lock:
            p = self.get(pid)
            fp = find(p["floorplans"], fid)
            try:
                os.remove(self.floorplan_path(pid, fp))
            except FileNotFoundError:
                pass
            p["floorplans"] = [f for f in p["floorplans"] if f["id"] != fid]
            p["emitters"] = [e for e in p["emitters"] if e.get("floorplan_id") != fid]
            return self.save(p)


def find(items: List[Dict[str, Any]], iid: str) -> Dict[str, Any]:
    for it in items:
        if it.get("id") == iid:
            return it
    raise NotFound(iid)
