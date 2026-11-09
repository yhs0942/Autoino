"""카탈로그 검증 · 저장소 · CLI"""

import copy
import json

import pytest

from autoino.__main__ import main
from autoino.catalog import CatalogError, parse_catalog, raw_catalog
from autoino.project import ProjectFileError, parse_project
from autoino.storage import ProjectNotFound, ProjectStore
from helpers import board, module, project


def test_real_catalog_round_trips_through_models():
    raw = raw_catalog()
    catalog = parse_catalog(raw["boards"], raw["modules"])
    assert [b.dump() for b in catalog.boards] == raw["boards"]
    assert json.loads(json.dumps([m.dump() for m in catalog.modules])) == raw["modules"]


def test_catalog_rejects_bad_data():
    raw = raw_catalog()
    boards = copy.deepcopy(raw["boards"])
    esp = next(b for b in boards if b["id"] == "esp32-devkit-v1")
    gpio34 = next(p for p in esp["pins"] if p["id"] == "GPIO34")
    gpio34["capabilities"].append("pwm")
    with pytest.raises(CatalogError, match="입력 전용"):
        parse_catalog(boards, raw["modules"])
    modules = copy.deepcopy(raw["modules"])
    modules[0]["parameters"][0]["defaultValue"] = "purple"
    with pytest.raises(CatalogError, match="기본값"):
        parse_catalog(raw["boards"], modules)
    boards = copy.deepcopy(raw["boards"])
    boards[0]["pwmPins"].append("D99")
    with pytest.raises(CatalogError, match="D99"):
        parse_catalog(boards, raw["modules"])


def test_v1_project_is_migrated():
    v1 = {
        "format": "autoino-project",
        "version": 1,
        "name": "옛 파일",
        "boardId": "arduino-uno-r3",
        "modules": [{"instanceId": "led-5mm#1", "moduleId": "led-5mm", "label": "LED 1", "x": 1, "y": 2, "params": {}}],
        "connections": [{"id": "w1", "from": {"kind": "module", "instanceId": "led-5mm#1", "pinId": "anode"}, "to": {"kind": "board", "pinId": "D5"}, "auto": True}],
    }
    p = parse_project(v1)
    assert p.boards[0].instance_id == "board-1"
    assert p.connections[0].to.board_instance_id == "board-1"
    assert p.placed[0].params == {"color": "red", "current": "10"}
    with pytest.raises(ProjectFileError, match="버전"):
        parse_project({**v1, "version": 3})


def test_store_handles_missing_and_corrupt_files(tmp_path):
    store = ProjectStore(tmp_path)
    assert store.list() == []
    pid, _ = store.create(project([board("board-1", "arduino-nano")], [], []))
    (tmp_path / "zzzzzzzzzzzz.autoino.json").write_text("{broken", encoding="utf-8")
    assert [s.id for s in store.list()] == [pid]
    with pytest.raises(ProjectNotFound):
        store.get("000000000000")
    with pytest.raises(ProjectNotFound):
        store.get("../secret")
    assert not list(tmp_path.glob(".tmp-*"))


@pytest.fixture()
def project_file(tmp_path):
    path = tmp_path / "led.autoino.json"
    p = project(
        [board("board-1", "arduino-uno-r3")],
        [module("led-5mm#1", "led-5mm"), module("push-button#2", "push-button")],
        [("led-5mm#1:anode", "board-1:D5"), ("led-5mm#1:cathode", "board-1:GND"), ("push-button#2:pin2a", "board-1:D4"), ("push-button#2:pin1a", "board-1:GND")],
    )
    path.write_text(json.dumps(p, ensure_ascii=False), encoding="utf-8")
    return path


def test_cli_check_data(capsys):
    assert main(["check-data"]) == 0
    assert "esp32-devkit-v1" in capsys.readouterr().out


def test_cli_analyze_codegen_simulate(project_file, tmp_path, capsys):
    assert main(["analyze", str(project_file)]) == 0
    out = capsys.readouterr().out
    assert "오류 0" in out and "→ D5" in out

    assert main(["codegen", str(project_file), "-o", str(tmp_path / "out")]) == 0
    capsys.readouterr()
    sketch = tmp_path / "out" / "autoino_board_1" / "autoino_board_1.ino"
    assert "INPUT_PULLUP" in sketch.read_text(encoding="utf-8")

    assert main(["simulate", str(project_file), "--press", "push-button#2", "--json"]) == 0
    result = json.loads(capsys.readouterr().out)
    d4 = next(g for g in result["gpio"] if g["pinId"] == "D4")
    assert d4["logic"] == "LOW"

    assert main(["simulate", str(project_file), "--gpio", "board-1:D5=bogus"]) == 2
    assert "GPIO 상태" in capsys.readouterr().err


def test_cli_reports_bad_file(tmp_path, capsys):
    bad = tmp_path / "bad.json"
    bad.write_text("not json", encoding="utf-8")
    assert main(["analyze", str(bad)]) == 2
    assert "JSON 형식이 아닙니다" in capsys.readouterr().err
