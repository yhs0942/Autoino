"""전기적 규칙 (electrical.ts). 자동 핀 배정과 검증이 같은 규칙을 사용한다."""

from __future__ import annotations

from ..jsnum import js_str
from ..models import Board, BoardPin, Module, ModulePin, PlacedModule, SupplyPin

CAPABILITY_LABELS = {
    "digital": "디지털", "analog": "아날로그", "pwm": "PWM", "interrupt": "인터럽트", "i2c-sda": "I²C SDA",
    "i2c-scl": "I²C SCL", "spi-mosi": "SPI MOSI", "spi-miso": "SPI MISO", "spi-sck": "SPI SCK", "spi-ss": "SPI SS",
    "uart-rx": "UART RX", "uart-tx": "UART TX", "dac": "DAC", "touch": "터치",
}
ROLE_LABELS = {"power": "전원", "ground": "GND", "signal": "신호", "passive": "수동", "source": "전원 출력", "load": "모터 단자", "drive": "모터 출력"}

DEFAULT_SUPPLY_PINS = [SupplyPin(pin_id="5V", voltage=5), SupplyPin(pin_id="3.3V", voltage=3.3)]
DEFAULT_GROUND_PINS = ["GND"]


def supply_pins_of(board: Board) -> list[SupplyPin]:
    pins = board.supply_pins if board.supply_pins is not None else DEFAULT_SUPPLY_PINS
    return [sp for sp in pins if board.pin(sp.pin_id)]


def ground_pins_of(board: Board) -> list[str]:
    pins = board.ground_pins if board.ground_pins is not None else DEFAULT_GROUND_PINS
    return [p for p in pins if board.pin(p)]


def supply_pin_of(board: Board, pin_id: str) -> SupplyPin | None:
    return next((sp for sp in supply_pins_of(board) if sp.pin_id == pin_id), None)


def is_ground_pin(board: Board, pin_id: str) -> bool:
    return pin_id in ground_pins_of(board)


def is_gpio(pin: BoardPin) -> bool:
    return pin.group in ("digital", "analog")


def has_restriction(pin: BoardPin, kind: str) -> bool:
    return any(r.kind == kind for r in pin.restrictions or [])


def is_usb_serial_pin(board: Board, pin: BoardPin) -> bool:
    return has_restriction(pin, "usb-serial") or any(
        b.name == "Serial" and any(p.pin_id == pin.id for p in b.pins) for b in board.buses
    )


def gpio_max_input_voltage(board: Board) -> float:
    return board.gpio_max_input_voltage if board.gpio_max_input_voltage is not None else board.logic_voltage


def pin_display_name(pin: BoardPin) -> str:
    return f"{pin.id}({pin.label})" if pin.label != pin.id and not pin.id.endswith(pin.label) else pin.id


def board_pin_voltage(board: Board, pin: BoardPin) -> float | None:
    supply = supply_pin_of(board, pin.id)
    if supply:
        return supply.voltage
    if is_ground_pin(board, pin.id):
        return 0
    if is_gpio(pin) and "digital" in pin.capabilities and not has_restriction(pin, "input-only"):
        return board.logic_voltage
    return None


def supply_pin_for(board: Board, voltage: float | None) -> str | None:
    wanted = 5 if voltage is None else voltage
    return next((sp.pin_id for sp in supply_pins_of(board) if sp.voltage == wanted), None)


def supply_pin_for_pin(board: Board, pin: ModulePin) -> str | None:
    """이 전원 핀에 쓸 보드 전원 핀. 로직 전원 부품은 보드 로직 전압을 우선한다 (ESP32 → 3V3)"""
    logic = supply_pin_for(board, board.logic_voltage) if pin.logic_supply else None
    return logic or supply_pin_for(board, pin.supply_voltage)


def param_number(module: Module, placed: PlacedModule, param_id: str) -> float | None:
    param = next((p for p in module.parameters or [] if p.id == param_id), None)
    if not param:
        return None
    value = placed.params.get(param_id, param.default_value)
    option = next((o for o in param.options if o.value == value), None) or next(
        (o for o in param.options if o.value == param.default_value), None
    )
    return option.number if option else None


def source_voltage(module: Module, placed: PlacedModule | None, pin: ModulePin) -> float | None:
    """전원 출력 핀(source)의 전압(V). 알 수 없으면 None"""
    if pin.voltage_param:
        return param_number(module, placed, pin.voltage_param) if placed else None
    return pin.supply_voltage


def source_limit_ma(module: Module, placed: PlacedModule | None, pin: ModulePin) -> float | None:
    """전원 출력 핀(source)의 최대 전류(mA). 알 수 없으면 None"""
    if pin.current_param:
        return param_number(module, placed, pin.current_param) if placed else None
    return pin.max_current_ma


def uses_servo(placed: list[PlacedModule], get_module) -> bool:
    return any(get_module(p.module_id).library == "Servo" for p in placed)


def _cap_list(caps: list[str]) -> str:
    return ", ".join(CAPABILITY_LABELS.get(c, c) for c in caps)


def _source_link_error(board: Board, board_pin: BoardPin, volts: float | None) -> str | None:
    """외부 전원 + 를 보드 핀에 연결했을 때의 치명적 오류"""
    pid = board_pin.id
    if is_ground_pin(board, pid):
        return "전원 + 를 GND 에 연결하면 단락(쇼트)이 됩니다."
    power_input = board.power_input
    if power_input and power_input.pin_id == pid:
        if volts is not None and volts > power_input.max_voltage:
            return f"{pid} 입력 범위({js_str(power_input.min_voltage)}–{js_str(power_input.max_voltage)} V)를 넘는 {js_str(volts)} V 입니다. 보드가 손상될 수 있습니다."
        return None
    supply = supply_pin_of(board, pid)
    if supply:
        if volts is None or volts == supply.voltage:
            return None
        return f"{pid} 핀은 {js_str(supply.voltage)} V 입니다. {js_str(volts)} V 를 넣으면 보드가 손상됩니다."
    tail = f" 보드에 전원을 넣으려면 {power_input.pin_id} 에 연결하세요." if power_input else ""
    return f"{pid} 에는 외부 전원을 연결할 수 없습니다.{tail}"


def link_error(board: Board, module: Module, pin: ModulePin, board_pin: BoardPin | None, placed: PlacedModule | None = None) -> str | None:
    """모듈 핀을 보드 핀에 연결했을 때의 치명적 오류. 없으면 None."""
    if board_pin is None:
        return f"{board.name}에 없는 핀입니다."
    pid = board_pin.id
    is_supply = supply_pin_of(board, pid) is not None
    if pin.role == "power":
        if is_ground_pin(board, pid):
            return "전원 핀을 GND 에 연결하면 단락(쇼트)이 됩니다."
        if is_supply:
            return None
        if pid == "VIN":
            return "VIN 은 외부 입력 전압(7–12 V)이 그대로 나올 수 있어 부품이 손상될 수 있습니다. 5V 핀을 사용하세요."
        return f"{pid} 는 부품 전원 공급용 핀이 아닙니다. {' 또는 '.join(sp.pin_id for sp in supply_pins_of(board))} 에 연결하세요."
    if pin.role == "ground":
        if is_supply or pid == "VIN":
            return "GND 핀을 전원 핀에 연결하면 단락(쇼트)이 됩니다."
        if not is_ground_pin(board, pid):
            return "GND 핀은 보드의 GND 에 연결해야 합니다."
        return None
    if pin.role == "signal":
        if is_ground_pin(board, pid):
            # 멀티플렉서의 쓰지 않는 선택선은 GND 에 묶는다
            return None if module.mux and pin.id in module.mux.select else "신호 핀을 GND 에 직접 연결했습니다."
        if not is_gpio(board_pin):
            if module.series_resistor and module.series_resistor.pin_id == pin.id and is_supply:
                return None
            return f"신호 핀을 {pid} 에 직접 연결했습니다. GPIO 핀에 연결하세요."
        missing = [c for c in pin.requires if c not in board_pin.capabilities]
        if missing:
            return f"{pid} 는 {_cap_list(missing)} 기능을 지원하지 않습니다."
        if has_restriction(board_pin, "input-only") and (pin.direction or "inout") != "in":
            return f"{pin_display_name(board_pin)} 는 입력 전용 핀이라 {pin.name} 신호를 출력할 수 없습니다."
        return None
    if pin.role == "source":
        return _source_link_error(board, board_pin, source_voltage(module, placed, pin))
    if pin.role == "load":
        return "모터 단자를 보드 핀에 직접 연결하면 보드가 손상될 수 있습니다. 모터 드라이버 출력에 연결하세요."
    if pin.role == "drive":
        return "모터 드라이버 출력은 보드 핀이 아니라 모터 단자에 연결합니다."
    return None


def compatible_pins(board: Board, module: Module, pin: ModulePin, placed: PlacedModule | None = None) -> list[str]:
    return [bp.id for bp in board.pins if link_error(board, module, pin, bp, placed) is None]


def board_to_board_error(a_board: Board, a_pin: BoardPin | None, b_board: Board, b_pin: BoardPin | None) -> str | None:
    if a_pin is None:
        return f"{a_board.name}에 없는 핀입니다."
    if b_pin is None:
        return f"{b_board.name}에 없는 핀입니다."

    def kind(board: Board, pin: BoardPin) -> str:
        if is_ground_pin(board, pin.id):
            return "ground"
        if supply_pin_of(board, pin.id):
            return "supply"
        if is_gpio(pin):
            return "gpio"
        if pin.group == "control":
            return "control"
        return "other"

    ka, kb = kind(a_board, a_pin), kind(b_board, b_pin)
    if ka == "other" or kb == "other":
        return f"{a_pin.id if ka == 'other' else b_pin.id} 는 보드 간 연결에 사용할 수 없는 핀입니다."
    if ka == "ground" and kb == "ground":
        return None
    if (ka == "ground" and kb == "supply") or (ka == "supply" and kb == "ground"):
        return "전원 핀과 GND 를 연결하면 단락(쇼트)이 됩니다."
    if ka == "supply" and kb == "supply":
        va = supply_pin_of(a_board, a_pin.id).voltage
        vb = supply_pin_of(b_board, b_pin.id).voltage
        return None if va == vb else f"전압이 다른 전원({js_str(va)} V 와 {js_str(vb)} V)을 연결하면 단락됩니다."
    if ka == "gpio" and kb == "gpio":
        return None
    if ka == "control" or kb == "control":
        if ka in ("ground", "supply") or kb in ("ground", "supply"):
            return "제어 핀(EN 등)을 전원·GND 에 직접 연결하면 보드가 계속 리셋되거나 동작하지 않습니다."
        return None
    return "신호 핀을 다른 보드의 전원·GND 에 직접 연결했습니다."
