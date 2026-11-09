"""핀 공유 그룹 (frontend/src/engine/shares.ts 와 같은 규칙)

사람이 부품 핀을 다른 부품 핀에 끌어 이으면, 두 핀이 같은 보드 핀을 함께 쓰는 그룹이 된다.
- 출력끼리(LED·부저·릴레이 입력): 같이 켜지고 꺼진다
- 버튼끼리, 디지털 핀: 어느 버튼을 눌러도 LOW 가 된다 (서로 구분할 수 없다)
- 버튼끼리, AVR(Uno·Nano·Mega)의 아날로그 핀, 4개까지: 저항 사다리 (INPUT_PULLUP + analogRead)
"""

from __future__ import annotations

from ..jsnum import js_round
from ..models import Board, BoardPin, Module, ModuleEndpoint, ModulePin
from .circuit import Circuit, as_module_board_link, parse_endpoint_key, resolve_board_pin, resolve_module_pin
from .resistor import format_ohms

LADDER_OHMS = [0, 4700, 22000, 100000]
LADDER_PULLUP_MIN = 20000
LADDER_PULLUP_MAX = 50000


def share_role(module: Module, pin: ModulePin) -> str | None:
    if pin.role != "signal":
        return None
    template = module.code.template if module.code else None
    if pin.direction == "out" and ((module.series_resistor and module.series_resistor.pin_id == pin.id) or template == "digital-write"):
        return "output"
    if pin.direction == "in" and pin.pull == "up" and not template and not any(p.role == "power" for p in module.pins):
        return "button"
    return None


def role_of_key(c: Circuit, key: str) -> str | None:
    e = parse_endpoint_key(key)
    if not isinstance(e, ModuleEndpoint):
        return None
    r = resolve_module_pin(c, e)
    return share_role(r.module, r.pin) if r else None


def supports_ladder(board: Board, pin: BoardPin | None) -> bool:
    return board.core == "arduino-avr" and pin is not None and "analog" in pin.capabilities and "digital" in pin.capabilities


def share_kind(c: Circuit, members: list[str], board: Board | None = None, pin: BoardPin | None = None) -> str | None:
    if len(members) < 2:
        return None
    roles = [role_of_key(c, k) for k in members]
    if all(r == "output" for r in roles):
        return "output"
    if all(r == "button" for r in roles):
        return "ladder" if board is not None and supports_ladder(board, pin) and len(members) <= len(LADDER_OHMS) else "input"
    return None


def share_of(c: Circuit, key: str):
    return next((s for s in c.shares if key in s.members), None)


def share_token(c: Circuit, key: str) -> str | None:
    share = share_of(c, key)
    if not share:
        return None
    roles = [role_of_key(c, k) for k in share.members]
    return f"share:{share.id}" if all(r is not None and r == roles[0] for r in roles) else None


def _link_of(c: Circuit, key: str, connections=None):
    e = parse_endpoint_key(key)
    if not isinstance(e, ModuleEndpoint):
        return None
    for conn in c.connections if connections is None else connections:
        link = as_module_board_link(conn)
        if link and link.instance_id == e.instance_id and link.module_pin_id == e.pin_id:
            return link
    return None


def share_board_pin(c: Circuit, share) -> tuple[str, str] | None:
    """그룹 멤버들이 연결된 보드 핀 (첫 멤버부터)"""
    for key in share.members:
        link = _link_of(c, key)
        if link:
            return link.board_instance_id, link.pin_id
    return None


def compute_ladder_resistors(c: Circuit) -> list[dict]:
    """저항 사다리로 묶인 버튼마다의 직렬 저항 (같은 보드 핀에 연결된 멤버만, 그룹 순서대로)"""
    result: list[dict] = []
    for share in c.shares:
        target = share_board_pin(c, share)
        if not target:
            continue
        on = []
        for key in share.members:
            link = _link_of(c, key)
            if link and (link.board_instance_id, link.pin_id) == target:
                on.append(key)
        rp = resolve_board_pin(c, target[0], target[1])
        if not rp or share_kind(c, on, rp.board, rp.pin) != "ladder":
            continue
        for index, key in enumerate(on):
            e = parse_endpoint_key(key)
            result.append({"instanceId": e.instance_id, "pinId": e.pin_id, "boardInstanceId": target[0], "boardPinId": target[1], "ohms": LADDER_OHMS[index], "index": index})
    return result


def ladder_thresholds(n: int) -> list[int]:
    """사다리 analogRead 경계 (0–1023): 버튼 i 를 누르면 값이 thresholds[i] 보다 작다"""
    bands = [(r / (LADDER_PULLUP_MAX + r), r / (LADDER_PULLUP_MIN + r)) for r in LADDER_OHMS[:n]]
    out = []
    for i, band in enumerate(bands):
        nxt = bands[i + 1][0] if i + 1 < n else 1
        out.append(js_round((band[1] + nxt) / 2 * 1023))
    return out


def ladder_label(c: Circuit, ladder: list[dict]) -> str:
    parts = []
    for r in ladder:
        item = c.placed_module(r["instanceId"])
        parts.append(f"{item.label if item else r['instanceId']}: {format_ohms(r['ohms']) if r['ohms'] else '저항 없이'}")
    return ", ".join(parts)
