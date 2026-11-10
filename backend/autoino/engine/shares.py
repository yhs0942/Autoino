"""핀 공유 그룹 (frontend/src/engine/shares.ts 와 같은 규칙)

사람이 부품 핀을 다른 부품 핀(같은 부품의 다른 핀도 됨)에 끌어 이으면, 두 핀이 같은 보드 핀을 함께 쓰는 그룹이 된다.
- 출력끼리(LED·부저·릴레이 입력): 같이 켜지고 꺼진다
- 같은 종류의 출력 신호끼리(서보 신호, TRIG, STEP·DIR, 모터 드라이버 EN·IN 등): 같은 신호를 받는다
- 아날로그 센서끼리는 한 핀에 바로 묶지 않고 아날로그 멀티플렉서 채널로 잇는다 (그룹으로 저장하지 않음)
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
    if pin.role != "signal" or module.mux:
        return None
    spec = module.code
    template = spec.template if spec else None
    if pin.direction == "out" and ((module.series_resistor and module.series_resistor.pin_id == pin.id) or template == "digital-write"):
        return "output"
    if pin.direction == "in" and pin.pull == "up" and not template and not any(p.role == "power" for p in module.pins):
        return "button"
    if pin.direction == "in" and "analog" in pin.requires:
        return "analog"
    if pin.direction != "out":
        return None

    def is_(role: str) -> bool:
        return bool(spec and spec.pins and spec.pins.get(role) == pin.id)

    if template in ("servo", "servo-continuous", "esc") and is_("signal"):
        return f"signal:{template}"
    if template == "neopixel" and is_("data"):
        return "signal:neopixel"
    if template == "tm1637" and is_("clk"):
        return "signal:tm1637-clk"
    if template == "step-dir" and is_("step"):
        return "signal:step"
    if template == "step-dir" and is_("dir"):
        return "signal:dir"
    if template == "rc522" and is_("rst"):
        return "signal:rc522-rst"
    if template == "serial-module" and is_("tx"):
        return "signal:uart-tx"
    if pin.id == "trig":
        return "signal:trig"
    if template == "h-bridge":
        if spec.standby_pin == pin.id:
            return "signal:hbridge-stby"
        for ch in module.driver.channels if module.driver else []:
            if pin.id not in ch.inputs:
                continue
            if spec.scheme != "en-in1-in2":
                return "signal:hbridge-pwm"
            return "signal:hbridge-en" if ch.inputs.index(pin.id) == 0 else "signal:hbridge-in"
    if template == "stepper-coils" and module.driver and module.driver.channels and pin.id in module.driver.channels[0].inputs:
        return f"signal:coil-{module.driver.channels[0].inputs.index(pin.id) + 1}"
    return None


ROLE_LABELS = {
    "output": "출력(LED·부저·릴레이)",
    "button": "버튼",
    "analog": "아날로그 센서 출력",
    "signal:servo": "서보 신호",
    "signal:servo-continuous": "연속 회전 서보 신호",
    "signal:esc": "ESC 스로틀 신호",
    "signal:neopixel": "NeoPixel 데이터(DIN)",
    "signal:tm1637-clk": "TM1637 CLK",
    "signal:step": "스텝 펄스(STEP)",
    "signal:dir": "방향(DIR)",
    "signal:rc522-rst": "RC522 RST",
    "signal:uart-tx": "보드 송신(모듈 RXD)",
    "signal:trig": "초음파 TRIG",
    "signal:hbridge-stby": "드라이버 대기(STBY)",
    "signal:hbridge-pwm": "모터 입력(PWM)",
    "signal:hbridge-en": "모터 속도(EN·PWM)",
    "signal:hbridge-in": "모터 방향(IN)",
}


def describe_role(role: str) -> str:
    """공유 종류의 이름 (예: 서보 신호)"""
    if role.startswith("signal:coil-"):
        return f"스테퍼 코일 입력 {role.rsplit('-', 1)[1]}"
    return ROLE_LABELS.get(role, role)


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
    if all(r == "button" for r in roles):
        return "ladder" if board is not None and supports_ladder(board, pin) and len(members) <= len(LADDER_OHMS) else "input"
    if roles[0] and roles[0] != "analog" and (roles[0] == "output" or roles[0].startswith("signal:")) and all(r == roles[0] for r in roles):
        return "output"
    return None


def share_of(c: Circuit, key: str):
    return next((s for s in c.shares if key in s.members), None)


def share_token(c: Circuit, key: str) -> str | None:
    share = share_of(c, key)
    if not share:
        return None
    roles = [role_of_key(c, k) for k in share.members]
    return f"share:{share.id}" if roles[0] != "analog" and all(r is not None and r == roles[0] for r in roles) else None


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
