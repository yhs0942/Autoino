"""브레드보드 구멍·핀 공유·실물 배치가 서버 저장과 자동 배정을 거쳐도 남는지"""

from __future__ import annotations

import json
from pathlib import Path

from autoino.project import parse_project, to_project_file
from autoino.service import run_auto_assign
from autoino.storage import ProjectStore

FIXTURES = Path(__file__).resolve().parents[2] / "shared" / "fixtures" / "engine-cases.json"
BLINK = "void setup() {}\nvoid loop() {}\n"


def _case(name: str) -> dict:
    return next(c for c in json.loads(FIXTURES.read_text(encoding="utf-8"))["cases"] if c["name"] == name)


def _with_extras() -> dict:
    """핀 공유 그룹이 있는 TS 픽스처에 브레드보드 구멍과 실물 배치를 더한 파일"""
    raw = dict(_case("share-leds")["after"])
    raw["breadboardHoles"] = {"module:led-5mm#1:anode": "12c", "board:board-1:D5": "top+4", "module:ghost#9:x": "5a", "module:led-5mm#2:anode": "99z"}
    raw["layout"] = {"led-5mm#1": {"x": 120, "y": 80}, "board-1": {"x": 10, "y": 20}, "breadboard": {"x": 5, "y": 600}, "ghost#2": {"x": 1, "y": 1}, "led-5mm#2": {"x": "a"}}
    raw["sketches"] = {"board-1": BLINK, "board-9": "void setup() {}", "board-2": 5}
    return raw


def test_parse_keeps_valid_entries_and_drops_bad_ones() -> None:
    data = to_project_file(parse_project(_with_extras())).copy()
    assert data["breadboardHoles"] == {"module:led-5mm#1:anode": "12c", "board:board-1:D5": "top+4"}
    assert data["layout"] == {"led-5mm#1": {"x": 120, "y": 80}, "board-1": {"x": 10, "y": 20}, "breadboard": {"x": 5, "y": 600}}
    assert data["shares"] == _case("share-leds")["after"]["shares"]
    assert data["sketches"] == {"board-1": BLINK}


def test_empty_fields_are_not_written() -> None:
    data = to_project_file(parse_project(_case("uno-all")["after"]))
    for key in ("breadboardHoles", "shares", "layout", "sketches"):
        assert key not in data


def test_server_save_and_load_round_trip(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    project_id, _ = store.create(_with_extras())
    loaded = store.get(project_id)
    assert loaded["breadboardHoles"]["module:led-5mm#1:anode"] == "12c"
    assert loaded["layout"]["breadboard"] == {"x": 5, "y": 600}
    assert len(loaded["shares"][0]["members"]) == 3


def test_auto_assign_keeps_project_extras() -> None:
    result = run_auto_assign(_with_extras())
    project = result["project"]
    assert project["shares"] == _case("share-leds")["after"]["shares"]
    assert project["layout"]["led-5mm#1"] == {"x": 120, "y": 80}
    assert project["breadboardHoles"]["board:board-1:D5"] == "top+4"


def test_external_power_keeps_supply_kind() -> None:
    """외부 전원의 [전원 종류](전원 예시 ID)가 저장·열기를 거쳐도 남고, 모르는 값은 직접 설정이 된다"""
    raw = json.loads(json.dumps(_case("pca9685-servos")["after"]))
    supply = next(m for m in raw["modules"] if m["moduleId"] == "external-power")
    assert supply["params"]["supply"] == "smps-5v10a"
    data = to_project_file(parse_project(raw))
    assert next(m for m in data["modules"] if m["moduleId"] == "external-power")["params"]["supply"] == "smps-5v10a"

    supply["params"]["supply"] = "없는-전원"
    data = to_project_file(parse_project(raw))
    assert next(m for m in data["modules"] if m["moduleId"] == "external-power")["params"]["supply"] == "custom"

    del supply["params"]["supply"]  # 예전 파일
    data = to_project_file(parse_project(raw))
    assert next(m for m in data["modules"] if m["moduleId"] == "external-power")["params"]["supply"] == "custom"
