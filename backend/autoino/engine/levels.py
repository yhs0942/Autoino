"""넷 단위 전압 레벨 분석 (levels.ts)"""

from __future__ import annotations

from dataclasses import dataclass

from ..jsnum import js_round, js_str, to_fixed
from ..models import BoardEndpoint
from .circuit import Circuit, as_module_board_link, board_label, endpoint_key, module_ep, parse_endpoint_key, resolve_board_pin
from .electrical import gpio_max_input_voltage, has_restriction, is_gpio, param_number, pin_display_name, source_voltage, supply_pin_of
from .netlist import Netlist, build_netlist

RECEIVING_ROLES = {"RX"}


@dataclass
class NetDriver:
    key: str
    voltage: float
    source: str  # supply | board-gpio | module-supply | module-derived
    label: str
    instance_id: str | None = None
    board_instance_id: str | None = None


@dataclass
class LevelFinding:
    severity: str
    board_instance_id: str
    pin_id: str
    key: str
    driver: NetDriver
    limit: float
    message: str
    hint: str | None = None


def _link_input_keys(c: Circuit) -> set[str]:
    keys: set[str] = set()
    for link in c.links:
        for end in (link.a, link.b):
            controller = end is link.a
            for role, pin_id in end.pins.items():
                is_input = role in RECEIVING_ROLES or (
                    link.protocol == "SPI" and (role == "MISO" if controller else role in ("MOSI", "SCK", "SS"))
                )
                if is_input:
                    keys.add(f"board:{end.board_instance_id}:{pin_id}")
    return keys


def compute_net_drivers(c: Circuit, netlist: Netlist) -> dict[str, list[NetDriver]]:
    drivers: dict[str, list[NetDriver]] = {}

    def push(d: NetDriver) -> None:
        net = netlist.net_of(d.key)
        drivers[net] = [x for x in drivers.get(net, []) if x.key != d.key] + [d]

    inputs = _link_input_keys(c)
    module_dirs: dict[str, list[str]] = {}
    for conn in c.connections:
        link = as_module_board_link(conn)
        if not link:
            continue
        item = c.placed_module(link.instance_id)
        module = c.module_def(item.module_id) if item else None
        pin = module.pin(link.module_pin_id) if module else None
        key = f"board:{link.board_instance_id}:{link.pin_id}"
        direction = (pin.direction if pin else None) or ("inout" if pin and pin.role == "signal" else "none")
        module_dirs.setdefault(key, []).append(direction)

    for keys in netlist.members.values():
        for key in keys:
            e = parse_endpoint_key(key)
            if not isinstance(e, BoardEndpoint):
                continue
            r = resolve_board_pin(c, e.board_instance_id, e.pin_id)
            if not r or not r.pin:
                continue
            supply = supply_pin_of(r.board, r.pin.id)
            name = f"{board_label(c, e.board_instance_id)} {pin_display_name(r.pin)}"
            if supply:
                push(NetDriver(key, supply.voltage, "supply", name, board_instance_id=e.board_instance_id))
            elif is_gpio(r.pin) and not has_restriction(r.pin, "input-only") and key not in inputs:
                dirs = module_dirs.get(key)
                if dirs and all(d == "in" for d in dirs):
                    continue
                push(NetDriver(key, r.board.logic_voltage, "board-gpio", name, board_instance_id=e.board_instance_id))

    # 외부 전원·레귤레이터 출력도 넷의 전원이다
    for item in c.placed:
        module = c.module_def(item.module_id)
        for pin in module.pins if module else []:
            if pin.role != "source":
                continue
            voltage = source_voltage(module, item, pin)
            if voltage is not None:
                push(NetDriver(endpoint_key(module_ep(item.instance_id, pin.id)), voltage, "supply", f"{item.label} · {pin.name}", instance_id=item.instance_id))

    def supply_voltage_of_net(key: str) -> float | None:
        ds = [d for d in drivers.get(netlist.net_of(key), []) if d.source == "supply"]
        return max(d.voltage for d in ds) if ds else None

    derived: list[tuple[str, str, float, str, str]] = []
    for item in c.placed:
        module = c.module_def(item.module_id)
        if not module:
            continue
        for pin in module.pins:
            hl = pin.high_level
            if hl is None:
                continue
            key = endpoint_key(module_ep(item.instance_id, pin.id))
            label = f"{item.label} · {pin.name}"
            if hl == "supply" or hasattr(hl, "power_pin"):
                if hl == "supply":
                    power = next((p for p in module.pins if p.role == "power"), None)
                    power_pin_id = power.id if power else None
                else:
                    power_pin_id = hl.power_pin
                if not power_pin_id:
                    continue
                v = supply_voltage_of_net(endpoint_key(module_ep(item.instance_id, power_pin_id)))
                if v is not None:
                    push(NetDriver(key, v, "module-supply", label, instance_id=item.instance_id))
            else:
                ratio = param_number(module, item, hl.ratio_param)
                if ratio is None:
                    continue
                derived.append((key, endpoint_key(module_ep(item.instance_id, hl.from_pin)), ratio, label, item.instance_id))

    for _ in range(4):
        for key, from_key, ratio, label, instance_id in derived:
            src = [x for x in drivers.get(netlist.net_of(from_key), []) if x.key != key]
            if not src:
                continue
            v = max(x.voltage for x in src) * ratio
            # TS: Math.round(v * 1000) / 1000
            push(NetDriver(key, js_round(v * 1000) / 1000, "module-derived", label, instance_id=instance_id))
    return drivers


def fmt_v(v: float) -> str:
    # TS: Number.isInteger(v * 10) ? String(v) : v.toFixed(2)
    t = v * 10
    return js_str(v) if t == int(t) else to_fixed(v, 2)


def analyze_levels(c: Circuit, netlist: Netlist | None = None) -> list[LevelFinding]:
    netlist = netlist or build_netlist(c)
    drivers = compute_net_drivers(c, netlist)
    findings: list[LevelFinding] = []
    for keys in netlist.members.values():
        for key in keys:
            e = parse_endpoint_key(key)
            if not isinstance(e, BoardEndpoint):
                continue
            r = resolve_board_pin(c, e.board_instance_id, e.pin_id)
            if not r or not r.pin or not is_gpio(r.pin):
                continue
            others = [d for d in drivers.get(netlist.net_of(key), []) if d.key != key]
            if not others:
                continue
            top = others[0]
            for d in others[1:]:
                if d.voltage > top.voltage:
                    top = d
            mx = gpio_max_input_voltage(r.board)
            target = f"{board_label(c, e.board_instance_id)} {pin_display_name(r.pin)}"
            if top.voltage > mx + 0.01:
                if top.source == "module-supply":
                    why = f"부품을 {fmt_v(top.voltage)} V 로 구동하면 이 신호가 {fmt_v(top.voltage)} V 가 되어"
                elif top.source == "board-gpio":
                    why = f"HIGH 출력({fmt_v(top.voltage)} V)이"
                else:
                    why = f"이 신호가 약 {fmt_v(top.voltage)} V 가 되어"
                findings.append(
                    LevelFinding(
                        "error", e.board_instance_id, e.pin_id, key, top, mx,
                        f"{top.label} → {target}: {why} {r.board.name} GPIO 최대 입력 전압({js_str(mx)} V)을 넘습니다.",
                        "[레벨 변환 자동 추가]로 전압 분배기(입력 신호)나 레벨 시프터(양방향·출력 신호)를 넣거나, 3.3 V 로 동작하는 제품을 사용하세요.",
                    )
                )
                continue
            if top.source == "supply":
                continue
            vih = r.board.gpio_input_high_min_voltage
            if top.voltage < vih:
                findings.append(
                    LevelFinding(
                        "warning", e.board_instance_id, e.pin_id, key, top, vih,
                        f"{top.label} → {target}: HIGH 신호({fmt_v(top.voltage)} V)가 {r.board.name} 의 HIGH 인식 최소 전압({js_str(vih)} V)보다 낮아 읽히지 않을 수 있습니다.",
                        "레벨 시프터로 신호 전압을 올리세요.",
                    )
                )
            elif top.voltage < vih + 0.5:
                findings.append(
                    LevelFinding(
                        "info", e.board_instance_id, e.pin_id, key, top, vih,
                        f"{top.label} → {target}: HIGH 신호({fmt_v(top.voltage)} V)가 {r.board.name} 의 HIGH 인식 최소 전압({js_str(vih)} V)에 가까워 여유가 작습니다.",
                    )
                )
    return findings
