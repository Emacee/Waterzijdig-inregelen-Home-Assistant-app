import os
import sys

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

PNG = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00"
       b"\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00"
       b"\x00\x00\x00IEND\xaeB`\x82")


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("OPTIONS_FILE", str(tmp_path / "missing.json"))
    sys.modules.pop("app.main", None)
    from fastapi.testclient import TestClient
    from app import main
    return TestClient(main.app)


def test_full_flow(client):
    r = client.post("/api/projects", json={"name": "Huis", "heat_source": "warmtepomp"})
    assert r.status_code == 200
    p = r.json()["project"]
    assert p["settings"]["target_dt"] == 5.0
    pid = p["id"]

    r = client.post(f"/api/projects/{pid}/floorplans", files={"file": ("bg.png", PNG, "image/png")},
                    data={"name": "Begane grond", "width": "1", "height": "1"})
    assert r.status_code == 200
    fid = r.json()["project"]["floorplans"][0]["id"]
    assert client.get(f"/api/projects/{pid}/floorplans/{fid}/image").content == PNG

    r = client.post(f"/api/projects/{pid}/emitters", json={"floorplan_id": fid, "x": 0.3, "y": 0.4})
    eid = r.json()["created_id"]
    client.put(f"/api/projects/{pid}/emitters/{eid}", json={"preset": 4, "power_w": 1200})
    r = client.post(f"/api/projects/{pid}/measurements",
                    json={"items": [{"emitter_id": eid, "t_in": 40, "t_out": 37}]})
    a = r.json()["analysis"]["emitters"][0]
    assert a["dt"] == 3.0 and a["status"] == "dicht"  # ΔT < doel: te veel debiet
    em = r.json()["project"]["emitters"][0]
    assert em["measurements"][0]["preset"] == 4  # stand bij de meting vastgelegd

    csv = client.get(f"/api/projects/{pid}/export.csv")
    assert csv.status_code == 200 and "Radiator 1" in csv.text

    r = client.put(f"/api/projects/{pid}", json={"settings": {"target_dt": 7}})
    assert r.json()["project"]["settings"]["target_dt"] == 7

    assert client.delete(f"/api/projects/{pid}/floorplans/{fid}").json()["project"]["emitters"] == []
    assert client.delete(f"/api/projects/{pid}").status_code == 200
    assert client.get(f"/api/projects/{pid}").status_code == 404


def test_rejects_non_images(client):
    pid = client.post("/api/projects", json={"name": "x"}).json()["project"]["id"]
    for payload in (b"<svg onload=alert(1)>", b"%PDF-1.4", b"hello"):
        r = client.post(f"/api/projects/{pid}/floorplans", files={"file": ("a.svg", payload)})
        assert r.status_code == 415


def test_bad_ids(client):
    assert client.get("/api/projects/..%2f..%2fetc").status_code == 404
    assert client.get("/api/projects/ZZZ").status_code == 404


def test_cv_supply_temp(client):
    pid = client.post("/api/projects", json={"name": "Huis"}).json()["project"]["id"]
    eid = client.post(f"/api/projects/{pid}/emitters", json={}).json()["created_id"]
    r = client.post(f"/api/projects/{pid}/emitters/{eid}/measurements", json={"t_out": 50})
    assert r.status_code == 422  # geen aanvoer en geen cv-aanvoertemperatuur

    r = client.put(f"/api/projects/{pid}", json={"settings": {"supply_temp": 70}})
    assert r.json()["project"]["settings"]["supply_temp"] == 70
    r = client.post(f"/api/projects/{pid}/measurements",
                    json={"items": [{"emitter_id": eid, "t_out": 55}]})
    a = r.json()["analysis"]["emitters"][0]
    assert a["t_in"] == 70 and a["dt"] == 15

    r = client.put(f"/api/projects/{pid}", json={"settings": {"supply_temp": None}})
    assert r.json()["project"]["settings"]["supply_temp"] is None
    assert r.json()["analysis"]["emitters"][0]["status"] == "ongeldig"


def test_pipes_and_components(client):
    pid = client.post("/api/projects", json={"name": "Huis"}).json()["project"]["id"]
    r = client.post(f"/api/projects/{pid}/floorplans", files={"file": ("bg.png", PNG, "image/png")},
                    data={"name": "BG", "width": "1", "height": "1"})
    fid = r.json()["project"]["floorplans"][0]["id"]
    r = client.post(f"/api/projects/{pid}/floorplans/{fid}/pipes",
                    json={"points": [[0.1, 0.5], [0.9, 0.5]]})
    lid = r.json()["created_id"]
    assert r.json()["project"]["floorplans"][0]["pipes"][0]["id"] == lid
    client.post(f"/api/projects/{pid}/emitters", json={"floorplan_id": fid, "x": 0.5, "y": 0.52})
    r = client.post(f"/api/projects/{pid}/emitters",
                    json={"floorplan_id": fid, "x": 0.2, "y": 0.52})
    floor = r.json()["schema"]["floors"][0]
    assert floor["id"] == fid and len(floor["children"]) == 2

    r = client.post(f"/api/projects/{pid}/components", json={"type": "pomp", "attach": f"fp:{fid}"})
    cid = r.json()["created_id"]
    comp = r.json()["project"]["components"][0]
    assert comp["name"] == "Secundaire pomp 1" and comp["attach"] == f"fp:{fid}"
    assert client.post(f"/api/projects/{pid}/components",
                       json={"type": "pomp", "attach": "fp:abc123"}).status_code == 404
    assert client.post(f"/api/projects/{pid}/components",
                       json={"type": "pomp", "attach": "../x"}).status_code == 422
    r = client.post(f"/api/projects/{pid}/components", json={"type": "boilervat"})
    assert r.json()["project"]["components"][1]["attach"] == "source"

    client.delete(f"/api/projects/{pid}/floorplans/{fid}/pipes/{lid}")
    r = client.delete(f"/api/projects/{pid}/floorplans/{fid}")
    assert r.json()["project"]["components"][0]["attach"] == "main"
    assert client.delete(f"/api/projects/{pid}/components/{cid}").json()["project"]["components"][0]["type"] == "boilervat"
