"""전원 분석 (power.ts).

1) 현재 전원 상태: 보드 전원 핀·외부 전원·레귤레이터 출력마다 그 넷에 달린 부하의 전류를 더한다.
2) 필요한 외부 전원: 모터·드라이버·서보처럼 외부 전원이 필요한 부품을 전압 범위가 겹치는 것끼리 묶고,
   권장 전압·전류와 그에 맞는 전원 예시(data/power-supplies.json)를 고른다.
"""

from __future__ import annotations

import math

from ..jsnum import js_num_from_fixed, js_round
from ..models import BoardEndpoint, DriverChannel, Module, ModuleEndpoint, ModulePin, PlacedModule, PowerSupply
from .circuit import Circuit, board_label, endpoint_key, module_ep, parse_endpoint_key, resolve_board_pin, resolve_module_pin
from .electrical import param_number, source_limit_ma, source_voltage, supply_pins_of
from .netlist import Netlist, build_netlist

USB_5V_BUDGET_MA = 400
BREADBOARD_CURRENT_LIMIT_MA = 1000
BOARD_VIN_MA = 100
MIN_MARGIN = 1.25
EXAMPLE_LIMIT = 4


def _round1(v: float) -> float:
    return js_round(v * 10) / 10


def _ceil100(ma: float) -> int:
    return math.ceil(ma / 100 - 1e-9) * 100


def format_current(ma: float) -> str:
    """전류 표시: 1000 mA 이상은 A 단위"""
    return f"{js_num_from_fixed(ma / 1000, 2)} A" if ma >= 1000 else f"{js_round(ma)} mA"


def _members(netlist: Netlist, key: str) -> list[str]:
    return netlist.members.get(netlist.net_of(key), [])


def motors_on_channel(c: Circuit, netlist: Netlist, item: PlacedModule, channel: DriverChannel) -> list[tuple[PlacedModule, Module]]:
    found: dict[str, tuple[PlacedModule, Module]] = {}
    for output in channel.outputs:
        for k in _members(netlist, endpoint_key(module_ep(item.instance_id, output))):
            e = parse_endpoint_key(k)
            r = resolve_module_pin(c, e) if e else None
            if r and r.pin.role == "load" and r.module.motor and r.placed.instance_id != item.instance_id:
                found[r.placed.instance_id] = (r.placed, r.module)
    return list(found.values())


def _motors_of_driver(c: Circuit, netlist: Netlist, item: PlacedModule, module: Module) -> list[tuple[PlacedModule, Module]]:
    found: dict[str, tuple[PlacedModule, Module]] = {}
    for channel in module.driver.channels if module.driver else []:
        for placed, motor in motors_on_channel(c, netlist, item, channel):
            found[placed.instance_id] = (placed, motor)
    return list(found.values())


def _own_current(item: PlacedModule, module: Module, pin: ModulePin) -> tuple[float | None, float | None]:
    first = next((p for p in module.pins if p.role == "power"), None)
    typical = pin.typical_ma
    if typical is None and first is not None and first.id == pin.id:
        typical = module.typical_current_ma
    if typical is None:
        return None, None
    scale = 1.0
    if pin.scale_param:
        number = param_number(module, item, pin.scale_param)
        scale = 1.0 if number is None else number
    peak = pin.peak_ma if pin.peak_ma is not None else typical
    return typical * scale, peak * scale


def load_of_pin(c: Circuit, netlist: Netlist, item: PlacedModule, module: Module, pin: ModulePin, seen: set[str] | None = None) -> dict:
    """부품 전원 핀 하나의 부하 (드라이버의 모터, 레귤레이터의 출력 부하 포함)"""
    seen = seen if seen is not None else set()
    typical, peak = _own_current(item, module, pin)

    def add(t: float | None, p: float | None) -> None:
        nonlocal typical, peak
        if t is None or p is None:
            return
        typical = (typical or 0) + t
        peak = (peak or 0) + p

    if module.driver and module.driver.supply_pin == pin.id:
        for _, motor in _motors_of_driver(c, netlist, item, module):
            add(motor.motor.typical_ma, motor.motor.peak_ma)
    if module.regulator and module.regulator.input_pin == pin.id and item.instance_id not in seen:
        seen.add(item.instance_id)
        for out in [p for p in module.pins if p.role == "source"]:
            for load in _loads_on_net(c, netlist, endpoint_key(module_ep(item.instance_id, out.id)), seen):
                add(load["typicalMa"], load["peakMa"])
    return {
        "key": endpoint_key(module_ep(item.instance_id, pin.id)),
        "instanceId": item.instance_id,
        "label": item.label,
        "pinName": pin.name,
        "typicalMa": typical,
        "peakMa": peak,
        "minVoltage": pin.min_voltage,
        "maxVoltage": pin.max_voltage,
    }


def _has_module_source(c: Circuit, netlist: Netlist, key: str) -> bool:
    """넷에 외부 전원·레귤레이터 출력이 있는지"""
    for k in _members(netlist, key):
        e = parse_endpoint_key(k)
        if isinstance(e, ModuleEndpoint):
            r = resolve_module_pin(c, e)
            if r and r.pin.role == "source":
                return True
    return False


def _loads_on_net(c: Circuit, netlist: Netlist, key: str, seen: set[str] | None = None) -> list[dict]:
    seen = seen if seen is not None else set()
    loads: list[dict] = []
    for k in _members(netlist, key):
        e = parse_endpoint_key(k)
        if isinstance(e, ModuleEndpoint):
            r = resolve_module_pin(c, e)
            if r and r.pin.role == "power":
                loads.append(load_of_pin(c, netlist, r.placed, r.module, r.pin, seen))
        elif isinstance(e, BoardEndpoint):
            r = resolve_board_pin(c, e.board_instance_id, e.pin_id)
            # 외부 전원이 보드 전원 입력(VIN)에 물려 있으면 보드도 그 전원의 부하다
            if r and r.board.power_input and r.board.power_input.pin_id == e.pin_id and _has_module_source(c, netlist, k):
                loads.append(
                    {
                        "key": k,
                        "instanceId": None,
                        "label": f"{board_label(c, e.board_instance_id)} VIN",
                        "pinName": e.pin_id,
                        "typicalMa": BOARD_VIN_MA,
                        "peakMa": BOARD_VIN_MA,
                        "minVoltage": None,
                        "maxVoltage": None,
                    }
                )
    return loads


def _pin_peak_ma(c: Circuit, netlist: Netlist, e) -> float:
    r = resolve_module_pin(c, e)
    if not r:
        return 0
    item, module, pin = r.placed, r.module, r.pin
    key = endpoint_key(e)
    if pin.role == "load":
        return module.motor.peak_ma if module.motor else 0
    if pin.role == "drive":
        channel = next((ch for ch in module.driver.channels if pin.id in ch.outputs), None) if module.driver else None
        return sum(m.motor.peak_ma for _, m in motors_on_channel(c, netlist, item, channel)) if channel else 0
    if pin.role == "power":
        return load_of_pin(c, netlist, item, module, pin)["peakMa"] or 0
    if pin.role == "source":
        return sum(load["peakMa"] or 0 for load in _loads_on_net(c, netlist, key))
    if pin.role == "ground":
        return sum(_pin_peak_ma(c, netlist, module_ep(item.instance_id, p.id)) for p in module.pins if p.role in ("power", "source"))
    return 0


def wire_peak_ma(c: Circuit, from_, to, netlist: Netlist | None = None) -> float:
    """이 전선으로 흐를 수 있는 최대 전류(mA)"""
    netlist = netlist or build_netlist(c)
    return max(_pin_peak_ma(c, netlist, from_), _pin_peak_ma(c, netlist, to))


def net_voltage(c: Circuit, netlist: Netlist, key: str) -> float | None:
    """끝점이 속한 넷의 전원 전압. 전원이 없으면 None"""
    for k in _members(netlist, key):
        e = parse_endpoint_key(k)
        if isinstance(e, ModuleEndpoint):
            r = resolve_module_pin(c, e)
            if r and r.pin.role == "source":
                v = source_voltage(r.module, r.placed, r.pin)
                if v is not None:
                    return v
        elif isinstance(e, BoardEndpoint):
            board = c.board_def(e.board_instance_id)
            sp = next((s for s in supply_pins_of(board) if s.pin_id == e.pin_id), None) if board else None
            if sp:
                return sp.voltage
    return None


def _sum_loads(loads: list[dict]) -> dict:
    return {
        "typicalMa": sum(load["typicalMa"] or 0 for load in loads),
        "peakMa": sum(load["peakMa"] or 0 for load in loads),
        "unknown": [load["label"] for load in loads if load["typicalMa"] is None],
    }


def _status_of(loads: list[dict], limit_ma: float | None, typical: float, peak: float) -> str:
    if not loads:
        return "unused"
    if limit_ma is None:
        return "ok"
    return "overload" if typical > limit_ma else "peak" if peak > limit_ma else "ok"


def _collect_sources(c: Circuit, netlist: Netlist) -> list[dict]:
    sources: list[dict] = []
    seen: dict[str, dict] = {}

    def push(key: str, kind: str, label: str, voltage: float, limit_ma: float | None) -> None:
        net = netlist.net_of(key)
        same = seen.get(net)
        if same:
            same["parallel"].append(label)
            return
        loads = _loads_on_net(c, netlist, key)
        totals = _sum_loads(loads)
        source = {
            "key": key,
            "kind": kind,
            "label": label,
            "voltage": voltage,
            "limitMa": limit_ma,
            "loads": loads,
            **totals,
            "status": _status_of(loads, limit_ma, totals["typicalMa"], totals["peakMa"]),
            "parallel": [],
        }
        seen[net] = source
        sources.append(source)

    for b in c.boards:
        board = c.board_def(b.instance_id)
        if not board:
            continue
        for sp in supply_pins_of(board):
            key = f"board:{b.instance_id}:{sp.pin_id}"
            if netlist.net_of(key) not in netlist.members:
                continue
            # ESP32 VIN 처럼 입력으로도 쓰는 핀에 외부 전원이 물려 있으면 보드가 내보내는 전원이 아니다
            if board.power_input and board.power_input.pin_id == sp.pin_id and _has_module_source(c, netlist, key):
                continue
            prefix = f"{b.label} " if len(c.boards) > 1 else "보드 "
            push(key, "board", f"{prefix}{sp.pin_id}", sp.voltage, USB_5V_BUDGET_MA if sp.voltage >= 4.5 else None)
    for item in c.placed:
        module = c.module_def(item.module_id)
        if not module:
            continue
        pins = [p for p in module.pins if p.role == "source"]
        for pin in pins:
            voltage = source_voltage(module, item, pin)
            if voltage is None:
                continue
            label = f"{item.label} {pin.name}" if len(pins) > 1 else item.label
            kind = "regulator" if module.regulator else "external"
            push(endpoint_key(module_ep(item.instance_id, pin.id)), kind, label, voltage, source_limit_ma(module, item, pin))
    return sources


def _source_on_net(sources: list[dict], netlist: Netlist, key: str) -> dict | None:
    net = netlist.net_of(key)
    return next((s for s in sources if s["kind"] != "board" and netlist.net_of(s["key"]) == net), None)


def _pin_demand(c: Circuit, netlist: Netlist, sources: list[dict], item: PlacedModule, module: Module, pin: ModulePin) -> dict:
    load = load_of_pin(c, netlist, item, module, pin)
    typical = load["typicalMa"] or 0
    peak = load["peakMa"] or 0

    def first(*values):
        return next((v for v in values if v is not None), 0)

    served = _source_on_net(sources, netlist, load["key"])
    return {
        "pins": [load["key"]],
        "consumers": [{"instanceId": item.instance_id, "label": item.label, "typicalMa": typical, "peakMa": peak}],
        "minVoltage": first(pin.min_voltage, pin.supply_voltage),
        "maxVoltage": first(pin.max_voltage, pin.supply_voltage),
        "targetVoltage": first(pin.supply_voltage, pin.max_voltage),
        "typicalMa": typical,
        "peakMa": peak,
        "conflict": False,
        "servedBy": served["label"] if served else None,
    }


def _is_servo_module(module: Module) -> bool:
    return bool(module.code and module.code.template in ("servo", "servo-continuous"))


def _collect_demands(c: Circuit, netlist: Netlist, sources: list[dict]) -> list[dict]:
    demands: list[dict] = []
    driven: set[str] = set()
    covered: set[str] = set()  # 서보 드라이버 수요에 이미 넣은 서보 전원 핀
    for item in c.placed:
        module = c.module_def(item.module_id)
        driver = module.driver if module else None
        if not driver:
            continue
        pin = module.pin(driver.supply_pin)
        demand = _pin_demand(c, netlist, sources, item, module, pin)
        motors = _motors_of_driver(c, netlist, item, module)
        if motors:
            own = _own_current(item, module, pin)
            demand["consumers"] = [
                {"instanceId": item.instance_id, "label": item.label, "typicalMa": own[0] or 0, "peakMa": own[1] or 0},
                *[{"instanceId": p.instance_id, "label": p.label, "typicalMa": m.motor.typical_ma, "peakMa": m.motor.peak_ma} for p, m in motors],
            ]
            lo = max([demand["minVoltage"], *[m.motor.min_voltage + driver.drop_voltage for _, m in motors]])
            hi = min([demand["maxVoltage"], *[m.motor.max_voltage + driver.drop_voltage for _, m in motors]])
            demand["conflict"] = lo > hi
            if not demand["conflict"]:
                demand["minVoltage"] = _round1(lo)
                demand["maxVoltage"] = _round1(hi)
            target = max(m.motor.nominal_voltage + driver.drop_voltage for _, m in motors)
            demand["targetVoltage"] = _round1(min(demand["maxVoltage"], max(demand["minVoltage"], target)))
            driven.update(p.instance_id for p, _ in motors)
        # 서보 드라이버: V+ 에 함께 물린 서보 전원 핀의 전류와 전압 범위를 더한다
        if any("servo" in ch.accepts for ch in driver.channels):
            for k in _members(netlist, endpoint_key(module_ep(item.instance_id, pin.id))):
                e = parse_endpoint_key(k)
                r = resolve_module_pin(c, e) if isinstance(e, ModuleEndpoint) else None
                if not r or r.placed.instance_id == item.instance_id or r.pin.role != "power" or not _is_servo_module(r.module):
                    continue
                load = load_of_pin(c, netlist, r.placed, r.module, r.pin)
                demand["consumers"].append({"instanceId": r.placed.instance_id, "label": r.placed.label, "typicalMa": load["typicalMa"] or 0, "peakMa": load["peakMa"] or 0})
                demand["typicalMa"] += load["typicalMa"] or 0
                demand["peakMa"] += load["peakMa"] or 0
                if r.pin.min_voltage is not None:
                    demand["minVoltage"] = max(demand["minVoltage"], r.pin.min_voltage)
                if r.pin.max_voltage is not None:
                    demand["maxVoltage"] = min(demand["maxVoltage"], r.pin.max_voltage)
                covered.add(k)
            demand["conflict"] = demand["minVoltage"] > demand["maxVoltage"]
            if not demand["conflict"]:
                demand["targetVoltage"] = _round1(min(demand["maxVoltage"], max(demand["minVoltage"], demand["targetVoltage"])))
        demands.append(demand)
    for item in c.placed:
        module = c.module_def(item.module_id)
        if not module:
            continue
        if module.motor and item.instance_id not in driven:
            motor = module.motor
            demands.append(
                {
                    "pins": [],
                    "consumers": [{"instanceId": item.instance_id, "label": item.label, "typicalMa": motor.typical_ma, "peakMa": motor.peak_ma}],
                    "minVoltage": motor.min_voltage,
                    "maxVoltage": motor.max_voltage,
                    "targetVoltage": motor.nominal_voltage,
                    "typicalMa": motor.typical_ma,
                    "peakMa": motor.peak_ma,
                    "conflict": False,
                    "servedBy": None,
                }
            )
        if module.driver:
            continue
        for pin in module.pins:
            if pin.role != "power" or not pin.external:
                continue
            key = endpoint_key(module_ep(item.instance_id, pin.id))
            if key in covered:
                continue
            served = _source_on_net(sources, netlist, key)
            if served and served["kind"] == "regulator":
                continue
            demands.append(_pin_demand(c, netlist, sources, item, module, pin))
    return demands


def _examples_for(need: dict, supplies: tuple[PowerSupply, ...]) -> list[dict]:
    fits = [s for s in supplies if need["minVoltage"] <= s.voltage <= need["maxVoltage"] and s.max_current_ma >= need["minimumMa"]]

    def level(s: PowerSupply) -> str:
        return "recommended" if s.max_current_ma >= need["recommendedMa"] else "minimum"

    fits.sort(key=lambda s: (level(s) == "minimum", abs(s.voltage - need["targetVoltage"]), s.max_current_ma, s.id))
    examples = []
    for s in fits[:EXAMPLE_LIMIT]:
        example = {**s.dump(), "level": level(s)}
        if s.capacity_mah is not None and need["typicalMa"] > 0:
            example["runtimeHours"] = _round1(s.capacity_mah / need["typicalMa"])
        examples.append(example)
    return examples


def _merge_demands(demands: list[dict], supplies: tuple[PowerSupply, ...]) -> list[dict]:
    buckets: list[dict] = []
    for d in sorted(demands, key=lambda x: (x["maxVoltage"], x["minVoltage"])):
        bucket = next(
            (b for b in buckets if b["servedBy"] == d["servedBy"] and max(b["minVoltage"], d["minVoltage"]) <= min(b["maxVoltage"], d["maxVoltage"])),
            None,
        )
        if not bucket:
            buckets.append({**d, "pins": list(d["pins"]), "consumers": list(d["consumers"])})
            continue
        bucket["minVoltage"] = max(bucket["minVoltage"], d["minVoltage"])
        bucket["maxVoltage"] = min(bucket["maxVoltage"], d["maxVoltage"])
        bucket["targetVoltage"] = min(bucket["maxVoltage"], max(bucket["minVoltage"], bucket["targetVoltage"], d["targetVoltage"]))
        bucket["typicalMa"] += d["typicalMa"]
        bucket["peakMa"] += d["peakMa"]
        bucket["conflict"] = bucket["conflict"] or d["conflict"]
        bucket["pins"].extend(d["pins"])
        bucket["consumers"].extend(d["consumers"])
    needs = []
    for i, b in enumerate(buckets):
        minimum = _ceil100(b["typicalMa"] * MIN_MARGIN)
        need = {**b, "id": f"need-{i + 1}", "minimumMa": minimum, "recommendedMa": max(minimum, _ceil100(b["peakMa"]))}
        need["examples"] = _examples_for(need, supplies)
        needs.append(need)
    return needs


def analyze_power(c: Circuit, netlist: Netlist | None = None) -> dict:
    netlist = netlist or build_netlist(c)
    sources = _collect_sources(c, netlist)
    return {"sources": sources, "needs": _merge_demands(_collect_demands(c, netlist, sources), c.catalog.supplies)}
