"""TypeScript 엔진과 Python 엔진의 결과 비교 (shared/fixtures/engine-cases.json)

픽스처는 frontend/src/engine/fixtures.test.ts 가 만든다. 엔진을 바꾸면
`cd frontend && UPDATE_FIXTURES=1 npm test` 로 다시 만든 뒤 이 테스트를 실행한다.
"""

import json

import pytest

from autoino.engine.auto_assign import auto_assign
from autoino.engine.circuit import Circuit
from autoino.engine.exporters import build_bom, build_pin_table
from autoino.engine.power import analyze_power
from autoino.engine.resistor import compute_series_resistors
from autoino.engine.validate import validate_circuit
from autoino.project import parse_project


def norm(value):
    """숫자 표현(5 vs 5.0) 차이를 없애고 비교하기 위해 JSON 왕복"""
    return json.loads(json.dumps(value))


def _cases():
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[2]
    with open(root / "shared" / "fixtures" / "engine-cases.json", encoding="utf-8") as f:
        return json.load(f)["cases"]


CASES = _cases()


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_auto_assign(case):
    circuit = Circuit.from_project(parse_project(case["before"]))
    result = auto_assign(circuit, parse_project(case["before"]).next_conn_seq, route=case.get("route", "direct"))
    assert [c.dump() for c in result.connections] == norm(case["autoAssign"]["connections"])
    assert [c.id for c in result.added] == case["autoAssign"]["added"]
    assert [c.id for c in result.removed] == case["autoAssign"]["removed"]
    assert result.failed == case["autoAssign"]["failed"]
    assert result.next_conn_seq == case["autoAssign"]["nextConnSeq"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_validate(case):
    circuit = Circuit.from_project(parse_project(case["after"]))
    issues = [{k: v for k, v in i.items() if k != "id"} for i in validate_circuit(circuit)]
    assert issues == case["issues"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_resistors_pin_table_bom(case):
    circuit = Circuit.from_project(parse_project(case["after"]))
    assert norm(compute_series_resistors(circuit)) == norm(case["resistors"])
    assert build_pin_table(circuit) == case["pinTable"]
    assert build_bom(circuit) == case["bom"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_power_report(case):
    circuit = Circuit.from_project(parse_project(case["after"]))
    assert norm(analyze_power(circuit)) == norm(case["power"])


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_project_roundtrip(case):
    from autoino.project import to_project_file

    project = parse_project(case["after"])
    file = to_project_file(project)
    file["savedAt"] = case["after"]["savedAt"]
    assert norm(file) == norm(case["after"])
