"""부품·보드 데이터베이스(data/*.json) 로드와 검증.

프런트엔드의 frontend/src/data/validate.ts 와 같은 규칙으로 구조를 검사한다.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from pydantic import ValidationError

from .models import Board, Module, PowerSupply
from .paths import data_dir


class CatalogError(ValueError):
    """data/*.json 의 구조 오류"""


@dataclass(frozen=True)
class Catalog:
    boards: tuple[Board, ...]
    modules: tuple[Module, ...]
    supplies: tuple[PowerSupply, ...] = ()

    def board(self, board_id: str) -> Board | None:
        return next((b for b in self.boards if b.id == board_id), None)

    def module(self, module_id: str) -> Module | None:
        return next((m for m in self.modules if m.id == module_id), None)


DEFAULT_SUPPLY = ("5V", "3.3V")
DEFAULT_GROUND = ("GND",)
OUTPUT_CAPS = {"pwm", "dac"}


def _unique(ids: list[str], where: str) -> None:
    seen: set[str] = set()
    for i in ids:
        if i in seen:
            raise CatalogError(f"데이터 오류 ({where}): ID 중복: {i}")
        seen.add(i)


def _check_board(b: Board, where: str) -> None:
    ids = [p.id for p in b.pins]
    _unique(ids, f"{where}.pins")
    pin_set = set(ids)

    def ref(pin_id: str, path: str) -> None:
        if pin_id not in pin_set:
            raise CatalogError(f"데이터 오류 ({path}): 존재하지 않는 핀 {pin_id}")

    for key in ("pwm_pins", "interrupt_pins", "servo_pwm_conflict_pins"):
        for i, pin_id in enumerate(getattr(b, key)):
            ref(pin_id, f"{where}.{key}[{i}]")
    for bi, bus in enumerate(b.buses):
        for pi, bp in enumerate(bus.pins):
            ref(bp.pin_id, f"{where}.buses[{bi}].pins[{pi}]")
    for i, pin in enumerate(b.pins):
        kinds = [r.kind for r in pin.restrictions or []]
        if "input-only" in kinds and any(c in OUTPUT_CAPS or c.endswith("-tx") for c in pin.capabilities):
            raise CatalogError(f"데이터 오류 ({where}.pins[{i}]): 입력 전용 핀에 출력 기능이 지정되어 있습니다")
    supplies = [s.pin_id for s in b.supply_pins] if b.supply_pins is not None else [p for p in DEFAULT_SUPPLY if p in pin_set]
    grounds = list(b.ground_pins) if b.ground_pins is not None else [p for p in DEFAULT_GROUND if p in pin_set]
    for i, p in enumerate(supplies):
        ref(p, f"{where}.supplyPins[{i}]")
    for i, p in enumerate(grounds):
        ref(p, f"{where}.groundPins[{i}]")
    if not supplies or not grounds:
        raise CatalogError(f"데이터 오류 ({where}.pins): 전원 공급 핀과 GND 핀이 하나 이상 필요합니다")
    for i, r in enumerate(b.reserved_pins or []):
        if r.id in pin_set:
            raise CatalogError(f"데이터 오류 ({where}.reservedPins[{i}]): 사용 가능한 핀 목록과 중복됩니다")
    if b.headers is not None:
        placed = [p for h in b.headers for p in h.pin_ids]
        for i, p in enumerate(placed):
            ref(p, f"{where}.headers[{i}]")
        _unique(placed, f"{where}.headers")
        missing = [p for p in ids if p not in placed]
        if missing:
            raise CatalogError(f"데이터 오류 ({where}.headers): 헤더에 없는 핀: {', '.join(missing)}")


def _check_module(m: Module, where: str) -> None:
    ids = [p.id for p in m.pins]
    if not ids:
        raise CatalogError(f"데이터 오류 ({where}.pins): 핀이 하나 이상 필요합니다")
    _unique(ids, f"{where}.pins")

    def ref(pin_id: str, path: str) -> None:
        if pin_id not in ids:
            raise CatalogError(f"데이터 오류 ({path}): 존재하지 않는 핀 {pin_id}")

    for key in ("internal_connections", "pass_through"):
        for i, (a, b) in enumerate(getattr(m, key) or []):
            ref(a, f"{where}.{key}[{i}][0]")
            ref(b, f"{where}.{key}[{i}][1]")
    for i, pin in enumerate(m.pins):
        hl = pin.high_level
        if hl is not None and hl != "supply":
            ref(getattr(hl, "power_pin", None) or getattr(hl, "from_pin"), f"{where}.pins[{i}].highLevel")
    param_ids = [p.id for p in m.parameters or []]
    for i, pin in enumerate(m.pins):
        if pin.min_voltage is not None and pin.max_voltage is not None and pin.min_voltage > pin.max_voltage:
            raise CatalogError(f"데이터 오류 ({where}.pins[{i}]): 전압 범위가 잘못되었습니다")
        if pin.role == "source" and pin.voltage_param is None and pin.supply_voltage is None:
            raise CatalogError(f"데이터 오류 ({where}.pins[{i}]): 전원 출력 핀에는 출력 전압이 필요합니다")
        for key in ("voltage_param", "current_param", "scale_param"):
            value = getattr(pin, key)
            if value is not None and value not in param_ids:
                raise CatalogError(f"데이터 오류 ({where}.pins[{i}].{key}): 존재하지 않는 파라미터 {value}")
    if m.driver:
        ref(m.driver.supply_pin, f"{where}.driver.supplyPin")
        for i, ch in enumerate(m.driver.channels):
            for j, pin_id in enumerate([*ch.outputs, *ch.inputs]):
                ref(pin_id, f"{where}.driver.channels[{i}][{j}]")
    if m.regulator:
        ref(m.regulator.input_pin, f"{where}.regulator.inputPin")
    if m.code:
        for i, pin_id in enumerate((m.code.pins or {}).values()):
            ref(pin_id, f"{where}.code.pins[{i}]")
        if m.code.standby_pin:
            ref(m.code.standby_pin, f"{where}.code.standbyPin")
    for i, param in enumerate(m.parameters or []):
        if param.default_value not in [o.value for o in param.options]:
            raise CatalogError(f"데이터 오류 ({where}.parameters[{i}].defaultValue): 옵션에 없는 기본값입니다")


def parse_catalog(boards_raw: object, modules_raw: object, supplies_raw: object = ()) -> Catalog:
    if not isinstance(boards_raw, list) or not isinstance(modules_raw, list):
        raise CatalogError("데이터 오류: boards.json 과 modules.json 은 배열이어야 합니다")
    try:
        boards = [Board.model_validate(b) for b in boards_raw]
        modules = [Module.model_validate(m) for m in modules_raw]
        supplies = [PowerSupply.model_validate(s) for s in supplies_raw]
    except ValidationError as e:
        raise CatalogError(f"데이터 오류: {e}") from e
    _unique([b.id for b in boards], "boards")
    _unique([m.id for m in modules], "modules")
    _unique([s.id for s in supplies], "supplies")
    for i, b in enumerate(boards):
        _check_board(b, f"boards[{i}]")
    for i, m in enumerate(modules):
        _check_module(m, f"modules[{i}]")
    return Catalog(tuple(boards), tuple(modules), tuple(supplies))


def load_catalog_from(directory: Path) -> Catalog:
    with open(directory / "boards.json", encoding="utf-8") as f:
        boards = json.load(f)
    with open(directory / "modules.json", encoding="utf-8") as f:
        modules = json.load(f)
    with open(directory / "power-supplies.json", encoding="utf-8") as f:
        supplies = json.load(f)
    return parse_catalog(boards, modules, supplies)


@lru_cache(maxsize=1)
def get_catalog() -> Catalog:
    """data/ 의 카탈로그 (처음 한 번만 읽는다)"""
    return load_catalog_from(data_dir())


def raw_catalog() -> dict:
    """API 응답용 원본 JSON (프런트엔드와 같은 형식)"""
    with open(data_dir() / "boards.json", encoding="utf-8") as f:
        boards = json.load(f)
    with open(data_dir() / "modules.json", encoding="utf-8") as f:
        modules = json.load(f)
    with open(data_dir() / "power-supplies.json", encoding="utf-8") as f:
        supplies = json.load(f)
    return {"boards": boards, "modules": modules, "supplies": supplies}
