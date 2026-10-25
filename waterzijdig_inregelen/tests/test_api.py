import importlib
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
    main = importlib.import_module("app.main")  # vers importeren: leest de omgeving opnieuw
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


def test_security_headers_and_no_docs(client):
    r = client.get("/")
    assert "script-src 'self'" in r.headers["content-security-policy"]
    assert r.headers["x-content-type-options"] == "nosniff"
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404


def test_only_allowed_clients(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ALLOWED_CLIENTS", "172.30.32.2")
    sys.modules.pop("app.main", None)
    from fastapi.testclient import TestClient
    main = importlib.import_module("app.main")  # vers importeren: leest de omgeving opnieuw
    assert TestClient(main.app).get("/api/projects").status_code == 403
    ingress = TestClient(main.app, client=("172.30.32.2", 50000))
    assert ingress.get("/api/projects").status_code == 200
    # een vervalste X-Forwarded-For helpt niet
    assert TestClient(main.app).get("/api/projects",
                                    headers={"X-Forwarded-For": "172.30.32.2"}).status_code == 403
    sys.modules.pop("app.main", None)


def test_rejects_oversized_body(client):
    pid = client.post("/api/projects", json={"name": "x"}).json()["project"]["id"]
    r = client.post(f"/api/projects/{pid}/floorplans", content=b"x",
                    headers={"Content-Length": str(200 * 1024 * 1024),
                             "Content-Type": "multipart/form-data; boundary=x"})
    assert r.status_code == 413


def test_csv_formula_injection(client):
    pid = client.post("/api/projects", json={"name": "Huis ő"}).json()["project"]["id"]
    eid = client.post(f"/api/projects/{pid}/emitters", json={"name": "=HYPERLINK(1)"}).json()["created_id"]
    client.put(f"/api/projects/{pid}/emitters/{eid}", json={"room": "@SUM(A1)"})
    r = client.get(f"/api/projects/{pid}/export.csv")
    assert "'=HYPERLINK(1)" in r.text and "'@SUM(A1)" in r.text
    assert "filename*=UTF-8''Huis%20%C5%91.csv" in r.headers["content-disposition"]


def test_input_validation(client):
    pid = client.post("/api/projects", json={"name": "x"}).json()["project"]["id"]
    bad_valves = [
        [{"id": "a b", "name": "x", "steps": [[1, 1, ""]]}],               # id met spatie
        [{"id": "v", "name": "x", "steps": [["<b>", 1, ""]]}],            # stand geen getal
        [{"id": "v", "name": "x", "steps": [[1, 1, "x" * 50]]}],          # label te lang
    ]
    for vt in bad_valves:
        assert client.put(f"/api/projects/{pid}", json={"valve_types": vt}).status_code == 422
    ok = [{"id": "eigen_1", "name": "Eigen", "resolution": 1, "steps": [[1, 0.1, ""], [2, 0.3, "N"]]}]
    assert client.put(f"/api/projects/{pid}", json={"valve_types": ok}).status_code == 200

    eid = client.post(f"/api/projects/{pid}/emitters", json={}).json()["created_id"]
    r = client.post(f"/api/projects/{pid}/emitters/{eid}/measurements",
                    json={"t_in": 50, "t_out": 40, "ts": "<script>"})
    assert r.status_code == 422
