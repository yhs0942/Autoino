"""Arduino 스케치 자동 생성.

보드마다 하나의 .ino 스케치를 만든다.
- 핀 번호는 배선(연결)에서 가져온다. 레벨 시프터·전압 분배기를 거친 신호도 따라간다.
- 부품별 동작 예시(LED 깜박임, 버튼 읽기, 거리 측정, 서보 스윕, LCD 표시, 모터 구동 등)를 millis() 기반 비차단 방식으로 넣는다.
- 모터는 드라이버 쪽 코드로 제어한다. 드라이버 채널마다 정방향 → 정지 → 역방향 → 정지를 반복한다.
- 보드 간 통신(UART · I²C · SPI)은 양쪽 보드에 송수신 예시 코드를 만든다.
지원하지 않는 조합(예: ESP32 를 SPI 주변장치로 쓰기)은 코드를 만들지 않고 경고로 알린다.
생성된 코드는 예시이며, 실제 부품·라이브러리 버전에 맞게 확인해야 한다.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

from .engine.circuit import Circuit, active_channels, board_label, host_board_of, resolve_board_pin
from .engine.electrical import is_gpio, supply_pin_of
from .engine.netlist import build_netlist
from .engine.paths import route_to_board
from .engine.resistor import compute_series_resistors, format_ohms
from .engine.shares import compute_ladder_resistors, ladder_label, ladder_thresholds, share_board_pin, share_kind
from .engine.validate import count_issues, validate_circuit
from .models import BoardLink, PlacedBoard, PlacedModule

LIBRARY_INFO = {
    "Servo": {"name": "Servo", "install": "Arduino IDE 기본 포함 (라이브러리 관리자: Servo)", "builtIn": True},
    "ESP32Servo": {"name": "ESP32Servo", "install": "라이브러리 관리자에서 'ESP32Servo' (Kevin Harrington) 설치", "builtIn": False},
    "LiquidCrystal_I2C": {"name": "LiquidCrystal_I2C", "install": "라이브러리 관리자에서 'LiquidCrystal I2C' (Frank de Brabander) 설치", "builtIn": False},
    "Wire": {"name": "Wire", "install": "보드 코어에 포함", "builtIn": True},
    "SPI": {"name": "SPI", "install": "보드 코어에 포함", "builtIn": True},
    "SoftwareSerial": {"name": "SoftwareSerial", "install": "AVR 보드 코어에 포함", "builtIn": True},
    "DHT": {"name": "DHT sensor library", "install": "라이브러리 관리자에서 'DHT sensor library' (Adafruit) 설치", "builtIn": False},
    "Adafruit_SSD1306": {"name": "Adafruit SSD1306", "install": "라이브러리 관리자에서 'Adafruit SSD1306' 설치 (Adafruit GFX 함께 설치)", "builtIn": False},
    "Adafruit_NeoPixel": {"name": "Adafruit NeoPixel", "install": "라이브러리 관리자에서 'Adafruit NeoPixel' 설치", "builtIn": False},
    "TM1637Display": {"name": "TM1637", "install": "라이브러리 관리자에서 'TM1637' (Avishay Orpaz) 설치", "builtIn": False},
    "MFRC522": {"name": "MFRC522", "install": "라이브러리 관리자에서 'MFRC522' 설치", "builtIn": False},
    "Adafruit_PWMServoDriver": {"name": "Adafruit PWM Servo Driver Library", "install": "라이브러리 관리자에서 'Adafruit PWM Servo Driver Library' 설치", "builtIn": False},
}

MOTOR_SPEED = 180  # analogWrite 값 (0–255). 모터 예시 속도


@dataclass
class Sketch:
    board_instance_id: str
    board_label: str
    board_name: str
    core: str
    filename: str
    code: str
    libraries: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def dump(self) -> dict:
        d = asdict(self)
        return {
            "boardInstanceId": d["board_instance_id"],
            "boardLabel": d["board_label"],
            "boardName": d["board_name"],
            "core": d["core"],
            "filename": d["filename"],
            "code": d["code"],
            "libraries": d["libraries"],
            "warnings": d["warnings"],
        }


BASE_NAMES = {
    "led-5mm": "led",
    "push-button": "button",
    "hc-sr04": "sonar",
    "sg90": "servo",
    "i2c-lcd-1602": "lcd",
}


def _ident(base: str, label: str, used: set[str]) -> str:
    m = re.search(r"(\d+)$", label)
    n = m.group(1) if m else "1"
    name = f"{base}{n}"
    while name in used:
        name += "_"
    used.add(name)
    return name


def _end_of(link: BoardLink, board_instance_id: str):
    if link.a.board_instance_id == board_instance_id:
        return link.a
    if link.b.board_instance_id == board_instance_id:
        return link.b
    return None


def _uart_port(end) -> str | None:
    if end is None or end.bus == "SoftwareSerial":
        return None
    m = re.match(r"(Serial\d?)", end.bus)
    return m.group(1) if m else None


PRIMARY_PIN = {"led-5mm": "anode", "push-button": "pin2a", "hc-sr04": "trig", "sg90": "signal", "i2c-lcd-1602": "sda"}


def code_board_of(c: Circuit, item: PlacedModule, traced=None) -> str | None:
    """부품 제어 코드를 넣을 보드: 대표 신호 핀이 실제로 배선된 보드, 없으면 소속 보드"""
    pin_id = PRIMARY_PIN.get(item.module_id)
    module = c.module_def(item.module_id)
    if not pin_id and module and module.code and module.code.pins:
        pin_id = next(iter(module.code.pins.values()))
    if not pin_id and module and module.driver:
        pin_id = active_channels(c.connections, item.instance_id, module)[0].inputs[0]
    route = route_to_board(c, item.instance_id, pin_id, traced) if pin_id else None
    if route:
        return route.board_instance_id
    host = host_board_of(c, item)
    return host.instance_id if host else None


def _servo_driver_channel(c: Circuit, item: PlacedModule) -> tuple[PlacedModule, int] | None:
    """서보 신호선이 서보 드라이버(PCA9685) 채널에 연결되어 있으면 (드라이버, 채널 번호)"""
    module = c.module_def(item.module_id)
    signal = next((p.id for p in module.pins if p.role == "signal"), None) if module else None
    if not signal:
        return None
    for conn in c.connections:
        ends = [conn.from_, conn.to]
        mine = [e for e in ends if getattr(e, "instance_id", None) == item.instance_id and e.pin_id == signal]
        other = [e for e in ends if getattr(e, "instance_id", None) and e.instance_id != item.instance_id]
        if not mine or not other:
            continue
        driver = c.placed_module(other[0].instance_id)
        dmod = c.module_def(driver.module_id) if driver else None
        if not dmod or not dmod.driver:
            continue
        for index, ch in enumerate(dmod.driver.channels):
            if other[0].pin_id in ch.outputs and "servo" in ch.accepts:
                return driver, index
    return None


def pin_expr(c: Circuit, board_instance_id: str, pin_id: str) -> str:
    """Arduino 코드에서 쓰는 핀 표기: AVR D5 → 5, A0 → A0 / ESP32 GPIO32 → 32"""
    r = resolve_board_pin(c, board_instance_id, pin_id)
    if r and r.pin and r.pin.gpio is not None:
        return str(r.pin.gpio)
    m = re.fullmatch(r"D(\d+)", pin_id)
    return m.group(1) if m else pin_id


class _Builder:
    def __init__(self) -> None:
        self.includes: list[str] = []
        self.globals: list[str] = []
        self.setup: list[str] = []
        self.loop: list[str] = []
        self.functions: list[str] = []
        self.libraries: list[str] = []
        self.warnings: list[str] = []

    def include(self, header: str, library: str | None = None) -> None:
        line = f"#include <{header}>"
        if line not in self.includes:
            self.includes.append(line)
        if library and library not in self.libraries:
            self.libraries.append(library)


def _module_pin(c: Circuit, traced, item: PlacedModule, pin_id: str, board_id: str) -> str | None:
    route = route_to_board(c, item.instance_id, pin_id, traced)
    if not route or route.board_instance_id != board_id:
        return None
    return route.pin_id


def _sketch_for(c: Circuit, board: PlacedBoard, project_name: str, now: datetime, issue_errors: int) -> Sketch:
    bdef = c.board_def(board.instance_id)
    esp32 = bdef.core == "arduino-esp32"
    traced = build_netlist(c, pass_through=True)
    resistors = {(r["instanceId"], r["pinId"]): r for r in compute_series_resistors(c) if r["status"] == "ok"}
    b = _Builder()
    used_names: set[str] = set()
    pin_rows: list[str] = []
    hosted = sorted((p for p in c.placed if code_board_of(c, p, traced) == board.instance_id), key=lambda p: p.module_id == "i2c-lcd-1602")
    i2c_peripheral = any(l.protocol == "I2C" and l.b.board_instance_id == board.instance_id for l in c.links)
    wire_started = False

    def wire_begin() -> None:
        nonlocal wire_started
        if wire_started:
            return
        wire_started = True
        b.include("Wire.h", "Wire")
        if esp32:
            bus = next((x for x in bdef.buses if x.kind == "I2C"), None)
            pins = {p.role: p.pin_id for p in bus.pins} if bus else {}
            b.setup.append(f"  Wire.begin({pin_expr(c, board.instance_id, pins.get('SDA', ''))}, {pin_expr(c, board.instance_id, pins.get('SCL', ''))});  // SDA, SCL")
        else:
            b.setup.append("  Wire.begin();")

    def need(item: PlacedModule, *pin_ids: str) -> dict[str, str] | None:
        found = {}
        module = c.module_def(item.module_id)
        for pid in pin_ids:
            bp = _module_pin(c, traced, item, pid, board.instance_id)
            if bp is None:
                pin = module.pin(pid)
                b.warnings.append(f"{item.label}: {pin.name if pin else pid} 핀이 이 보드에 연결되지 않아 코드를 생략했습니다.")
                b.globals.append(f"// {item.label}: {pin.name if pin else pid} 핀이 연결되지 않아 코드를 생략했습니다.")
                return None
            rp = resolve_board_pin(c, board.instance_id, bp)
            if not (rp and rp.pin and is_gpio(rp.pin)):
                pin = module.pin(pid)
                if item.module_id == "led-5mm" and rp and rp.pin and supply_pin_of(rp.board, bp):
                    b.globals.append(f"// {item.label}: 애노드가 {bp} 전원 핀에 연결되어 있어 항상 켜져 있습니다 (코드로 제어하지 않음).")
                else:
                    b.warnings.append(f"{item.label}: {pin.name if pin else pid} 핀이 GPIO 가 아닌 {bp} 에 연결되어 있어 코드를 생략했습니다.")
                    b.globals.append(f"// {item.label}: {pin.name if pin else pid} 핀이 GPIO 가 아닌 {bp} 에 연결되어 코드를 생략했습니다.")
                return None
            found[pid] = bp
        return found

    def add_function(marker: str, text: str) -> None:
        """같은 도우미 함수를 한 번만 넣는다"""
        if marker not in "".join(b.functions):
            b.functions.append(text)

    def const(name: str, item: PlacedModule, pin_id: str, board_pin: str, extra: str = "", declare: bool = True) -> str:
        module = c.module_def(item.module_id)
        pin = module.pin(pin_id)
        route = route_to_board(c, item.instance_id, pin_id, traced)
        via = f" ({', '.join(route.via)} 경유)" if route and route.via else ""
        expr = pin_expr(c, board.instance_id, board_pin)
        if declare:
            b.globals.append(f"const uint8_t {name} = {expr};  // {item.label} · {pin.name} → {board_pin}{via}{extra}")
        pin_rows.append(f" *   {item.label} · {pin.name} → {board_pin}{via}{extra}")
        return name

    # ---------- 핀 공유 그룹 ----------
    # 같은 보드 핀을 함께 쓰는 부품은 첫 부품의 코드가 그 핀을 다루고, 나머지는 설명만 남긴다.
    # 저항 사다리는 첫 버튼 자리에서 analogRead 로 눌린 버튼을 구분하는 코드를 만든다.
    shared: dict[str, dict] = {}
    ladder = compute_ladder_resistors(c)
    for share in c.shares:
        target = share_board_pin(c, share)
        if not target or target[0] != board.instance_id:
            continue
        on = [k for k in share.members if _module_pin(c, traced, c.placed_module(k.split(":")[1]), k.rsplit(":", 1)[1], board.instance_id) == target[1]] if all(c.placed_module(k.split(":")[1]) for k in share.members) else []
        rp = resolve_board_pin(c, target[0], target[1])
        kind = share_kind(c, on, rp.board if rp else None, rp.pin if rp else None)
        if not kind:
            continue
        labels = ", ".join(c.placed_module(k.split(":")[1]).label for k in on)
        for k in on:
            shared[k] = {"kind": kind, "first": on[0], "members": on, "pin": target[1], "labels": labels}

    def share_note(item: PlacedModule, pin_id: str) -> dict | None:
        return shared.get(f"module:{item.instance_id}:{pin_id}")

    for item in hosted:
        module = c.module_def(item.module_id)
        signal = next((p.id for p in module.pins if p.role == "signal"), None)
        group = share_note(item, signal) if signal else None
        if group and group["first"] != f"module:{item.instance_id}:{signal}":
            first = c.placed_module(group["first"].split(":")[1])
            how = {"output": "같이 켜지고 꺼집니다", "input": "어느 쪽을 눌러도 같이 읽힙니다", "ladder": "저항 사다리 코드에서 함께 읽습니다"}[group["kind"]]
            b.globals.append(f"// {item.label}: {first.label} 와(과) 같은 핀({group['pin']})을 함께 씁니다 (핀 공유) — {how}.")
            if group["kind"] != "ladder":  # 사다리는 첫 버튼 자리에서 저항값과 함께 적는다
                pin_rows.append(f" *   {item.label} · {module.pin(signal).name} → {group['pin']} (핀 공유)")
            continue
        if group:
            b.globals.append(f"// 핀 공유: {group['labels']} 이(가) {group['pin']} 을(를) 함께 씁니다.")
        if group and group["kind"] == "ladder":
            rungs = [r for r in ladder if r["boardInstanceId"] == board.instance_id and r["boardPinId"] == group["pin"]]
            names = [_ident("button", c.placed_module(r["instanceId"]).label, used_names) for r in rungs]
            lname = _ident("ladder", group["pin"], used_names)
            upper = lname.upper()
            p = const(f"{upper}_PIN", item, signal, group["pin"], f" — 버튼 {len(rungs)}개 저항 사다리 ({ladder_label(c, rungs)})")
            for r in rungs[1:]:
                other = c.placed_module(r["instanceId"])
                pin_rows.append(f" *   {other.label} · {c.module_def(other.module_id).pin(r['pinId']).name} → {group['pin']} (사다리 저항 {format_ohms(r['ohms'])})")
            limits = ", ".join(str(v) for v in ladder_thresholds(len(rungs)))
            b.globals.append(f"const int {upper}_LIMITS[] = {{{limits}}};  // analogRead 경계: 이 값보다 작으면 그 순서의 버튼")
            b.globals.append(f"const char* const {upper}_NAMES[] = {{{', '.join(f'"{n}"' for n in names)}}};")
            b.globals.append(f"int {lname}Last = -1;")
            b.globals.append(f"unsigned long timer_{lname} = 0;")
            b.setup.append(f"  pinMode({p}, INPUT_PULLUP);  // 내부 풀업(20–50 kΩ)이 사다리의 위쪽 저항 역할을 합니다")
            b.loop.append(f"  // 버튼 사다리 {group['pin']}: 20 ms 마다 읽어 눌린 버튼을 알려 줌 (한 번에 하나만 누르세요)")
            b.loop.append(f"  if (every(timer_{lname}, 20)) {{")
            b.loop.append(f"    int v = analogRead({p});")
            b.loop.append("    int pressed = -1;")
            b.loop.append(f"    for (int i = 0; i < {len(rungs)}; i++) if (v < {upper}_LIMITS[i]) {{ pressed = i; break; }}")
            b.loop.append(f"    if (pressed != {lname}Last) {{")
            b.loop.append(f"      {lname}Last = pressed;")
            b.loop.append(f'      if (pressed < 0) Serial.println("{lname}: released");')
            b.loop.append(f'      else {{ Serial.print({upper}_NAMES[pressed]); Serial.println(": pressed"); }}')
            b.loop.append("    }")
            b.loop.append("  }")
            continue
        spec = module.code
        template = spec.template if spec else None
        base = BASE_NAMES.get(item.module_id) or (spec.base if spec else None)
        if base is None:
            reason = "모터 드라이버 코드에서 제어합니다" if module.motor else "전원 부품이라 별도 코드가 필요 없습니다" if module.category == "power" else "신호 변환 부품이라 별도 코드가 필요 없습니다"
            b.globals.append(f"// {item.label}: {reason}.")
            continue
        name = _ident(base, item.label, used_names)
        upper = name.upper()

        def role_pins(*roles: str) -> dict[str, str] | None:
            """코드 역할 → 보드 핀. 연결되지 않은 핀이 있으면 None"""
            ids = [spec.pins[r] for r in roles]
            found = need(item, *ids)
            return {r: found[spec.pins[r]] for r in roles} if found else None

        if item.module_id == "led-5mm":
            pins = need(item, "anode")
            if not pins:
                continue
            r = resistors.get((item.instance_id, "anode"))
            p = const(f"{upper}_PIN", item, "anode", pins["anode"], f" — 직렬 저항 {format_ohms(r['choice']['standardOhms'])}" if r else "")
            b.globals.append(f"bool {name}State = false;")
            b.setup.append(f"  pinMode({p}, OUTPUT);")
            b.loop.append(f"  // {item.label}: 0.5초마다 깜박임")
            b.loop.append(f"  if (every(timer_{name}, 500)) {{ {name}State = !{name}State; digitalWrite({p}, {name}State ? HIGH : LOW); }}")
            b.globals.append(f"unsigned long timer_{name} = 0;")
        elif item.module_id == "push-button":
            pins = need(item, "pin2a")
            if not pins:
                continue
            p = const(f"{upper}_PIN", item, "pin2a", pins["pin2a"], " — 누르면 LOW")
            rp = resolve_board_pin(c, board.instance_id, pins["pin2a"])
            no_pull = bool(rp and rp.pin and any(x.kind == "no-internal-pull" for x in rp.pin.restrictions or []))
            if no_pull:
                b.setup.append(f"  pinMode({p}, INPUT);  // 이 핀은 내부 풀업이 없습니다: 외부 10 kΩ 풀업 저항이 필요합니다")
                b.warnings.append(f"{item.label}: {pins['pin2a']} 는 내부 풀업이 없어 외부 풀업 저항이 필요합니다.")
            else:
                b.setup.append(f"  pinMode({p}, INPUT_PULLUP);")
            b.globals.append(f"bool {name}Last = HIGH;")
            b.globals.append(f"unsigned long timer_{name} = 0;")
            b.loop.append(f"  // {item.label}: 20 ms 간격으로 읽어 눌림을 감지 (간단한 디바운스)")
            b.loop.append(f"  if (every(timer_{name}, 20)) {{")
            b.loop.append(f"    bool now = digitalRead({p});")
            b.loop.append(f"    if (now != {name}Last) {{ {name}Last = now; Serial.println(now == LOW ? \"{name}: pressed\" : \"{name}: released\"); }}")
            b.loop.append("  }")
        elif item.module_id == "hc-sr04":
            pins = need(item, "trig", "echo")
            if not pins:
                continue
            t = const(f"{upper}_TRIG", item, "trig", pins["trig"])
            e = const(f"{upper}_ECHO", item, "echo", pins["echo"])
            b.setup.append(f"  pinMode({t}, OUTPUT);")
            b.setup.append(f"  pinMode({e}, INPUT);")
            b.globals.append(f"unsigned long timer_{name} = 0;")
            b.globals.append(f"float {name}Cm = -1;")
            if "readDistanceCm" not in "".join(b.functions):
                b.functions.append(
                    "// HC-SR04 거리 측정 (cm). 응답이 없으면 -1\n"
                    "float readDistanceCm(uint8_t trigPin, uint8_t echoPin) {\n"
                    "  digitalWrite(trigPin, LOW);\n"
                    "  delayMicroseconds(2);\n"
                    "  digitalWrite(trigPin, HIGH);\n"
                    "  delayMicroseconds(10);\n"
                    "  digitalWrite(trigPin, LOW);\n"
                    "  unsigned long us = pulseIn(echoPin, HIGH, 30000UL);  // 최대 약 5 m\n"
                    "  return us == 0 ? -1.0f : us / 58.0f;\n"
                    "}\n"
                )
            b.loop.append(f"  // {item.label}: 0.2초마다 거리 측정")
            b.loop.append(f"  if (every(timer_{name}, 200)) {{ {name}Cm = readDistanceCm({t}, {e}); Serial.print(\"{name} cm: \"); Serial.println({name}Cm); }}")
        elif template in ("servo", "servo-continuous") and _servo_driver_channel(c, item):
            driver, index = _servo_driver_channel(c, item)
            b.globals.append(f"// {item.label}: {driver.label} 의 채널 {index} 에서 제어합니다 (아래 서보 드라이버 코드).")
        elif template == "pca9685":
            pins = role_pins("sda", "scl")
            if not pins:
                continue
            if i2c_peripheral:
                b.warnings.append(f"{item.label}: 이 보드는 I²C 주변장치로 설정되어 있어 직접 제어하는 코드를 만들지 않았습니다.")
                b.globals.append(f"// {item.label}: 이 보드가 I²C 주변장치라 제어 코드를 생략했습니다.")
                continue
            const(f"{upper}_SDA", item, spec.pins["sda"], pins["sda"], " (I²C SDA, Wire 가 사용)", declare=False)
            const(f"{upper}_SCL", item, spec.pins["scl"], pins["scl"], " (I²C SCL, Wire 가 사용)", declare=False)
            wire_begin()
            b.include("Adafruit_PWMServoDriver.h", "Adafruit_PWMServoDriver")
            address = module.i2c_address or "0x40"
            b.globals.append(f"Adafruit_PWMServoDriver {name}({address});  // {item.label} (I²C {address})")
            b.setup.append(f"  {name}.begin();")
            b.setup.append(f"  {name}.setOscillatorFrequency(27000000);")
            b.setup.append(f"  {name}.setPWMFreq(50);  // 서보 펄스 주기 50 Hz (20 ms)")
            attached = []
            for other in c.placed:
                found = _servo_driver_channel(c, other)
                if found and found[0].instance_id == item.instance_id:
                    attached.append((found[1], other))
            attached.sort(key=lambda x: x[0])
            if not attached:
                b.globals.append(f"// {item.label}: 아직 연결된 서보가 없습니다. 서보 카드를 이 드라이버 카드에 끌어다 놓으세요.")
            for index, servo in attached:
                sname = _ident("servo", servo.label, used_names)
                smod = c.module_def(servo.module_id)
                pin_rows.append(f" *   {servo.label} · 신호 → {item.label} 채널 {index}")
                b.globals.append(f"unsigned long timer_{sname} = 0;")
                if smod.code and smod.code.template == "servo-continuous":
                    b.globals.append(f"uint8_t {sname}State = 0;")
                    b.setup.append(f"  {name}.writeMicroseconds({index}, 1500);  // {servo.label}: 정지")
                    b.loop.append(f"  // {servo.label} (채널 {index}): 정방향 → 정지 → 역방향 → 정지 (2초 간격)")
                    b.loop.append(f"  if (every(timer_{sname}, 2000)) {{")
                    b.loop.append(f"    {sname}State = ({sname}State + 1) % 4;")
                    b.loop.append(f"    {name}.writeMicroseconds({index}, {sname}State == 1 ? 1700 : {sname}State == 3 ? 1300 : 1500);")
                    b.loop.append("  }")
                else:
                    b.globals.append(f"int {sname}Angle = 0, {sname}Step = 2;")
                    b.loop.append(f"  // {servo.label} (채널 {index}): 0°–180° 왕복 (펄스 500–2500 µs)")
                    b.loop.append(f"  if (every(timer_{sname}, 20)) {{")
                    b.loop.append(f"    {sname}Angle += {sname}Step;")
                    b.loop.append(f"    if ({sname}Angle <= 0 || {sname}Angle >= 180) {sname}Step = -{sname}Step;")
                    b.loop.append(f"    {name}.writeMicroseconds({index}, map({sname}Angle, 0, 180, 500, 2500));")
                    b.loop.append("  }")
        elif template in ("servo", "servo-continuous", "esc"):
            pins = role_pins("signal")
            if not pins:
                continue
            lib = module.library_for(bdef.core) or "Servo"
            b.include("ESP32Servo.h" if lib == "ESP32Servo" else "Servo.h", lib)
            p = const(f"{upper}_PIN", item, spec.pins["signal"], pins["signal"])
            b.globals.append(f"Servo {name};")
            b.globals.append(f"unsigned long timer_{name} = 0;")
            if template == "esc":
                b.globals.append(f"int {name}Throttle = 1000;  // 1000 = 정지, 2000 = 최대. 프로펠러를 뺀 상태에서 조금씩 올리세요")
                b.setup.append(f"  {name}.attach({p}, 1000, 2000);")
                b.setup.append(f"  {name}.writeMicroseconds(1000);  // 시동: 스로틀 최소 신호")
                b.loop.append(f"  // {item.label}: 스로틀 신호 유지 (예시는 정지 상태로 둡니다)")
                b.loop.append(f"  if (every(timer_{name}, 20)) {name}.writeMicroseconds({name}Throttle);")
            elif template == "servo-continuous":
                b.globals.append(f"uint8_t {name}State = 0;")
                b.setup.append(f"  {name}.attach({p});")
                b.setup.append(f"  {name}.write(90);  // 정지")
                b.loop.append(f"  // {item.label}: 정방향 → 정지 → 역방향 → 정지 (2초 간격)")
                b.loop.append(f"  if (every(timer_{name}, 2000)) {{")
                b.loop.append(f"    {name}State = ({name}State + 1) % 4;")
                b.loop.append(f"    {name}.write({name}State == 1 ? 120 : {name}State == 3 ? 60 : 90);")
                b.loop.append("  }")
            else:
                b.globals.append(f"int {name}Angle = 0, {name}Step = 2;")
                b.setup.append(f"  {name}.attach({p});")
                b.loop.append(f"  // {item.label}: 0°–180° 왕복")
                b.loop.append(f"  if (every(timer_{name}, 20)) {{")
                b.loop.append(f"    {name}Angle += {name}Step;")
                b.loop.append(f"    if ({name}Angle <= 0 || {name}Angle >= 180) {name}Step = -{name}Step;")
                b.loop.append(f"    {name}.write({name}Angle);")
                b.loop.append("  }")
        elif template == "h-bridge":
            standby = spec.standby_pin
            if standby:
                pins = need(item, standby)
                if not pins:
                    continue
                s = const(f"{upper}_STBY", item, standby, pins[standby])
                b.setup.append(f"  pinMode({s}, OUTPUT);")
                b.setup.append(f"  digitalWrite({s}, HIGH);  // 대기 해제")
            for channel in active_channels(c.connections, item.instance_id, module):
                pins = need(item, *channel.inputs)
                if not pins:
                    continue
                tag = f"{name}{channel.id}"
                names = []
                suffixes = ("EN", "IN1", "IN2") if spec.scheme == "en-in1-in2" else ("IN1", "IN2")
                for pin_id, suffix in zip(channel.inputs, suffixes):
                    names.append(const(f"{tag.upper()}_{suffix}", item, pin_id, pins[pin_id]))
                    b.setup.append(f"  pinMode({names[-1]}, OUTPUT);")
                    rp = resolve_board_pin(c, board.instance_id, pins[pin_id])
                    if suffix == "EN" and not (rp and rp.pin and "pwm" in rp.pin.capabilities):
                        b.warnings.append(f"{item.label} {channel.label}: {pins[pin_id]} 는 PWM 핀이 아니라 속도를 조절할 수 없습니다.")
                b.globals.append(f"unsigned long timer_{tag} = 0;")
                b.globals.append(f"uint8_t state_{tag} = 0;")
                speed = f"state_{tag} == 1 ? {MOTOR_SPEED} : state_{tag} == 3 ? -{MOTOR_SPEED} : 0"
                if spec.scheme == "en-in1-in2":
                    add_function(
                        "void driveMotor(",
                        "// H 브리지 모터 구동: speed -255(역방향) … 255(정방향)\n"
                        "void driveMotor(uint8_t in1, uint8_t in2, uint8_t en, int speed) {\n"
                        "  digitalWrite(in1, speed > 0 ? HIGH : LOW);\n"
                        "  digitalWrite(in2, speed < 0 ? HIGH : LOW);\n"
                        "  analogWrite(en, speed < 0 ? -speed : speed);\n"
                        "}\n",
                    )
                    call = f"driveMotor({names[1]}, {names[2]}, {names[0]}, {speed});"
                else:
                    add_function(
                        "void driveMotor2(",
                        "// 입력 두 개로 구동하는 드라이버: 한쪽 입력의 PWM 이 속도를 정한다\n"
                        "void driveMotor2(uint8_t in1, uint8_t in2, int speed) {\n"
                        "  analogWrite(in1, speed > 0 ? speed : 0);\n"
                        "  analogWrite(in2, speed < 0 ? -speed : 0);\n"
                        "}\n",
                    )
                    call = f"driveMotor2({names[0]}, {names[1]}, {speed});"
                b.loop.append(f"  // {item.label} {channel.label}: 정방향 → 정지 → 역방향 → 정지 (2초 간격)")
                b.loop.append(f"  if (every(timer_{tag}, 2000)) {{")
                b.loop.append(f"    state_{tag} = (state_{tag} + 1) % 4;")
                b.loop.append(f"    {call}")
                b.loop.append("  }")
        elif template == "stepper-coils":
            channel = module.driver.channels[0]
            pins = need(item, *channel.inputs)
            if not pins:
                continue
            names = [const(f"{upper}_IN{i + 1}", item, pin_id, pins[pin_id]) for i, pin_id in enumerate(channel.inputs)]
            b.globals.append(f"const uint8_t {name}Pins[4] = {{{', '.join(names)}}};")
            b.globals.append(f"unsigned long timer_{name} = 0;")
            b.globals.append(f"uint8_t phase_{name} = 0;")
            b.setup.append(f"  for (uint8_t i = 0; i < 4; i++) pinMode({name}Pins[i], OUTPUT);")
            add_function(
                "void stepCoils(",
                "// 유니폴라 스테퍼 풀스텝: 코일 두 개씩 차례로 켠다\n"
                "void stepCoils(const uint8_t *pins, uint8_t &phase) {\n"
                "  phase = (phase + 1) & 3;\n"
                "  for (uint8_t i = 0; i < 4; i++) digitalWrite(pins[i], (i == phase || i == ((phase + 1) & 3)) ? HIGH : LOW);\n"
                "}\n",
            )
            b.loop.append(f"  // {item.label}: 3 ms 마다 한 스텝")
            b.loop.append(f"  if (every(timer_{name}, 3)) stepCoils({name}Pins, phase_{name});")
        elif template == "step-dir":
            pins = role_pins("step", "dir")
            if not pins:
                continue
            step = const(f"{upper}_STEP", item, spec.pins["step"], pins["step"])
            direction = const(f"{upper}_DIR", item, spec.pins["dir"], pins["dir"])
            b.globals.append(f"unsigned long timer_{name} = 0;")
            b.globals.append(f"unsigned int count_{name} = 0;")
            b.globals.append(f"bool forward_{name} = true;")
            b.setup.append(f"  pinMode({step}, OUTPUT);")
            b.setup.append(f"  pinMode({direction}, OUTPUT);")
            b.loop.append(f"  // {item.label}: 200 스텝마다 방향 전환 (풀스텝이면 한 바퀴)")
            b.loop.append(f"  if (every(timer_{name}, 2)) {{")
            b.loop.append(f"    digitalWrite({direction}, forward_{name} ? HIGH : LOW);")
            b.loop.append(f"    digitalWrite({step}, HIGH);")
            b.loop.append("    delayMicroseconds(5);")
            b.loop.append(f"    digitalWrite({step}, LOW);")
            b.loop.append(f"    if (++count_{name} >= 200) {{ count_{name} = 0; forward_{name} = !forward_{name}; }}")
            b.loop.append("  }")
        elif template == "digital-read":
            pins = role_pins("value")
            if not pins:
                continue
            p = const(f"{upper}_PIN", item, spec.pins["value"], pins["value"])
            b.setup.append(f"  pinMode({p}, INPUT);")
            b.globals.append(f"bool {name}Last = LOW;")
            b.globals.append(f"unsigned long timer_{name} = 0;")
            b.loop.append(f"  // {item.label}: 값이 바뀌면 출력")
            b.loop.append(f"  if (every(timer_{name}, 50)) {{")
            b.loop.append(f"    bool now = digitalRead({p});")
            b.loop.append(f'    if (now != {name}Last) {{ {name}Last = now; Serial.print("{name}: "); Serial.println(now == HIGH ? "HIGH" : "LOW"); }}')
            b.loop.append("  }")
        elif template == "analog-read":
            pins = role_pins("value")
            if not pins:
                continue
            p = const(f"{upper}_PIN", item, spec.pins["value"], pins["value"])
            b.globals.append(f"unsigned long timer_{name} = 0;")
            b.loop.append(f"  // {item.label}: 0.5초마다 아날로그 값 출력")
            b.loop.append(f'  if (every(timer_{name}, 500)) {{ Serial.print("{name}: "); Serial.println(analogRead({p})); }}')
        elif template == "digital-write":
            pins = role_pins("value")
            if not pins:
                continue
            p = const(f"{upper}_PIN", item, spec.pins["value"], pins["value"], " — LOW 에서 켜짐" if spec.active_low else "")
            on, off = ("LOW", "HIGH") if spec.active_low else ("HIGH", "LOW")
            b.setup.append(f"  pinMode({p}, OUTPUT);")
            b.setup.append(f"  digitalWrite({p}, {off});")
            b.globals.append(f"bool {name}On = false;")
            b.globals.append(f"unsigned long timer_{name} = 0;")
            b.loop.append(f"  // {item.label}: 1초마다 켜기·끄기")
            b.loop.append(f"  if (every(timer_{name}, 1000)) {{ {name}On = !{name}On; digitalWrite({p}, {name}On ? {on} : {off}); }}")
        elif template == "joystick":
            pins = role_pins("x", "y", "button")
            if not pins:
                continue
            x = const(f"{upper}_X", item, spec.pins["x"], pins["x"])
            y = const(f"{upper}_Y", item, spec.pins["y"], pins["y"])
            sw = const(f"{upper}_SW", item, spec.pins["button"], pins["button"], " — 누르면 LOW")
            b.setup.append(f"  pinMode({sw}, INPUT_PULLUP);")
            b.globals.append(f"unsigned long timer_{name} = 0;")
            b.loop.append(f"  // {item.label}: 0.2초마다 축 값과 버튼 출력")
            b.loop.append(f"  if (every(timer_{name}, 200)) {{")
            b.loop.append(f'    Serial.print("{name} x="); Serial.print(analogRead({x}));')
            b.loop.append(f'    Serial.print(" y="); Serial.print(analogRead({y}));')
            b.loop.append(f'    Serial.print(" sw="); Serial.println(digitalRead({sw}) == LOW ? "down" : "up");')
            b.loop.append("  }")
        elif template == "encoder":
            pins = role_pins("a", "b", "button")
            if not pins:
                continue
            a = const(f"{upper}_CLK", item, spec.pins["a"], pins["a"])
            d = const(f"{upper}_DT", item, spec.pins["b"], pins["b"])
            sw = const(f"{upper}_SW", item, spec.pins["button"], pins["button"], " — 누르면 LOW")
            b.setup.append(f"  pinMode({a}, INPUT);")
            b.setup.append(f"  pinMode({d}, INPUT);")
            b.setup.append(f"  pinMode({sw}, INPUT_PULLUP);")
            b.setup.append(f"  {name}Last = digitalRead({a});")
            b.globals.append(f"int {name}Last = HIGH;")
            b.globals.append(f"long {name}Value = 0;")
            b.loop.append(f"  // {item.label}: CLK 가 바뀔 때 DT 로 방향을 판단")
            b.loop.append(f"  {{ int now = digitalRead({a});")
            b.loop.append(f"    if (now != {name}Last) {{")
            b.loop.append(f"      {name}Last = now;")
            b.loop.append(f"      if (now == LOW) {{ {name}Value += digitalRead({d}) != now ? 1 : -1; Serial.print(\"{name}: \"); Serial.println({name}Value); }}")
            b.loop.append("    }")
            b.loop.append("  }")
        elif template == "dht":
            pins = role_pins("data")
            if not pins:
                continue
            b.include("DHT.h", "DHT")
            p = const(f"{upper}_PIN", item, spec.pins["data"], pins["data"])
            kind = item.params.get("model", "DHT11")
            b.globals.append(f"DHT {name}({p}, {kind});")
            b.globals.append(f"unsigned long timer_{name} = 0;")
            b.setup.append(f"  {name}.begin();")
            b.loop.append(f"  // {item.label}: 2초마다 온도·습도 출력")
            b.loop.append(f"  if (every(timer_{name}, 2000)) {{")
            b.loop.append(f'    Serial.print("{name} C="); Serial.print({name}.readTemperature());')
            b.loop.append(f'    Serial.print(" %="); Serial.println({name}.readHumidity());')
            b.loop.append("  }")
        elif template == "neopixel":
            pins = role_pins("data")
            if not pins:
                continue
            b.include("Adafruit_NeoPixel.h", "Adafruit_NeoPixel")
            p = const(f"{upper}_PIN", item, spec.pins["data"], pins["data"])
            count = item.params.get("count", "8")
            b.globals.append(f"Adafruit_NeoPixel {name}({count}, {p}, NEO_GRB + NEO_KHZ800);")
            b.globals.append(f"unsigned long timer_{name} = 0;")
            b.globals.append(f"uint16_t index_{name} = 0;")
            b.setup.append(f"  {name}.begin();")
            b.setup.append(f"  {name}.setBrightness(40);  // 밝기를 낮춰 전류를 줄인다")
            b.loop.append(f"  // {item.label}: 파란 점 하나가 흐른다")
            b.loop.append(f"  if (every(timer_{name}, 100)) {{")
            b.loop.append(f"    {name}.clear();")
            b.loop.append(f"    {name}.setPixelColor(index_{name}, {name}.Color(0, 0, 255));")
            b.loop.append(f"    {name}.show();")
            b.loop.append(f"    index_{name} = (index_{name} + 1) % {count};")
            b.loop.append("  }")
        elif template == "tm1637":
            pins = role_pins("clk", "dio")
            if not pins:
                continue
            b.include("TM1637Display.h", "TM1637Display")
            clk = const(f"{upper}_CLK", item, spec.pins["clk"], pins["clk"])
            dio = const(f"{upper}_DIO", item, spec.pins["dio"], pins["dio"])
            b.globals.append(f"TM1637Display {name}({clk}, {dio});")
            b.globals.append(f"unsigned long timer_{name} = 0;")
            b.setup.append(f"  {name}.setBrightness(3);")
            b.loop.append(f"  // {item.label}: 1초마다 경과 시간 표시")
            b.loop.append(f"  if (every(timer_{name}, 1000)) {name}.showNumberDec((millis() / 1000) % 10000);")
        elif template in ("ssd1306", "mpu6050"):
            pins = role_pins("sda", "scl")
            if not pins:
                continue
            if i2c_peripheral:
                b.warnings.append(f"{item.label}: 이 보드는 I²C 주변장치로 설정되어 있어 직접 제어하는 코드를 만들지 않았습니다.")
                b.globals.append(f"// {item.label}: 이 보드가 I²C 주변장치라 제어 코드를 생략했습니다.")
                continue
            const(f"{upper}_SDA", item, spec.pins["sda"], pins["sda"], " (I²C SDA, Wire 가 사용)", declare=False)
            const(f"{upper}_SCL", item, spec.pins["scl"], pins["scl"], " (I²C SCL, Wire 가 사용)", declare=False)
            wire_begin()
            address = module.i2c_address or "0x3C"
            b.globals.append(f"unsigned long timer_{name} = 0;")
            if template == "ssd1306":
                b.include("Adafruit_GFX.h")
                b.include("Adafruit_SSD1306.h", "Adafruit_SSD1306")
                b.globals.append(f"Adafruit_SSD1306 {name}(128, 64, &Wire, -1);")
                b.setup.append(f'  if (!{name}.begin(SSD1306_SWITCHCAPVCC, {address})) Serial.println("{name}: not found");')
                b.loop.append(f"  // {item.label}: 0.5초마다 경과 시간 표시")
                b.loop.append(f"  if (every(timer_{name}, 500)) {{")
                b.loop.append(f"    {name}.clearDisplay();")
                b.loop.append(f"    {name}.setTextSize(2);")
                b.loop.append(f"    {name}.setTextColor(SSD1306_WHITE);")
                b.loop.append(f"    {name}.setCursor(0, 0);")
                b.loop.append(f'    {name}.println("Autoino");')
                b.loop.append(f"    {name}.println(millis() / 1000);")
                b.loop.append(f"    {name}.display();")
                b.loop.append("  }")
            else:
                b.globals.append(f"const uint8_t {upper}_ADDRESS = {address};")
                b.setup.append(f"  Wire.beginTransmission({upper}_ADDRESS);")
                b.setup.append("  Wire.write(0x6B);  // PWR_MGMT_1")
                b.setup.append("  Wire.write(0);     // 절전 해제")
                b.setup.append("  Wire.endTransmission();")
                add_function(
                    "int readImuWord(",
                    "// MPU-6050 레지스터에서 16비트 값 읽기\n"
                    "int readImuWord(uint8_t address, uint8_t reg) {\n"
                    "  Wire.beginTransmission(address);\n"
                    "  Wire.write(reg);\n"
                    "  Wire.endTransmission(false);\n"
                    "  Wire.requestFrom(address, (uint8_t)2);\n"
                    "  int high = Wire.read();\n"
                    "  return (high << 8) | Wire.read();\n"
                    "}\n",
                )
                b.loop.append(f"  // {item.label}: 0.2초마다 가속도 X·Y·Z 출력")
                b.loop.append(f"  if (every(timer_{name}, 200)) {{")
                b.loop.append(f'    Serial.print("{name} ax="); Serial.print(readImuWord({upper}_ADDRESS, 0x3B));')
                b.loop.append(f'    Serial.print(" ay="); Serial.print(readImuWord({upper}_ADDRESS, 0x3D));')
                b.loop.append(f'    Serial.print(" az="); Serial.println(readImuWord({upper}_ADDRESS, 0x3F));')
                b.loop.append("  }")
        elif template == "serial-module":
            pins = role_pins("rx", "tx")
            if not pins:
                continue
            rx = const(f"{upper}_RX", item, spec.pins["rx"], pins["rx"], " (보드 입력)")
            tx = const(f"{upper}_TX", item, spec.pins["tx"], pins["tx"], " (보드 출력)")
            if esp32:
                port = "Serial2"
                b.setup.append(f"  {port}.begin(9600, SERIAL_8N1, {rx}, {tx});")
            else:
                port = name
                b.include("SoftwareSerial.h", "SoftwareSerial")
                b.globals.append(f"SoftwareSerial {name}({rx}, {tx});")
                b.setup.append(f"  {name}.begin(9600);")
            b.globals.append(f"unsigned long timer_{name} = 0;")
            b.loop.append(f"  // {item.label}: 받은 데이터를 시리얼 모니터로 출력하고 2초마다 인사")
            b.loop.append(f"  while ({port}.available()) Serial.write({port}.read());")
            b.loop.append(f'  if (every(timer_{name}, 2000)) {port}.println("hello from Autoino");')
        elif template == "rc522":
            pins = role_pins("ss", "rst", "sck", "mosi", "miso")
            if not pins:
                continue
            b.include("SPI.h", "SPI")
            b.include("MFRC522.h", "MFRC522")
            ss = const(f"{upper}_SS", item, spec.pins["ss"], pins["ss"])
            rst = const(f"{upper}_RST", item, spec.pins["rst"], pins["rst"])
            sck = const(f"{upper}_SCK", item, spec.pins["sck"], pins["sck"], declare=esp32)
            mosi = const(f"{upper}_MOSI", item, spec.pins["mosi"], pins["mosi"], declare=esp32)
            miso = const(f"{upper}_MISO", item, spec.pins["miso"], pins["miso"], declare=esp32)
            b.globals.append(f"MFRC522 {name}({ss}, {rst});")
            b.globals.append(f"unsigned long timer_{name} = 0;")
            b.setup.append(f"  SPI.begin({sck}, {miso}, {mosi}, {ss});" if esp32 else "  SPI.begin();")
            b.setup.append(f"  {name}.PCD_Init();")
            b.loop.append(f"  // {item.label}: 카드가 닿으면 UID 출력")
            b.loop.append(f"  if (every(timer_{name}, 200) && {name}.PICC_IsNewCardPresent() && {name}.PICC_ReadCardSerial()) {{")
            b.loop.append(f'    Serial.print("{name} UID:");')
            b.loop.append(f"    for (byte i = 0; i < {name}.uid.size; i++) {{ Serial.print(' '); Serial.print({name}.uid.uidByte[i], HEX); }}")
            b.loop.append("    Serial.println();")
            b.loop.append(f"    {name}.PICC_HaltA();")
            b.loop.append("  }")
        elif item.module_id == "i2c-lcd-1602":
            pins = need(item, "sda", "scl")
            if not pins:
                continue
            if i2c_peripheral:
                b.warnings.append(f"{item.label}: 이 보드는 I²C 주변장치로 설정되어 있어 LCD 를 직접 제어하는 코드를 만들지 않았습니다.")
                b.globals.append(f"// {item.label}: 이 보드가 I²C 주변장치라 LCD 제어 코드를 생략했습니다.")
                continue
            const(f"{upper}_SDA", item, "sda", pins["sda"], " (I²C SDA, Wire 가 사용)", declare=False)
            const(f"{upper}_SCL", item, "scl", pins["scl"], " (I²C SCL, Wire 가 사용)", declare=False)
            wire_begin()
            b.include("LiquidCrystal_I2C.h", "LiquidCrystal_I2C")
            address = module.i2c_address or "0x27"
            b.globals.append(f"LiquidCrystal_I2C {name}({address}, 16, 2);  // 주소는 제품에 따라 0x27 또는 0x3F")
            b.globals.append(f"unsigned long timer_{name} = 0;")
            b.setup.append(f"  {name}.init();")
            b.setup.append(f"  {name}.backlight();")
            b.setup.append(f"  {name}.setCursor(0, 0);")
            b.setup.append(f'  {name}.print("Autoino");')
            sonar = next((n for n in sorted(used_names) if n.startswith("sonar")), None)
            b.loop.append(f"  // {item.label}: 0.5초마다 두 번째 줄 갱신")
            b.loop.append(f"  if (every(timer_{name}, 500)) {{")
            b.loop.append(f"    {name}.setCursor(0, 1);")
            if sonar:
                b.loop.append(f'    {name}.print("dist "); {name}.print({sonar}Cm, 1); {name}.print(" cm   ");')
            else:
                b.loop.append(f'    {name}.print("up "); {name}.print(millis() / 1000); {name}.print(" s   ");')
            b.loop.append("  }")

    # ---------- 보드 간 통신 ----------
    for link in c.links:
        if board.instance_id not in (link.a.board_instance_id, link.b.board_instance_id):
            continue
        _link_code(c, b, board, link, esp32, wire_begin)

    debug_baud = 115200
    shared = next((l for l in c.links if l.protocol == "UART" and _uart_port(_end_of(l, board.instance_id)) == "Serial"), None)
    if shared:
        debug_baud = shared.baud or 9600
        b.warnings.append(
            f"{shared.id}: 보드 간 UART 가 USB 시리얼(Serial)을 함께 씁니다. 시리얼 모니터 출력이 상대 보드로도 전달되고, 업로드할 때는 연결을 잠시 빼야 합니다."
        )
    libraries = [LIBRARY_INFO[name] for name in b.libraries]
    label = board_label(c, board.instance_id) if len(c.boards) > 1 else "보드"
    filename = re.sub(r"[^0-9A-Za-z_]+", "_", f"autoino_{board.instance_id}").strip("_") + ".ino"
    header = [
        "/*",
        " * Autoino 자동 생성 스케치",
        f" * 프로젝트 : {project_name}",
        f" * 보드     : {board.label} · {bdef.name} ({'arduino-esp32' if esp32 else 'arduino-avr'} 코어)",
        f" * 생성 시각: {now.isoformat(timespec='seconds')}",
        " *",
        " * 핀 배정 (Autoino 배선 기준)",
        *(pin_rows or [" *   (이 보드에 연결된 부품 없음)"]),
        " *",
        " * 필요한 라이브러리",
        *([f" *   - {lib['name']}: {lib['install']}" for lib in libraries] or [" *   - 없음"]),
        " *",
        " * 이 코드는 배선을 확인하기 위한 동작 예시입니다. 실제 제품·라이브러리 버전에 맞게 확인하세요.",
    ]
    if issue_errors:
        header.append(f" * 주의: 검사 오류 {issue_errors}건이 있는 상태에서 생성했습니다. [검사] 탭을 먼저 확인하세요.")
    header.append(" */")
    code_lines = [
        *header,
        "",
        *b.includes,
        *([""] if b.includes else []),
        "// ---------- 핀 · 전역 변수 ----------",
        *(b.globals or ["// (없음)"]),
        "",
        "// 간격(ms)마다 한 번 true 를 돌려주는 비차단 타이머",
        "bool every(unsigned long &last, unsigned long intervalMs) {",
        "  unsigned long now = millis();",
        "  if (now - last < intervalMs) return false;",
        "  last = now;",
        "  return true;",
        "}",
        "",
        *b.functions,
        "void setup() {",
        f"  Serial.begin({debug_baud});",
        *b.setup,
        f'  Serial.println("Autoino: {filename} start");',
        "}",
        "",
        "void loop() {",
        *(b.loop or ["  // 이 보드에서 실행할 부품 동작이 없습니다."]),
        "}",
        "",
    ]
    if issue_errors:
        b.warnings.insert(0, f"검사 오류 {issue_errors}건이 있는 상태에서 생성한 코드입니다.")
    return Sketch(board.instance_id, label, bdef.name, bdef.core, filename, "\n".join(code_lines), libraries, b.warnings)


def _link_code(c: Circuit, b: _Builder, board: PlacedBoard, link: BoardLink, esp32: bool, wire_begin) -> None:
    mine = link.a if link.a.board_instance_id == board.instance_id else link.b
    other = link.b if mine is link.a else link.a
    controller = mine is link.a
    other_label = board_label(c, other.board_instance_id)
    tag = re.sub(r"\W", "", link.id.replace("-", "")) or "link"
    pin = lambda role: pin_expr(c, board.instance_id, mine.pins[role])  # noqa: E731

    if link.protocol == "UART":
        baud = link.baud or 9600
        if mine.bus == "SoftwareSerial":
            b.include("SoftwareSerial.h", "SoftwareSerial")
            b.globals.append(f"SoftwareSerial {tag}({pin('RX')}, {pin('TX')});  // {other_label} 와 UART (RX, TX)")
            port = tag
            b.setup.append(f"  {tag}.begin({baud});")
        elif _uart_port(mine) == "Serial":
            port = "Serial"  # setup() 첫 줄의 Serial.begin 을 이 통신 속도로 맞춘다
        elif esp32:
            port = _uart_port(mine)
            b.setup.append(f"  {port}.begin({baud}, SERIAL_8N1, {pin('RX')}, {pin('TX')});  // {other_label} 와 UART (RX, TX)")
        else:
            port = _uart_port(mine)
            b.setup.append(f"  {port}.begin({baud});  // {other_label} 와 UART")
        b.globals.append(f"unsigned long timer_{tag} = 0;")
        b.globals.append(f"unsigned long count_{tag} = 0;")
        b.loop.append(f"  // {link.protocol} 통신: 1초마다 보내고, 받은 줄은 시리얼 모니터에 출력")
        b.loop.append(f'  if (every(timer_{tag}, 1000)) {{ {port}.print("hello from {board.instance_id} #"); {port}.println(count_{tag}++); }}')
        if port == "Serial":
            b.loop.append(f"  while (Serial.available()) Serial.read();  // USB 시리얼을 함께 쓰므로 받은 데이터는 버린다 (필요하면 여기서 처리)")
        else:
            b.loop.append(f"  while ({port}.available()) Serial.write({port}.read());")
        return

    if link.protocol == "I2C":
        address = link.i2c_address or "0x08"
        b.include("Wire.h", "Wire")
        if controller:
            wire_begin()
            b.globals.append(f"const uint8_t {tag.upper()}_ADDRESS = {address};  // {other_label} (I²C 주변장치)")
            b.globals.append(f"unsigned long timer_{tag} = 0;")
            b.globals.append(f"uint8_t count_{tag} = 0;")
            b.loop.append(f"  // I²C 통신: 1초마다 주변장치({other_label})로 1바이트 전송")
            b.loop.append(f"  if (every(timer_{tag}, 1000)) {{")
            b.loop.append(f"    Wire.beginTransmission({tag.upper()}_ADDRESS);")
            b.loop.append(f"    Wire.write(count_{tag}++);")
            b.loop.append(f"    if (Wire.endTransmission() != 0) Serial.println(\"{tag}: no ACK\");")
            b.loop.append("  }")
        else:
            b.globals.append(f"volatile int lastByte_{tag} = -1;")
            b.functions.append(
                f"// {other_label}(I²C 컨트롤러)가 보낸 데이터를 받는다\n"
                f"void onReceive_{tag}(int /* count */) {{\n"
                f"  while (Wire.available()) lastByte_{tag} = Wire.read();\n"
                "}\n"
            )
            if esp32:
                bus = next((x for x in c.board_def(board.instance_id).buses if x.kind == "I2C"), None)
                pins = {p.role: p.pin_id for p in bus.pins} if bus else {}
                sda = pin_expr(c, board.instance_id, pins.get("SDA", ""))
                scl = pin_expr(c, board.instance_id, pins.get("SCL", ""))
                b.setup.append(f"  Wire.begin((uint8_t){address}, {sda}, {scl}, 100000);  // I²C 주변장치 (주소, SDA, SCL, 속도)")
            else:
                b.setup.append(f"  Wire.begin({address});  // I²C 주변장치 주소")
            b.setup.append(f"  Wire.onReceive(onReceive_{tag});")
            b.globals.append(f"int shown_{tag} = -1;")
            b.loop.append(f"  // I²C 통신: 받은 값이 바뀌면 출력")
            b.loop.append(f'  if (lastByte_{tag} != shown_{tag}) {{ shown_{tag} = lastByte_{tag}; Serial.print("{tag} got: "); Serial.println(shown_{tag}); }}')
        return

    # SPI
    b.include("SPI.h", "SPI")
    if controller:
        ss = pin("SS")
        b.globals.append(f"const uint8_t {tag.upper()}_SS = {ss};  // {other_label} (SPI 주변장치) 선택 핀")
        b.globals.append(f"unsigned long timer_{tag} = 0;")
        b.globals.append(f"uint8_t count_{tag} = 0;")
        if esp32 and mine.bus == "HSPI":
            b.globals.append(f"SPIClass spi_{tag}(HSPI);")
            b.setup.append(f"  spi_{tag}.begin({pin('SCK')}, {pin('MISO')}, {pin('MOSI')}, {tag.upper()}_SS);")
            spi = f"spi_{tag}"
        else:
            b.setup.append("  SPI.begin();")
            spi = "SPI"
        b.setup.append(f"  pinMode({tag.upper()}_SS, OUTPUT);")
        b.setup.append(f"  digitalWrite({tag.upper()}_SS, HIGH);")
        b.loop.append(f"  // SPI 통신: 1초마다 1바이트 주고받기")
        b.loop.append(f"  if (every(timer_{tag}, 1000)) {{")
        b.loop.append(f"    {spi}.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));")
        b.loop.append(f"    digitalWrite({tag.upper()}_SS, LOW);")
        b.loop.append(f"    uint8_t reply = {spi}.transfer(count_{tag}++);")
        b.loop.append(f"    digitalWrite({tag.upper()}_SS, HIGH);")
        b.loop.append(f"    {spi}.endTransaction();")
        b.loop.append(f'    Serial.print("{tag} reply: "); Serial.println(reply);')
        b.loop.append("  }")
        return
    if esp32:
        b.warnings.append(
            f"{link.id}: ESP32 를 SPI 주변장치로 쓰는 코드는 만들지 않았습니다. Arduino SPI 라이브러리는 주변장치 모드를 지원하지 않으므로 ESP32SPISlave 같은 별도 라이브러리가 필요합니다."
        )
        b.globals.append(f"// {link.id}: ESP32 SPI 주변장치 코드는 생성하지 않았습니다 (별도 라이브러리 필요).")
        return
    # AVR SPI 주변장치: 레지스터 직접 설정 + 인터럽트
    b.globals.append(f"volatile uint8_t spiReceived_{tag} = 0;")
    b.globals.append(f"volatile bool spiNew_{tag} = false;")
    b.functions.append(
        f"// SPI 주변장치: {other_label}(컨트롤러)가 보낸 바이트를 받고, 받은 값+1 을 다음 응답으로 준비\n"
        "ISR(SPI_STC_vect) {\n"
        f"  spiReceived_{tag} = SPDR;\n"
        f"  SPDR = spiReceived_{tag} + 1;\n"
        f"  spiNew_{tag} = true;\n"
        "}\n"
    )
    b.setup.append("  pinMode(MISO, OUTPUT);  // SPI 주변장치: MISO 만 출력")
    b.setup.append("  SPCR |= _BV(SPE);   // SPI 사용 (주변장치 모드)")
    b.setup.append("  SPCR |= _BV(SPIE);  // SPI 인터럽트 사용")
    b.loop.append(f"  // SPI 통신: 새로 받은 값 출력")
    b.loop.append(f'  if (spiNew_{tag}) {{ spiNew_{tag} = false; Serial.print("{tag} got: "); Serial.println(spiReceived_{tag}); }}')


def generate_sketches(c: Circuit, project_name: str, now: datetime | None = None) -> list[Sketch]:
    now = now or datetime.now(timezone.utc)
    errors = count_issues(validate_circuit(c))["error"]
    return [_sketch_for(c, board, project_name, now, errors) for board in c.boards if c.board_def(board.instance_id)]
