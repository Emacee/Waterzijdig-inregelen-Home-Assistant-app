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
