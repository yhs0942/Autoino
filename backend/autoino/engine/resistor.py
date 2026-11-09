"""직렬 저항 자동 선정 (resistor.ts)"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

from ..jsnum import js_num_from_fixed, js_round
from .circuit import Circuit, board_pin_for, resolve_board_pin
from .electrical import board_pin_voltage, param_number

E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2]


def next_e12(ohms: float) -> float:
    if not (ohms > 0):
        return 10
    decade = 10 ** math.floor(math.log10(ohms))
    while True:
        for base in E12:
            value = js_round(base * decade * 1000) / 1000
            if value >= ohms - 1e-9:
                return value
        decade *= 10


def format_ohms(ohms: float) -> str:
    if ohms >= 1_000_000:
        return f"{js_num_from_fixed(ohms / 1_000_000, 2)} MΩ"
    if ohms >= 1000:
        return f"{js_num_from_fixed(ohms / 1000, 2)} kΩ"
    return f"{js_num_from_fixed(ohms, 1)} Ω"


@dataclass
class ResistorChoice:
    supplyVoltage: float
    forwardVoltage: float
    targetMa: float
    calculatedOhms: float
    standardOhms: float
    actualMa: float
    powerMw: float
    ratingLabel: str


def select_series_resistor(supply: float, vf: float, target_ma: float) -> ResistorChoice | None:
    drop = supply - vf
    if drop <= 0 or target_ma <= 0:
        return None
    calculated = drop / (target_ma / 1000)
    standard = next_e12(calculated)
    actual = (drop / standard) * 1000
    power = drop * actual
    rating = "1/4 W" if power * 2 <= 250 else "1/2 W" if power * 2 <= 500 else "1 W 이상"
    return ResistorChoice(supply, vf, target_ma, calculated, standard, actual, power, rating)


def compute_series_resistors(c: Circuit) -> list[dict]:
    """프런트엔드 SeriesResistorResult 와 같은 형식의 dict 목록"""
    results: list[dict] = []
    for item in c.placed:
        module = c.module_def(item.module_id)
        spec = module.series_resistor if module else None
        if not spec:
            continue
        base = {"instanceId": item.instance_id, "pinId": spec.pin_id}
        ref = board_pin_for(c.connections, item.instance_id, spec.pin_id)
        target = resolve_board_pin(c, ref[0], ref[1]) if ref else None
        if not ref or not target or not target.pin:
            results.append({"status": "unconnected", **base})
            continue
        at = {"boardInstanceId": ref[0], "boardPinId": ref[1]}
        supply = board_pin_voltage(target.board, target.pin)
        vf = param_number(module, item, spec.forward_voltage_param)
        ma = param_number(module, item, spec.current_param)
        if supply is None or supply == 0 or vf is None or ma is None:
            results.append({"status": "unknown-voltage", **base, **at})
            continue
        choice = select_series_resistor(supply, vf, ma)
        if choice:
            results.append({"status": "ok", **base, **at, "choice": asdict(choice)})
        else:
            results.append({"status": "insufficient-voltage", **base, **at, "supplyVoltage": supply, "forwardVoltage": vf})
    return results
