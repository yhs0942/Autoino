"""직류(DC) 회로 시뮬레이션.

배선된 회로를 저항·전원·다이오드로 바꾼 뒤 절점 해석(nodal analysis)으로 각 넷의 전압과 전류를 구한다.
한 순간의 정상 상태(“이 GPIO 가 HIGH 이고 버튼을 누르고 있을 때”)만 계산하며 시간에 따른 동작,
통신 신호, 마이크로컨트롤러 프로그램 실행은 다루지 않는다.

모델 (값은 ASSUMPTIONS 에 사용자에게 보여 주는 설명과 함께 정리)
- 보드 전원 핀: 이상 전압원 + 내부 저항 0.1 Ω (보드 GND 기준)
- GPIO 출력: 로직 전압(HIGH) 또는 0 V(LOW) + 출력 저항 (AVR 25 Ω, ESP32 35 Ω)
- GPIO 입력: 고임피던스, INPUT_PULLUP 이면 내부 풀업 (AVR 35 kΩ, ESP32 45 kΩ)
- LED: 구간 선형 다이오드 (켜짐 전압 Vf−0.2 V, 동저항 10 Ω → 20 mA 에서 Vf), 계산된 직렬 저항을 애노드 쪽에 넣는다
- 푸시 버튼: 누르면 0.05 Ω, 떼면 열림
- HC-SR04 / SG90 / LCD: VCC–GND 사이 부하 저항 (전류 가정값), Echo 출력은 100 Ω 로 VCC 또는 GND 에 연결
- I²C LCD: SDA/SCL 에 4.7 kΩ 풀업 (백팩 보드 일반값)
- 전압 분배기: 옵션 값(예: 1k-2k)의 두 저항
- 외부 전원·레귤레이터 출력: 이상 전압원 + 내부 저항 0.05 Ω
- 모터: 드라이버 전원 핀의 부하로 계산 (평상시 전류, 스톨 표시하면 스톨 전류). 모터 전압 = 전원 − 드라이버 전압 강하
- 그 밖의 부품: 전원 핀에 부품 데이터의 평상시 전류를 흘리는 부하 저항
- 4채널 레벨 시프터(BSS138): 채널마다 양쪽 10 kΩ 풀업, 한쪽이 (LV−1.5 V) 아래로 내려가면 3.5 Ω 스위치로 연결
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .engine.circuit import Circuit, board_label, endpoint_key, module_ep
from .engine.electrical import ground_pins_of, is_gpio, param_number, source_limit_ma, source_voltage, supply_pins_of
from .engine.netlist import Netlist, build_netlist
from .engine.power import format_current, load_of_pin, motors_on_channel, net_voltage
from .engine.resistor import compute_series_resistors
from .jsnum import js_round

GMIN = 1e-12  # 수치 안정용 아주 작은 누설 컨덕턴스
G_OFF = 1e-9  # 꺼진 다이오드·스위치
G_LINK = 1e-6  # 이 값 이상이면 '연결됨'으로 본다 (넷 전압 결정 여부 판단)

SUPPLY_R = 0.1
SOURCE_R = 0.05
OUTPUT_R = {"arduino-avr": 25.0, "arduino-esp32": 35.0}
PULLUP_R = {"arduino-avr": 35_000.0, "arduino-esp32": 45_000.0}
VIL_RATIO = {"arduino-avr": 0.3, "arduino-esp32": 0.25}
LED_RD = 10.0
LED_KNEE = 0.2
BUTTON_R = 0.05
ECHO_R = 100.0
I2C_PULLUP_R = 4_700.0
SHIFTER_PULLUP_R = 10_000.0
SHIFTER_RON = 3.5
SHIFTER_VTH = 1.5
LOAD_MA = {"hc-sr04": None, "sg90": 10.0, "i2c-lcd-1602": 25.0}
SERVO_MOVING_MA = 250.0
SERVO_IDLE_MA = 10.0
SHORT_MA = 2_000.0

ASSUMPTIONS = [
    "직류 정상 상태만 계산합니다. PWM·통신 신호·시간에 따른 변화는 다루지 않습니다.",
    "보드 전원 핀은 내부 저항 0.1 Ω 의 이상 전압원으로 봅니다. USB 전원 한계(보통 500 mA)와 레귤레이터 발열은 따로 경고합니다.",
    "GPIO 출력 저항은 AVR 25 Ω, ESP32 35 Ω 으로 가정합니다 (데이터시트의 출력 전압–전류 특성에서 어림한 값).",
    "INPUT_PULLUP 내부 풀업은 AVR 35 kΩ (데이터시트 20–50 kΩ), ESP32 45 kΩ 으로 가정합니다.",
    "입력 판정 기준: HIGH ≥ 보드 데이터의 gpioInputHighMinVoltage, LOW ≤ 0.3×VCC (AVR) / 0.25×VDD (ESP32), 그 사이는 '불확실'.",
    "LED 는 켜짐 전압 Vf−0.2 V, 동저항 10 Ω 의 구간 선형 모델입니다 (20 mA 에서 Vf). 직렬 저항은 Autoino 가 계산한 표준값을 넣습니다.",
    "HC-SR04 는 15 mA, SG90 은 정지 10 mA (움직일 때 250 mA), LCD 1602 는 백라이트 포함 25 mA 의 부하 저항으로 봅니다.",
    "I²C LCD 백팩의 SDA/SCL 풀업은 4.7 kΩ 으로 가정합니다. 실제 제품마다 다를 수 있습니다.",
    "레벨 시프터(BSS138)는 채널마다 10 kΩ 풀업과, 한쪽이 LV−1.5 V 아래로 내려가면 켜지는 3.5 Ω 스위치로 근사합니다.",
    "공통 GND 로 연결되지 않은 보드의 입력은 판정하지 않습니다.",
    "외부 전원과 레귤레이터 출력은 내부 저항 0.05 Ω 의 이상 전압원으로 봅니다. 배터리 전압 강하는 다루지 않습니다.",
    "모터는 드라이버 전원 핀의 일정 전류 부하로 봅니다 (평상시 전류, 스톨을 고르면 스톨 전류). 모터 전압은 전원 전압에서 드라이버 전압 강하를 뺀 값입니다.",
    "그 밖의 부품은 부품 데이터의 평상시 전류를 흘리는 부하 저항으로 봅니다.",
]


class SimulationError(ValueError):
    """시뮬레이션 옵션 오류"""


@dataclass
class SimOptions:
    gpio: dict[str, str] = field(default_factory=dict)  # "board-1:D5" → high | low | input | input-pullup
    pressed: list[str] = field(default_factory=list)  # 누르고 있는 버튼 인스턴스 ID
    module_outputs: dict[str, str] = field(default_factory=dict)  # "hc-sr04#1:echo" → high | low
    servo_moving: list[str] = field(default_factory=list)  # 움직이는 서보 인스턴스 ID
    motors_stalled: list[str] = field(default_factory=list)  # 스톨 상태로 계산할 모터 인스턴스 ID
    include_series_resistors: bool = True

    @classmethod
    def parse(cls, raw: dict | None) -> "SimOptions":
        raw = raw or {}
        gpio = raw.get("gpio") or {}
        outputs = raw.get("moduleOutputs") or {}
        for k, v in gpio.items():
            if v not in ("high", "low", "input", "input-pullup"):
                raise SimulationError(f"GPIO 상태 값이 잘못되었습니다: {k} = {v}")
        for k, v in outputs.items():
            if v not in ("high", "low"):
                raise SimulationError(f"부품 출력 값이 잘못되었습니다: {k} = {v}")
        return cls(
            gpio=dict(gpio),
            pressed=list(raw.get("pressed") or []),
            module_outputs=dict(outputs),
            servo_moving=list(raw.get("servoMoving") or []),
            motors_stalled=list(raw.get("motorsStalled") or []),
            include_series_resistors=raw.get("includeSeriesResistors", True) is not False,
        )


# ---------------------------------------------------------------- 소자


@dataclass
class _Branch:
    """a–b 사이 컨덕턴스 g, a 쪽에서 전압 v 만큼 높은 전압원 (Thevenin: v, 1/g)"""

    a: str
    b: str
    g: float
    v: float = 0.0
    tag: str = ""


@dataclass
class _Diode:
    anode: str
    cathode: str
    v_on: float
    rd: float
    on: bool = False


@dataclass
class _Switch:
    """레벨 시프터 채널: x 또는 y 가 (기준 전압 − 문턱) 아래이면 켜진다"""

    x: str
    y: str
    ref: str
    on: bool = False


def _solve(n: int, g: list[list[float]], i: list[float]) -> list[float]:
    """가우스 소거 (부분 피벗)"""
    a = [row[:] + [i[r]] for r, row in enumerate(g)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(a[r][col]))
        if abs(a[piv][col]) < 1e-30:
            continue
        a[col], a[piv] = a[piv], a[col]
        for r in range(n):
            if r != col and a[r][col] != 0.0:
                f = a[r][col] / a[col][col]
                row_r, row_c = a[r], a[col]
                for k in range(col, n + 1):
                    row_r[k] -= f * row_c[k]
    return [a[r][n] / a[r][r] if abs(a[r][r]) > 1e-30 else 0.0 for r in range(n)]


def _parse_ohms(text: str) -> float:
    """'2k2' → 2200, '1k5' → 1500, '10k' → 10000, '470' → 470"""
    m = re.fullmatch(r"(\d+)([kKmM]?)(\d*)", text.strip())
    if not m:
        raise SimulationError(f"저항 값을 해석할 수 없습니다: {text}")
    whole, unit, frac = m.groups()
    mult = {"": 1, "k": 1e3, "K": 1e3, "m": 1e6, "M": 1e6}[unit]
    return float(f"{whole}.{frac or 0}") * mult


def divider_resistors(option_value: str) -> tuple[float, float]:
    top, _, bottom = option_value.partition("-")
    return _parse_ohms(top), _parse_ohms(bottom)


def _round(v: float | None, digits: int) -> float | None:
    return None if v is None else js_round(v * 10**digits) / 10**digits


# ---------------------------------------------------------------- 회로 → 소자


class _Model:
    def __init__(self, c: Circuit, options: SimOptions) -> None:
        self.c = c
        self.options = options
        self.net: Netlist = build_netlist(c)
        self.branches: list[_Branch] = []
        self.diodes: list[_Diode] = []
        self.switches: list[_Switch] = []
        self.grounds: set[str] = set()
        self.board_ground: dict[str, str] = {}
        self.gpio: list[dict] = []
        self.supplies: list[dict] = []
        self.leds: list[dict] = []
        self.loads: list[dict] = []
        self.motors: list[dict] = []
        self.warnings: list[str] = []
        self.internal = 0

    def node(self, key: str) -> str:
        return self.net.net_of(key)

    def mnode(self, instance_id: str, pin_id: str) -> str:
        return self.node(endpoint_key(module_ep(instance_id, pin_id)))

    def fresh(self, name: str) -> str:
        self.internal += 1
        return f"internal:{name}:{self.internal}"

    def resistor(self, a: str, b: str, ohms: float, tag: str = "") -> _Branch:
        br = _Branch(a, b, 1.0 / ohms, 0.0, tag)
        self.branches.append(br)
        return br

    def source(self, plus: str, minus: str, volts: float, ohms: float, tag: str = "") -> _Branch:
        br = _Branch(plus, minus, 1.0 / ohms, volts, tag)
        self.branches.append(br)
        return br

    # -------- 보드
    def gpio_modes(self) -> dict[str, tuple[str, str]]:
        """보드 핀 키 → (모드, 이유)"""
        c = self.c
        modes: dict[str, tuple[str, str]] = {}
        for item in c.placed:
            module = c.module_def(item.module_id)
            if not module:
                continue
            for pin in module.pins:
                if pin.role != "signal" or not pin.direction:
                    continue
                for k in self.net.members.get(self.mnode(item.instance_id, pin.id), []):
                    if not k.startswith("board:"):
                        continue
                    if any(cap.startswith("i2c-") for cap in pin.requires):
                        # I²C 는 오픈 드레인: 유휴 상태에서는 핀을 놓고 풀업이 HIGH 를 만든다
                        modes.setdefault(k, ("input", f"{item.label} {pin.name} (I²C 오픈 드레인, 유휴)"))
                    elif pin.direction == "out":
                        modes[k] = ("output-high", f"{item.label} {pin.name} 구동")
                    elif k not in modes:
                        mode = "input-pullup" if pin.pull == "up" else "input"
                        modes[k] = (mode, f"{item.label} {pin.name} 읽기")
        outputs = {"UART": {"TX"}, "SPI-controller": {"MOSI", "SCK", "SS"}, "SPI-peripheral": {"MISO"}}
        for link in c.links:
            for end, controller in ((link.a, True), (link.b, False)):
                kind = link.protocol if link.protocol != "SPI" else ("SPI-controller" if controller else "SPI-peripheral")
                for role, pin_id in end.pins.items():
                    k = f"board:{end.board_instance_id}:{pin_id}"
                    if link.protocol == "I2C":
                        modes.setdefault(k, ("input", f"{link.id} {role} (I²C 오픈 드레인, 유휴)"))
                    elif role in outputs.get(kind, set()):
                        modes[k] = ("output-high", f"{link.id} {role} (유휴 HIGH)")
                    elif k not in modes:
                        modes[k] = ("input", f"{link.id} {role}")
        return modes

    def add_boards(self) -> None:
        c = self.c
        modes = self.gpio_modes()
        for inst in c.boards:
            board = c.board_def(inst.instance_id)
            if not board:
                continue
            grounds = [self.node(f"board:{inst.instance_id}:{g}") for g in ground_pins_of(board)]
            gnd = grounds[0]
            self.grounds.update(grounds)
            self.board_ground[inst.instance_id] = gnd
            for sp in supply_pins_of(board):
                n = self.node(f"board:{inst.instance_id}:{sp.pin_id}")
                br = self.source(n, gnd, sp.voltage, SUPPLY_R, "supply")
                self.supplies.append({"boardInstanceId": inst.instance_id, "pinId": sp.pin_id, "nominal": sp.voltage, "_branch": br})
            wired = {k for conn in c.connections for k in (endpoint_key(conn.from_), endpoint_key(conn.to))}
            used_pins = {k.split(":", 2)[2] for k in modes.keys() | wired if k.startswith(f"board:{inst.instance_id}:")}
            for pin_id in sorted(used_pins | {k.split(":", 1)[1] for k in self.options.gpio if k.startswith(f"{inst.instance_id}:")}):
                pin = board.pin(pin_id)
                if not pin or not is_gpio(pin):
                    continue
                key = f"board:{inst.instance_id}:{pin_id}"
                mode, reason = modes.get(key, ("input", "배선됨 (입력으로 가정)"))
                override = self.options.gpio.get(f"{inst.instance_id}:{pin_id}")
                if override:
                    mode = {"high": "output-high", "low": "output-low"}.get(override, override)
                    reason = "사용자 지정"
                if mode == "input-pullup" and any(r.kind == "no-internal-pull" for r in pin.restrictions or []):
                    mode = "input"
                    self.warnings.append(f"{board_label(c, inst.instance_id)} {pin_id}: 내부 풀업이 없는 핀이라 풀업 없이 계산했습니다.")
                if mode.startswith("output") and any(r.kind == "input-only" for r in pin.restrictions or []):
                    mode = "input"
                    self.warnings.append(f"{board_label(c, inst.instance_id)} {pin_id}: 입력 전용 핀이라 출력으로 계산하지 않았습니다.")
                n = self.node(key)
                br = None
                if mode == "output-high":
                    br = self.source(n, gnd, board.logic_voltage, OUTPUT_R[board.core], "gpio")
                elif mode == "output-low":
                    br = self.source(n, gnd, 0.0, OUTPUT_R[board.core], "gpio")
                elif mode == "input-pullup":
                    br = self.source(n, gnd, board.logic_voltage, PULLUP_R[board.core], "pullup")
                self.gpio.append({"boardInstanceId": inst.instance_id, "pinId": pin_id, "mode": mode, "reason": reason, "_node": n, "_branch": br, "_board": board})

    # -------- 외부 전원
    def add_sources(self) -> None:
        for item in self.c.placed:
            module = self.c.module_def(item.module_id)
            pins = [p for p in module.pins if p.role == "source"] if module else []
            for pin in pins:
                volts = source_voltage(module, item, pin)
                if volts is None:
                    continue
                after = module.pins[module.pins.index(pin) :]
                ground = next((p for p in after if p.role == "ground"), None) or next((p for p in module.pins if p.role == "ground"), None)
                minus = self.mnode(item.instance_id, ground.id)
                self.grounds.add(minus)
                br = self.source(self.mnode(item.instance_id, pin.id), minus, volts, SOURCE_R, "source")
                label = f"{item.label} {pin.name}" if len(pins) > 1 else item.label
                self.supplies.append({"boardInstanceId": "", "pinId": label, "nominal": volts, "limitMa": source_limit_ma(module, item, pin), "_branch": br})

    def add_load(self, item, module, pin, ma: float, nominal: float, label: str | None = None) -> None:
        """전원 핀에 일정 전류 부하를 단다. 실제 전원 전압을 알면 그 전압 기준으로 저항을 정한다"""
        ground = next((p for p in module.pins if p.role == "ground"), None)
        if ma <= 0 or ground is None:
            return
        key = endpoint_key(module_ep(item.instance_id, pin.id))
        volts = net_voltage(self.c, self.net, key) or nominal
        br = self.resistor(self.mnode(item.instance_id, pin.id), self.mnode(item.instance_id, ground.id), volts / (ma / 1000.0), "load")
        self.loads.append({"instanceId": f"{item.instance_id}:{pin.id}", "label": label or item.label, "nominalVoltage": nominal, "assumedMa": ma, "_branch": br})

    def add_driver(self, item, module) -> None:
        """드라이버: 전원 핀 전류 = 자체 전류 + 연결된 모터 전류"""
        driver = module.driver
        pin = module.pin(driver.supply_pin)
        own = pin.typical_ma or 0.0
        total = own
        for channel in driver.channels:
            for placed, motor in motors_on_channel(self.c, self.net, item, channel):
                spec = motor.motor
                stalled = placed.instance_id in self.options.motors_stalled
                ma = spec.peak_ma if stalled else spec.typical_ma
                total += ma
                self.motors.append({"instanceId": placed.instance_id, "label": placed.label, "driver": item.label, "channel": channel.label, "assumedMa": ma, "stalled": stalled, "_spec": spec, "_drop": driver.drop_voltage, "_key": endpoint_key(module_ep(item.instance_id, pin.id))})
        self.add_load(item, module, pin, total, pin.supply_voltage or 5.0)
        for other in [p for p in module.pins if p.role == "power" and p.id != pin.id]:
            self.add_load(item, module, other, other.typical_ma or 0.0, other.supply_voltage or 5.0, f"{item.label} {other.name}")

    # -------- 부품
    def add_modules(self) -> None:
        c = self.c
        resistors = {r["instanceId"]: r for r in compute_series_resistors(c)}
        for item in c.placed:
            module = c.module_def(item.module_id)
            if not module:
                continue
            p = lambda pin_id: self.mnode(item.instance_id, pin_id)  # noqa: E731
            mid = item.module_id
            if mid == "led-5mm":
                vf = param_number(module, item, "color") or 2.0
                rated = param_number(module, item, "current") or 10.0
                r = resistors.get(item.instance_id)
                ohms = r["choice"]["standardOhms"] if r and r["status"] == "ok" and self.options.include_series_resistors else None
                anode = p("anode")
                if ohms:
                    inner = self.fresh(f"{item.instance_id}:anode")
                    self.resistor(anode, inner, ohms, "led-resistor")
                    anode = inner
                d = _Diode(anode, p("cathode"), vf - LED_KNEE, LED_RD)
                self.diodes.append(d)
                self.leds.append({"instanceId": item.instance_id, "label": item.label, "ratedMa": rated, "seriesOhms": ohms, "_diode": d})
            elif mid == "push-button":
                if item.instance_id in self.options.pressed:
                    self.resistor(p("pin1a"), p("pin2a"), BUTTON_R, "button")
            elif module.driver:
                self.add_driver(item, module)
            elif mid in ("hc-sr04", "sg90", "i2c-lcd-1602"):
                vcc_pin = module.pin("vcc")
                volts = vcc_pin.supply_voltage if vcc_pin and vcc_pin.supply_voltage else 5.0
                ma = module.typical_current_ma if mid == "hc-sr04" else LOAD_MA[mid]
                if mid == "sg90" and item.instance_id in self.options.servo_moving:
                    ma = SERVO_MOVING_MA
                br = self.resistor(p("vcc"), p("gnd"), volts / (ma / 1000.0), "load")
                self.loads.append({"instanceId": item.instance_id, "label": item.label, "nominalVoltage": volts, "assumedMa": ma, "_branch": br})
                if mid == "hc-sr04":
                    level = self.options.module_outputs.get(f"{item.instance_id}:echo", "low")
                    self.resistor(p("echo"), p("vcc") if level == "high" else p("gnd"), ECHO_R, "echo")
                if mid == "i2c-lcd-1602":
                    self.resistor(p("sda"), p("vcc"), I2C_PULLUP_R, "i2c-pullup")
                    self.resistor(p("scl"), p("vcc"), I2C_PULLUP_R, "i2c-pullup")
            elif mid == "voltage-divider":
                value = item.params.get("ratio") or (module.parameters[0].default_value if module.parameters else "1k-2k")
                top, bottom = divider_resistors(value)
                self.resistor(p("in"), p("out"), top, "divider")
                self.resistor(p("out"), p("gnd"), bottom, "divider")
            elif mid == "level-shifter-4ch":
                for ch in range(1, 5):
                    self.resistor(p(f"hv{ch}"), p("hv"), SHIFTER_PULLUP_R, "shifter-pullup")
                    self.resistor(p(f"lv{ch}"), p("lv"), SHIFTER_PULLUP_R, "shifter-pullup")
                    self.switches.append(_Switch(p(f"lv{ch}"), p(f"hv{ch}"), p("lv")))
            elif module.regulator:
                pin = module.pin(module.regulator.input_pin)
                self.add_load(item, module, pin, load_of_pin(self.c, self.net, item, module, pin)["typicalMa"] or 0.0, pin.supply_voltage or 5.0)
            elif not module.motor:
                for pin in [x for x in module.pins if x.role == "power"]:
                    ma = load_of_pin(self.c, self.net, item, module, pin)["typicalMa"] or 0.0
                    if module.library == "Servo":
                        ma = ma if item.instance_id in self.options.servo_moving else SERVO_IDLE_MA
                    self.add_load(item, module, pin, ma, pin.supply_voltage or 5.0)

    # -------- 해석
    def edges(self) -> list[tuple[str, str, float]]:
        out = [(b.a, b.b, b.g) for b in self.branches]
        out += [(d.anode, d.cathode, 1.0 / d.rd if d.on else G_OFF) for d in self.diodes]
        out += [(s.x, s.y, 1.0 / SHIFTER_RON if s.on else G_OFF) for s in self.switches]
        return out

    def solve_once(self) -> dict[str, float]:
        nodes = sorted({n for a, b, _ in self.edges() for n in (a, b)} | self.grounds)
        # 접지 넷과 강하게 연결된 묶음마다 기준(0 V)을 하나 둔다
        parent = {n: n for n in nodes}

        def find(x: str) -> str:
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for a, b, g in self.edges():
            if g >= G_LINK:
                parent[find(a)] = find(b)
        refs: dict[str, str] = {}
        for gnd in sorted(self.grounds):
            refs.setdefault(find(gnd), gnd)
        fixed = set(refs.values())
        unknown = [n for n in nodes if n not in fixed]
        index = {n: i for i, n in enumerate(unknown)}
        size = len(unknown)
        gm = [[0.0] * size for _ in range(size)]
        cur = [0.0] * size
        for i in range(size):
            gm[i][i] += GMIN

        def stamp(a: str, b: str, g: float, v: float) -> None:
            # a 에서 b 로 흐르는 전류 = g·(Va − Vb − v)
            ia, ib = index.get(a), index.get(b)
            if ia is not None:
                gm[ia][ia] += g
                cur[ia] += g * v
            if ib is not None:
                gm[ib][ib] += g
                cur[ib] -= g * v
            if ia is not None and ib is not None:
                gm[ia][ib] -= g
                gm[ib][ia] -= g

        for br in self.branches:
            stamp(br.a, br.b, br.g, br.v)
        for d in self.diodes:
            stamp(d.anode, d.cathode, 1.0 / d.rd, d.v_on) if d.on else stamp(d.anode, d.cathode, G_OFF, 0.0)
        for s in self.switches:
            stamp(s.x, s.y, 1.0 / SHIFTER_RON if s.on else G_OFF, 0.0)
        values = _solve(size, gm, cur) if size else []
        volts = {n: 0.0 for n in fixed}
        volts.update({n: values[index[n]] for n in unknown})
        self._parent = {n: find(n) for n in nodes}
        self._fixed_roots = set(refs)
        return volts

    def run(self) -> tuple[dict[str, float], int, bool]:
        volts: dict[str, float] = {}
        for iteration in range(1, 101):
            volts = self.solve_once()
            changed = False
            for d in self.diodes:
                vd = volts.get(d.anode, 0.0) - volts.get(d.cathode, 0.0)
                want = (vd - d.v_on) / d.rd > 0 if d.on else vd > d.v_on
                if want != d.on:
                    d.on = want
                    changed = True
            for s in self.switches:
                threshold = volts.get(s.ref, 0.0) - SHIFTER_VTH
                want = volts.get(s.ref, 0.0) > SHIFTER_VTH and min(volts.get(s.x, 0.0), volts.get(s.y, 0.0)) < threshold
                if want != s.on:
                    s.on = want
                    changed = True
            if not changed:
                return volts, iteration, True
        return volts, 100, False

    def determined(self, n: str) -> bool:
        return self._parent.get(n) in self._fixed_roots if hasattr(self, "_parent") else False


def _branch_current(br: _Branch, volts: dict[str, float]) -> float:
    """a → b 방향 전류 (A)"""
    return br.g * (volts.get(br.a, 0.0) - volts.get(br.b, 0.0) - br.v)


def simulate(c: Circuit, raw_options: dict | None = None) -> dict:
    options = SimOptions.parse(raw_options)
    m = _Model(c, options)
    m.add_boards()
    m.add_sources()
    m.add_modules()
    volts, iterations, converged = m.run()

    def v_of(n: str) -> float | None:
        return volts.get(n) if m.determined(n) else None

    # 넷 목록 (사람이 읽을 수 있는 구성원 이름)
    nets = []
    for root, members in sorted(m.net.members.items()):
        if not members:
            continue
        names = []
        for k in members:
            parts = k.split(":", 2)
            if parts[0] == "board":
                names.append(f"{board_label(c, parts[1])} {parts[2]}" if len(c.boards) > 1 else parts[2])
            else:
                item = c.placed_module(parts[1])
                module = c.module_def(item.module_id) if item else None
                pin = module.pin(parts[2]) if module else None
                names.append(f"{item.label if item else parts[1]} {pin.name if pin else parts[2]}")
        nets.append({"net": root, "members": names, "voltage": _round(v_of(root), 3), "ground": root in m.grounds})

    gpio_rows = []
    total_by_board: dict[str, float] = {}
    for g in m.gpio:
        board = g.pop("_board")
        br = g.pop("_branch")
        n = g.pop("_node")
        v = v_of(n)
        ma = -_branch_current(br, volts) * 1000.0 if br is not None and v is not None else 0.0
        row = {**g, "voltage": _round(v, 3), "currentMa": _round(ma, 2), "limitMa": board.io_pin_current_limit_ma}
        row["overCurrent"] = g["mode"].startswith("output") and abs(ma) > board.io_pin_current_limit_ma
        vmax = board.gpio_max_input_voltage if board.gpio_max_input_voltage is not None else board.logic_voltage + 0.5
        row["overVoltage"] = v is not None and v > vmax + 1e-6
        if g["mode"].startswith("input"):
            gnd = m.board_ground.get(g["boardInstanceId"])
            if v is None:
                row["logic"] = "floating"
            elif m._parent.get(n) != m._parent.get(gnd):
                row["logic"] = "no-common-ground"
            else:
                vil = VIL_RATIO[board.core] * board.logic_voltage
                row["logic"] = "HIGH" if v >= board.gpio_input_high_min_voltage else "LOW" if v <= vil else "undefined"
        else:
            row["logic"] = "HIGH" if g["mode"] == "output-high" else "LOW"
        if g["mode"].startswith("output"):
            total_by_board[g["boardInstanceId"]] = total_by_board.get(g["boardInstanceId"], 0.0) + abs(ma)
        gpio_rows.append(row)

    warnings = list(m.warnings)
    for row in gpio_rows:
        where = f"{board_label(c, row['boardInstanceId'])} {row['pinId']}"
        if row["overCurrent"]:
            warnings.append(f"{where}: GPIO 전류 {row['currentMa']} mA 가 권장 한계 {row['limitMa']:g} mA 를 넘습니다.")
        if row["overVoltage"]:
            warnings.append(f"{where}: 입력 전압 {row['voltage']} V 가 허용 최대값을 넘습니다. 보드가 손상될 수 있습니다.")
        if row["logic"] == "undefined":
            warnings.append(f"{where}: 입력 전압 {row['voltage']} V 는 HIGH 도 LOW 도 아닌 불확실한 범위입니다.")
        if row["logic"] == "floating" and row["mode"] == "input":
            warnings.append(f"{where}: 입력이 떠 있습니다 (풀업/풀다운 없음). 값이 무작위로 바뀔 수 있습니다.")
        if row["logic"] == "no-common-ground":
            warnings.append(f"{where}: 신호를 보내는 쪽과 GND 가 공유되지 않아 입력 값을 판정할 수 없습니다.")
    for inst in c.boards:
        board = c.board_def(inst.instance_id)
        total = total_by_board.get(inst.instance_id, 0.0)
        if board and total > board.total_current_limit_ma:
            warnings.append(f"{board_label(c, inst.instance_id)}: GPIO 출력 전류 합계 {_round(total, 1)} mA 가 한계 {board.total_current_limit_ma:g} mA 를 넘습니다.")

    supplies = []
    for s in m.supplies:
        br = s.pop("_branch")
        limit = s.pop("limitMa", None)
        ma = -_branch_current(br, volts) * 1000.0
        v = v_of(br.a)
        supplies.append({**s, "voltage": _round(v, 3), "currentMa": _round(ma, 2)})
        if not s["boardInstanceId"]:
            if limit is not None and ma > limit:
                warnings.append(f"{s['pinId']}: 전류 {format_current(ma)} 가 전원 용량 {format_current(limit)} 을 넘습니다.")
            continue
        if abs(ma) > SHORT_MA:
            warnings.append(f"{board_label(c, s['boardInstanceId'])} {s['pinId']}: 전류 {_round(abs(ma) / 1000.0, 1)} A — 전원이 GND 나 다른 전원과 단락되어 있습니다. 실제 회로에서는 보드가 손상됩니다.")
        elif ma > 500.0:
            warnings.append(f"{board_label(c, s['boardInstanceId'])} {s['pinId']}: 전원 전류 {_round(ma, 1)} mA — USB 전원(보통 500 mA)으로는 부족할 수 있습니다. 외부 전원을 고려하세요.")
        elif ma < -1.0:
            warnings.append(f"{board_label(c, s['boardInstanceId'])} {s['pinId']}: 전원 핀으로 전류가 거꾸로 들어갑니다 ({_round(-ma, 1)} mA). 다른 전원과 직접 연결되어 있지 않은지 확인하세요.")

    leds = []
    for led in m.leds:
        d: _Diode = led.pop("_diode")
        va, vk = v_of(d.anode), v_of(d.cathode)
        if va is None or vk is None:
            ma = 0.0
            state = "unpowered"
        else:
            ma = max(0.0, (va - vk - d.v_on) / d.rd * 1000.0) if d.on else 0.0
            state = "off" if ma < 0.05 else "over" if ma > 20.0 + 1e-9 else "on"
        brightness = min(100.0, ma / led["ratedMa"] * 100.0) if led["ratedMa"] else 0.0
        leds.append({**led, "currentMa": _round(ma, 2), "forwardVoltage": _round(va - vk, 3) if va is not None and vk is not None else None, "brightness": _round(brightness, 0), "state": state})
        if state == "over":
            warnings.append(f"{led['label']}: LED 전류 {_round(ma, 1)} mA 가 일반 5 mm LED 최대 20 mA 를 넘습니다. 직렬 저항을 확인하세요.")

    loads = []
    for load in m.loads:
        br = load.pop("_branch")
        va, vb = v_of(br.a), v_of(br.b)
        across = va - vb if va is not None and vb is not None else None
        ma = _branch_current(br, volts) * 1000.0 if across is not None else 0.0
        nominal = load["nominalVoltage"]
        status = "unpowered" if across is None or across < 0.5 else "ok" if across >= nominal * 0.9 else "low"
        loads.append({**load, "voltage": _round(across, 3), "currentMa": _round(ma, 2), "status": status})
        if status == "low":
            warnings.append(f"{load['label']}: 전원 전압 {_round(across, 2)} V 가 정격 {nominal:g} V 보다 낮아 제대로 동작하지 않을 수 있습니다.")
        if status == "unpowered":
            warnings.append(f"{load['label']}: 전원(VCC/GND)이 연결되지 않아 동작하지 않습니다.")

    motors = []
    for motor in m.motors:
        spec = motor.pop("_spec")
        drop = motor.pop("_drop")
        supply = v_of(m.net.net_of(motor.pop("_key")))
        voltage = None if supply is None or supply < 0.5 else max(0.0, supply - drop)
        status = "unpowered" if voltage is None else "over" if voltage > spec.max_voltage + 0.01 else "low" if voltage < spec.min_voltage - 0.01 else "ok"
        motors.append({**motor, "voltage": _round(voltage, 2), "status": status})
        if status == "over":
            warnings.append(f"{motor['label']}: 모터 전압 {_round(voltage, 2)} V 가 허용 전압 {spec.max_voltage:g} V 를 넘습니다.")
        elif status == "low":
            warnings.append(f"{motor['label']}: 모터 전압 {_round(voltage, 2)} V 가 최소 동작 전압 {spec.min_voltage:g} V 보다 낮습니다.")
        elif status == "unpowered":
            warnings.append(f"{motor['label']}: 드라이버에 전원이 연결되지 않아 동작하지 않습니다.")

    if not converged:
        warnings.append("다이오드·스위치 상태가 100회 반복 안에 정해지지 않았습니다. 결과가 정확하지 않을 수 있습니다.")
    return {
        "converged": converged,
        "iterations": iterations,
        "options": {
            "gpio": options.gpio,
            "pressed": options.pressed,
            "moduleOutputs": options.module_outputs,
            "servoMoving": options.servo_moving,
            "motorsStalled": options.motors_stalled,
            "includeSeriesResistors": options.include_series_resistors,
        },
        "nets": nets,
        "gpio": gpio_rows,
        "supplies": supplies,
        "leds": leds,
        "loads": loads,
        "motors": motors,
        "warnings": warnings,
        "assumptions": ASSUMPTIONS,
    }
