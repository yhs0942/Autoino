"""REST API (FastAPI TestClient)"""

import json

import pytest
from fastapi.testclient import TestClient

from autoino.api import create_app
from autoino.storage import ProjectStore
from helpers import board, module, project


@pytest.fixture()
def client(tmp_path):
    return TestClient(create_app(ProjectStore(tmp_path / "projects"), serve_frontend=False))


def led_project():
    return project(
        [board("board-1", "arduino-uno-r3")],
        [module("led-5mm#1", "led-5mm", color="red", current="10")],
        [("led-5mm#1:anode", "board-1:D5"), ("led-5mm#1:cathode", "board-1:GND")],
    )


def test_health_and_catalog(client):
    health = client.get("/api/health").json()
    assert health["status"] == "ok" and "simulate" in health["features"]
    catalog = client.get("/api/catalog").json()
    assert {b["id"] for b in catalog["boards"]} >= {"arduino-uno-r3", "esp32-devkit-v1"}
    assert health["catalog"] == {"boards": len(catalog["boards"]), "modules": len(catalog["modules"])}
    assert client.get("/api/boards/esp32-devkit-v1").json()["logicVoltage"] == 3.3
    assert client.get("/api/modules/sg90").json()["libraryByCore"]["arduino-esp32"] == "ESP32Servo"
    r = client.get("/api/boards/nope")
    assert r.status_code == 404 and "보드" in r.json()["detail"]


def test_project_crud(client, tmp_path):
    assert client.get("/api/projects").json() == []
    r = client.post("/api/projects", json=led_project())
    assert r.status_code == 201
    pid = r.json()["id"]
    assert r.json()["project"]["version"] == 2
    listed = client.get("/api/projects").json()
    assert listed[0]["id"] == pid and listed[0]["moduleCount"] == 1 and listed[0]["boards"] == ["arduino-uno-r3"]
    changed = led_project() | {"name": "바뀐 이름"}
    assert client.put(f"/api/projects/{pid}", json=changed).json()["project"]["name"] == "바뀐 이름"
    assert client.get(f"/api/projects/{pid}").json()["project"]["name"] == "바뀐 이름"
    on_disk = json.loads((tmp_path / "projects" / f"{pid}.autoino.json").read_text(encoding="utf-8"))
    assert on_disk["name"] == "바뀐 이름"
    assert client.delete(f"/api/projects/{pid}").status_code == 204
    assert client.get(f"/api/projects/{pid}").status_code == 404


def test_project_ids_cannot_escape_directory(client):
    for bad in ["..%2F..%2Fetc%2Fpasswd", "ABCDEF123456", "short", "a" * 13]:
        assert client.get(f"/api/projects/{bad}").status_code == 404
        assert client.put(f"/api/projects/{bad}", json=led_project()).status_code == 404


def test_invalid_project_is_rejected_with_korean_message(client):
    r = client.post("/api/projects", json={"format": "nope"})
    assert r.status_code == 422 and r.json()["detail"] == "Autoino 프로젝트 파일이 아닙니다."
    bad = led_project()
    bad["modules"][0]["moduleId"] = "unknown"
    r = client.post("/api/analyze", json={"project": bad})
    assert r.status_code == 422 and "알 수 없는 부품" in r.json()["detail"]
    assert client.post("/api/analyze", json={}).status_code == 422


def test_analyze_auto_assign_codegen_simulate(client):
    p = led_project()
    analysis = client.post("/api/analyze", json={"project": p}).json()
    assert analysis["counts"]["error"] == 0
    assert analysis["pinTable"][0]["boardPin"] == "D5"

    unwired = project([board("board-1", "arduino-uno-r3")], [module("led-5mm#1", "led-5mm")], [])
    assigned = client.post("/api/auto-assign", json={"project": unwired}).json()
    assert len(assigned["added"]) == 2 and not assigned["failed"]
    assert len(assigned["project"]["connections"]) == 2

    sketches = client.post("/api/codegen", json={"project": p}).json()["sketches"]
    assert len(sketches) == 1 and "const uint8_t LED1_PIN = 5;" in sketches[0]["code"]

    sim = client.post("/api/simulate", json={"project": p, "options": {"gpio": {"board-1:D5": "high"}}}).json()
    assert sim["leds"][0]["state"] == "on"
    bad = client.post("/api/simulate", json={"project": p, "options": {"gpio": {"board-1:D5": "maybe"}}})
    assert bad.status_code == 422 and "GPIO" in bad.json()["detail"]


def test_cors_allows_vite_dev_server(client):
    r = client.options("/api/health", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"})
    assert r.headers.get("access-control-allow-origin") == "http://localhost:5173"


def test_frontend_is_served_when_built(tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>Autoino</title>", encoding="utf-8")
    monkeypatch.setenv("AUTOINO_FRONTEND_DIST", str(dist))
    c = TestClient(create_app(ProjectStore(tmp_path / "p")))
    assert "Autoino" in c.get("/").text
    assert c.get("/api/health").json()["status"] == "ok"


def test_frontend_html_is_not_cached(tmp_path, monkeypatch):
    """새 버전을 올렸을 때 브라우저가 예전 화면을 쓰지 않도록 index.html 은 매번 확인하게 한다"""
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>Autoino</title>", encoding="utf-8")
    (dist / "assets" / "index-abc.js").write_text("1", encoding="utf-8")
    monkeypatch.setenv("AUTOINO_FRONTEND_DIST", str(dist))
    c = TestClient(create_app(ProjectStore(tmp_path / "p")))
    for path in ("/", "/index.html", "/?v=1"):
        assert "no-cache" in c.get(path).headers.get("cache-control", ""), path
    assert "immutable" in c.get("/assets/index-abc.js").headers.get("cache-control", "")
