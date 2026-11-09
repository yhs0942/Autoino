"""API 와 CLI 가 함께 쓰는 작업 단위 (프로젝트 파일 → 결과 dict)"""

from __future__ import annotations

from typing import Any

from .codegen import generate_sketches
from .engine.auto_assign import auto_assign
from .engine.circuit import Circuit
from .engine.exporters import build_bom, build_pin_table
from .engine.power import analyze_power
from .engine.resistor import compute_series_resistors
from .engine.validate import count_issues, validate_circuit
from .project import parse_project, to_project_file
from .simulate import simulate


def analyze(raw: Any) -> dict:
    project = parse_project(raw)
    c = Circuit.from_project(project)
    issues = validate_circuit(c)
    return {
        "name": project.name,
        "issues": issues,
        "counts": count_issues(issues),
        "resistors": compute_series_resistors(c),
        "pinTable": build_pin_table(c),
        "bom": build_bom(c),
        "power": analyze_power(c),
    }


def run_auto_assign(raw: Any, route: str = "direct") -> dict:
    project = parse_project(raw)
    result = auto_assign(Circuit.from_project(project), project.next_conn_seq, route=route)
    updated = project.model_copy(update={"connections": result.connections, "next_conn_seq": result.next_conn_seq})
    return {
        "project": to_project_file(updated),
        "added": [x.id for x in result.added],
        "removed": [x.id for x in result.removed],
        "failed": result.failed,
    }


def codegen(raw: Any) -> dict:
    project = parse_project(raw)
    return {"sketches": [s.dump() for s in generate_sketches(Circuit.from_project(project), project.name)]}


def run_simulation(raw: Any, options: dict | None = None) -> dict:
    project = parse_project(raw)
    return simulate(Circuit.from_project(project), options)
