"""자동 핀 배정 (autoAssign.ts)"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..models import BoardEndpoint, Connection, DriverChannel, Module, ModuleEndpoint, ModulePin, PlacedModule
from .circuit import (
    parse_endpoint_key,
    Circuit,
    as_module_board_link,
    board_ep,
    endpoint_key,
    host_board_of,
    idle_pins,
    is_board_to_board,
    is_pin_connected,
    module_ep,
    resolve_board_pin,
    resolve_module_pin,
)
from .electrical import (
    board_to_board_error,
    ground_pins_of,
    has_restriction,
    is_gpio,
    is_usb_serial_pin,
    link_error,
    source_voltage,
    supply_pin_for_pin,
    uses_servo,
)
from .power import BREADBOARD_CURRENT_LIMIT_MA, wire_peak_ma

SHARED_BUS = ["i2c-sda", "i2c-scl", "spi-mosi", "spi-miso", "spi-sck"]
SPECIAL_CAPS = ["pwm", "interrupt", "analog", "dac", "i2c-sda", "i2c-scl", "spi-mosi", "spi-miso", "spi-sck", "spi-ss", "uart-rx", "uart-tx"]


@dataclass
class AutoAssignResult:
    connections: list[Connection]
    next_conn_seq: int
    added: list[Connection] = field(default_factory=list)
    removed: list[Connection] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)


def shared_bus_capability(pin: ModulePin) -> str | None:
    return next((c for c in pin.requires if c in SHARED_BUS), None)


def _board_link_bus(c: Circuit, conn: Connection, pin) -> str | None:
    link = next((l for l in c.links if l.id == conn.link_id), None) if conn.link_id else None
    if not link or link.protocol != "I2C":
        return None
    return next((cap for cap in pin.capabilities if cap in ("i2c-sda", "i2c-scl")), None)


def _score_pin(board, board_pin, pin: ModulePin, index: int, servo: bool) -> int:
    score = index
    wanted = set(pin.requires) | set(pin.prefers or [])
    for cap in pin.prefers or []:
        blocked = cap == "pwm" and servo and board_pin.id in board.servo_pwm_conflict_pins
        if cap in board_pin.capabilities and not blocked:
            score -= 500
    for cap in board_pin.capabilities:
        if cap in SPECIAL_CAPS and cap not in wanted:
            score += 40
        if cap in ("i2c-sda", "i2c-scl") and cap not in wanted:
            score += 200
    if board_pin.group == "analog" and "analog" not in wanted:
        score += 80
    if is_usb_serial_pin(board, board_pin):
        score += 2000
    if has_restriction(board_pin, "strapping"):
        score += 1000
    if has_restriction(board_pin, "jtag"):
        score += 40
    if has_restriction(board_pin, "onboard-led"):
        score += 60
    if has_restriction(board_pin, "no-internal-pull") and pin.pull == "up":
        score += 1500
    return score


def _signal_priority(pin: ModulePin) -> int:
    if any(c != "digital" for c in pin.requires):
        return 0
    if pin.prefers:
        return 1
    return 2


@dataclass
class _SourceRef:
    item: PlacedModule
    module: Module
    pin: ModulePin
    voltage: float


def _sources_of(c: Circuit) -> list[_SourceRef]:
    sources: list[_SourceRef] = []
    for item in c.placed:
        module = c.module_def(item.module_id)
        for pin in module.pins:
            if pin.role != "source":
                continue
            voltage = source_voltage(module, item, pin)
            if voltage is not None:
                sources.append(_SourceRef(item, module, pin, voltage))
    return sources


def _pick_source(sources: list[_SourceRef], item: PlacedModule, pin: ModulePin) -> _SourceRef | None:
    """외부 전원 핀에 쓸 전원: 허용 전압 안에서 요구 전압에 가장 가까운 것"""

    def first(*values):
        return next((v for v in values if v is not None), 0)

    lo = first(pin.min_voltage, pin.supply_voltage)
    hi = first(pin.max_voltage, pin.supply_voltage)
    wanted = first(pin.supply_voltage, hi)
    fits = [s for s in sources if s.item.instance_id != item.instance_id and lo <= s.voltage <= hi]
    return min(fits, key=lambda s: abs(s.voltage - wanted)) if fits else None


def _ground_of_source(source: _SourceRef):
    """전원 출력 핀과 짝이 되는 − 단자: 출력 핀 뒤의 첫 GND, 없으면 첫 GND"""
    pins = source.module.pins
    after = pins[pins.index(source.pin) :]
    ground = next((p for p in after if p.role == "ground"), None) or next((p for p in pins if p.role == "ground"), None)
    return module_ep(source.item.instance_id, ground.id) if ground else None


def _free_channel(c: Circuit, connections: list[Connection], motor_item: PlacedModule, kind: str, pin_count: int) -> tuple[PlacedModule, DriverChannel] | None:
    """모터를 받을 수 있는 빈 드라이버 채널"""
    for item in c.placed:
        module = c.module_def(item.module_id)
        if not module.driver or item.host_board_id != motor_item.host_board_id:
            continue
        for channel in module.driver.channels:
            if kind not in channel.accepts or len(channel.outputs) != pin_count:
                continue
            if all(not is_pin_connected(connections, item.instance_id, pid) for pid in channel.outputs):
                return item, channel
    return None


def auto_assign(c: Circuit, next_conn_seq: int, route: str = "direct", only: set[str] | None = None) -> AutoAssignResult:
    """route 는 새 전선의 경로, only 를 주면 그 모듈 핀(끝점 키)만 배정하고 기존 전선은 그대로 둔다."""

    from .shares import share_of, share_token

    def in_scope(instance_id: str, pin_id: str) -> bool:
        return only is None or endpoint_key(module_ep(instance_id, pin_id)) in only

    removed: list[Connection] = []
    kept: list[Connection] = []
    used: dict[str, str | None] = {}

    def claim(board_instance_id: str, pin_id: str, bus: str | None) -> bool:
        key = f"{board_instance_id}:{pin_id}"
        if key in used and not (bus and used[key] == bus):
            return False
        used[key] = bus
        return True

    for conn in c.connections:
        ends = [conn.from_, conn.to]
        if any(not isinstance(e, BoardEndpoint) and not resolve_module_pin(c, e) for e in ends):
            removed.append(conn)
            continue
        if is_board_to_board(conn):
            a, b = (resolve_board_pin(c, e.board_instance_id, e.pin_id) for e in ends)
            same = a and b and a.instance.instance_id == b.instance.instance_id
            if not a or not b or same or board_to_board_error(a.board, a.pin, b.board, b.pin):
                removed.append(conn)
                continue
            ok = all(not (r.pin and is_gpio(r.pin)) or claim(r.instance.instance_id, r.pin.id, _board_link_bus(c, conn, r.pin)) for r in (a, b))
            (kept if ok else removed).append(conn)
            continue
        link = as_module_board_link(conn)
        if not link:
            kept.append(conn)
            continue
        r = resolve_module_pin(c, module_ep(link.instance_id, link.module_pin_id))
        target = resolve_board_pin(c, link.board_instance_id, link.pin_id)
        if not target or link_error(target.board, r.module, r.pin, target.pin, r.placed):
            removed.append(conn)
            continue
        token = share_token(c, endpoint_key(module_ep(link.instance_id, link.module_pin_id))) or shared_bus_capability(r.pin)
        if target.pin and is_gpio(target.pin) and not claim(link.board_instance_id, target.pin.id, token):
            removed.append(conn)
            continue
        kept.append(conn)

    if only is not None:
        kept = list(c.connections)
        removed = []

    result = list(kept)
    added: list[Connection] = []
    failed: list[str] = []
    seq = next_conn_seq

    def connect_endpoints(from_, to) -> None:
        nonlocal seq
        conn = Connection.model_validate({"id": f"w{seq}", "from": from_.dump(), "to": to.dump(), "auto": True})
        seq += 1
        result.append(conn)
        if route == "breadboard":
            trial = Circuit(c.boards, c.placed, result, c.links, c.catalog, c.shares)
            if wire_peak_ma(trial, from_, to) < BREADBOARD_CURRENT_LIMIT_MA:
                conn.via = "breadboard"
        added.append(conn)

    def connect(instance_id: str, pin_id: str, board_instance_id: str, board_pin_id: str) -> None:
        connect_endpoints(module_ep(instance_id, pin_id), board_ep(board_instance_id, board_pin_id))

    # 모터 → 드라이버 채널
    for item in c.placed:
        module = c.module_def(item.module_id)
        if not module.motor:
            continue
        loads = [p for p in module.pins if p.role == "load"]
        if not [p for p in loads if not is_pin_connected(result, item.instance_id, p.id) and in_scope(item.instance_id, p.id)]:
            continue
        free = _free_channel(c, result, item, module.motor.kind, len(loads))
        if not free:
            failed.append(f"{item.label} (맞는 모터 드라이버 없음)")
            continue
        driver_item, channel = free
        for i, p in enumerate(loads):
            if not is_pin_connected(result, item.instance_id, p.id):
                connect_endpoints(module_ep(item.instance_id, p.id), module_ep(driver_item.instance_id, channel.outputs[i]))

    pending: list[tuple[PlacedModule, Module, ModulePin, int]] = []
    for item_index, item in enumerate(c.placed):
        module = c.module_def(item.module_id)
        idle = idle_pins(result, item.instance_id, module)
        for pin_index, pin in enumerate(module.pins):
            if pin.role in ("passive", "source", "load", "drive") or pin.id in idle:
                continue
            if is_pin_connected(result, item.instance_id, pin.id) or not in_scope(item.instance_id, pin.id):
                continue
            pending.append((item, module, pin, item_index * 100 + pin_index))

    # 전원 계획: 어떤 전원 핀을 어떤 외부 전원에 잇는지 먼저 정해야 GND 를 같은 전원으로 보낼 수 있다
    sources = _sources_of(c)
    plan: dict[str, _SourceRef] = {}
    for item, _, pin, _ in pending:
        if pin.role != "power" or not pin.external:
            continue
        source = _pick_source(sources, item, pin)
        if source:
            plan[endpoint_key(module_ep(item.instance_id, pin.id))] = source

    def source_of_item(item: PlacedModule, module: Module) -> _SourceRef | None:
        """이 부품의 전원 핀이 쓰는 외부 전원 (계획 또는 기존 전선)"""
        for pin in [p for p in module.pins if p.role == "power"]:
            e = module_ep(item.instance_id, pin.id)
            key = endpoint_key(e)
            if key in plan:
                return plan[key]
            for conn in result:
                far = conn.to if endpoint_key(conn.from_) == key else conn.from_ if endpoint_key(conn.to) == key else None
                if far is None:
                    continue
                found = next((s for s in sources if endpoint_key(far) == endpoint_key(module_ep(s.item.instance_id, s.pin.id))), None)
                if found:
                    return found
        return None

    grounded_on_source: set[str] = set()
    servo = uses_servo(c.placed, c.module_def)

    def priority(pin: ModulePin) -> int:
        return _signal_priority(pin) if pin.role == "signal" else 3

    pending.sort(key=lambda x: (priority(x[2]), x[3]))

    for item, module, pin, _ in pending:
        host = host_board_of(c, item)
        board = c.board_def(host.instance_id) if host else None
        if not host or not board:
            failed.append(f"{item.label} · {pin.name}")
            continue
        if pin.role == "power":
            source = plan.get(endpoint_key(module_ep(item.instance_id, pin.id)))
            if source:
                connect_endpoints(module_ep(item.instance_id, pin.id), module_ep(source.item.instance_id, source.pin.id))
                continue
            if pin.external == "required":
                failed.append(f"{item.label} · {pin.name} (외부 전원 필요)")
                continue
            target = supply_pin_for_pin(board, pin)
            if target:
                connect(item.instance_id, pin.id, host.instance_id, target)
            else:
                failed.append(f"{item.label} · {pin.name}")
            continue
        if pin.role == "ground":
            # 외부 전원을 쓰는 부품의 전류는 보드를 거치지 않고 전원 − 로 돌아가야 한다
            source = None if item.instance_id in grounded_on_source else source_of_item(item, module)
            source_ground = _ground_of_source(source) if source else None
            if source_ground:
                grounded_on_source.add(item.instance_id)
                connect_endpoints(module_ep(item.instance_id, pin.id), source_ground)
                continue
            grounds = ground_pins_of(board)
            if grounds:
                connect(item.instance_id, pin.id, host.instance_id, grounds[0])
            else:
                failed.append(f"{item.label} · {pin.name}")
            continue
        # 핀 공유 그룹: 다른 멤버가 이미 보드 핀에 연결되어 있으면 같은 핀에 잇는다
        share_key = endpoint_key(module_ep(item.instance_id, pin.id))
        token = share_token(c, share_key)
        share = share_of(c, share_key) if token else None
        mate = None
        if share:
            for k in share.members:
                if k == share_key:
                    continue
                e = parse_endpoint_key(k)
                if not isinstance(e, ModuleEndpoint):
                    continue
                link = next((l for l in (as_module_board_link(x) for x in result) if l and l.instance_id == e.instance_id and l.module_pin_id == e.pin_id), None)
                if link and link.board_instance_id == host.instance_id:
                    mate = link
                    break
        if mate:
            used[f"{host.instance_id}:{mate.pin_id}"] = token
            connect(item.instance_id, pin.id, host.instance_id, mate.pin_id)
            continue
        bus = token or shared_bus_capability(pin)
        candidates = []
        for index, bp in enumerate([p for p in board.pins if is_gpio(p)]):
            if link_error(board, module, pin, bp) is not None:
                continue
            key = f"{host.instance_id}:{bp.id}"
            if key in used and not (bus is not None and used[key] == bus):
                continue
            candidates.append((_score_pin(board, bp, pin, index, servo), index, bp))
        candidates.sort(key=lambda x: x[0])
        if not candidates:
            failed.append(f"{item.label} · {pin.name}")
            continue
        best = candidates[0][2]
        used[f"{host.instance_id}:{best.id}"] = bus
        connect(item.instance_id, pin.id, host.instance_id, best.id)

    return AutoAssignResult(result, seq, added, removed, failed)
