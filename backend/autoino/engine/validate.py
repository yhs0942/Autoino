"""전기적 검증 (validate.ts). 메시지·코드·순서가 TypeScript 구현과 같다."""

from __future__ import annotations

import re

from ..jsnum import js_round, js_str, to_fixed
from ..models import BoardEndpoint
from .auto_assign import shared_bus_capability
from .circuit import (
    Circuit,
    as_module_board_link,
    board_label,
    describe_endpoint,
    endpoint_key,
    is_board_to_board,
    is_pin_connected,
    module_ep,
    parse_endpoint_key,
    required_pins,
    resolve_board_pin,
    resolve_module_pin,
)
from .electrical import (
    board_pin_voltage,
    board_to_board_error,
    compatible_pins,
    ground_pins_of,
    is_gpio,
    is_usb_serial_pin,
    link_error,
    pin_display_name,
    source_voltage,
    supply_pin_of,
    uses_servo,
)
from .levels import analyze_levels
from .netlist import build_netlist
from .power import (
    BREADBOARD_CURRENT_LIMIT_MA,
    USB_5V_BUDGET_MA,
    analyze_power,
    format_current,
    load_of_pin,
    motors_on_channel,
    net_voltage,
    wire_peak_ma,
)
from .resistor import compute_series_resistors, format_ohms

SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}


def validate_circuit(c: Circuit) -> list[dict]:
    """검사 결과 (프런트엔드 Issue 와 같은 형식의 dict, id 포함)"""
    issues: list[dict] = []

    def push(code: str, severity: str, message: str, **extra) -> None:
        issue = {"id": str(len(issues)), "code": code, "severity": severity, "message": message}
        for key in ("hint", "instanceId", "connectionId", "boardInstanceId"):
            if extra.get(key) is not None:
                issue[key] = extra[key]
        issues.append(issue)

    servo = uses_servo(c.placed, c.module_def)
    netlist = build_netlist(c)
    traced = build_netlist(c, pass_through=True)

    gpio_users: dict[str, list[dict]] = {}

    def add_user(board_instance_id: str, pin_id: str, connection_id: str, label: str, bus: str | None) -> None:
        gpio_users.setdefault(f"{board_instance_id}:{pin_id}", []).append(
            {"connectionId": connection_id, "label": label, "bus": bus, "pinId": pin_id, "boardInstanceId": board_instance_id}
        )

    for conn in c.connections:
        label = f"{describe_endpoint(conn.from_, c)} ↔ {describe_endpoint(conn.to, c)}"
        ends = [conn.from_, conn.to]
        resolved = [None if isinstance(e, BoardEndpoint) else resolve_module_pin(c, e) for e in ends]
        if any(not isinstance(e, BoardEndpoint) and r is None for e, r in zip(ends, resolved)):
            push("missing-module-pin", "error", f"존재하지 않는 부품 핀에 연결되어 있습니다: {label}", connectionId=conn.id)
            continue

        if is_board_to_board(conn):
            a, b = (resolve_board_pin(c, e.board_instance_id, e.pin_id) for e in ends)
            if not a or not b:
                push("board-board", "error", f"존재하지 않는 보드에 연결되어 있습니다: {label}", connectionId=conn.id)
                continue
            if a.instance.instance_id == b.instance.instance_id:
                push("same-board", "error", f"같은 보드의 핀끼리 직접 연결했습니다: {label}", connectionId=conn.id)
                continue
            err = board_to_board_error(a.board, a.pin, b.board, b.pin)
            if err:
                push("board-board", "error", f"{label}: {err}", connectionId=conn.id)
                continue
            if a.pin and supply_pin_of(a.board, a.pin.id):
                push(
                    "supply-backfeed", "warning",
                    f"{label}: 두 보드의 전원 핀을 연결했습니다. 양쪽 보드에 동시에 전원을 넣으면 역전류가 흐를 수 있습니다.",
                    hint="전원은 한쪽 보드에서만 공급하고 GND 는 공통으로 연결하세요.", connectionId=conn.id,
                )
            for r in (a, b):
                if r.pin and is_gpio(r.pin):
                    link = next((l for l in c.links if l.id == conn.link_id), None) if conn.link_id else None
                    bus = next((x for x in r.pin.capabilities if x in ("i2c-sda", "i2c-scl")), None) if link and link.protocol == "I2C" else None
                    add_user(r.instance.instance_id, r.pin.id, conn.id, label, bus)
            continue

        link = as_module_board_link(conn)
        if not link:
            roles = {r.pin.role for r in resolved if r}
            if ("power" in roles or "source" in roles) and "ground" in roles:
                push("module-short", "error", f"전원과 GND 가 연결되어 단락(쇼트)됩니다: {label}", connectionId=conn.id)
            elif "source" in roles and "signal" in roles:
                push("source-on-signal", "error", f"외부 전원을 신호 핀에 직접 연결했습니다: {label}", connectionId=conn.id)
            elif "drive" in roles and "load" not in roles and "passive" not in roles:
                push("driver-output", "error", f"모터 드라이버 출력은 모터 단자에 연결합니다: {label}", connectionId=conn.id)
            continue

        r = resolve_module_pin(c, module_ep(link.instance_id, link.module_pin_id))
        target = resolve_board_pin(c, link.board_instance_id, link.pin_id)
        if not target:
            push("link-error", "error", f"{label}: 존재하지 않는 보드입니다.", instanceId=link.instance_id, connectionId=conn.id)
            continue
        board, board_pin = target.board, target.pin
        err = link_error(board, r.module, r.pin, board_pin, r.placed)
        if err:
            alternatives = compatible_pins(board, r.module, r.pin, r.placed) if (board_pin or r.pin.role == "signal") else []
            hint = None
            if alternatives:
                hint = f"연결 가능한 핀: {', '.join(alternatives[:8])}{' …' if len(alternatives) > 8 else ''}"
            push("link-error", "error", f"{label}: {err}", hint=hint, instanceId=link.instance_id, connectionId=conn.id, boardInstanceId=link.board_instance_id)
            continue
        if board_pin is None:
            continue

        if r.pin.role == "source":
            volts = source_voltage(r.module, r.placed, r.pin)
            power_input = board.power_input
            if power_input and power_input.pin_id == board_pin.id:
                if volts is not None and volts < power_input.min_voltage:
                    push(
                        "vin-undervoltage", "warning",
                        f"{r.placed.label}: {js_str(volts)} V 는 {board_pin.id} 권장 입력({js_str(power_input.min_voltage)}–{js_str(power_input.max_voltage)} V)보다 낮아 보드가 불안정할 수 있습니다.",
                        hint="5 V 전원은 USB 나 5V 핀으로 넣는 것이 낫습니다.", instanceId=link.instance_id, connectionId=conn.id,
                    )
            elif supply_pin_of(board, board_pin.id):
                push(
                    "source-on-supply", "warning",
                    f"{r.placed.label}: {board_pin.id} 핀에 전원을 직접 넣으면 보드 레귤레이터와 보호 회로를 거치지 않습니다.",
                    hint="전압이 정확한 안정화 전원만 쓰고, USB 를 함께 연결하지 마세요.", instanceId=link.instance_id, connectionId=conn.id,
                )

        if r.pin.role == "power":
            v = board_pin_voltage(board, board_pin)
            needed = r.pin.min_voltage if r.pin.min_voltage is not None else r.pin.supply_voltage
            if needed and r.pin.supply_voltage and v is not None and v < needed:
                push(
                    "undervoltage-supply", "warning",
                    f"{r.placed.label}: {js_str(r.pin.supply_voltage)} V 부품을 {board_pin.id} 에 연결했습니다. 동작하지 않거나 불안정할 수 있습니다.",
                    instanceId=link.instance_id, connectionId=conn.id,
                )
            if r.module.board_power_warning:
                push("board-power-warning", "warning", f"{r.placed.label}: {r.module.board_power_warning}", instanceId=link.instance_id, connectionId=conn.id)
            sp = supply_pin_of(board, board_pin.id)
            note = sp.note if sp else None
            if note:
                push("supply-note", "info", f"{r.placed.label}: {board_pin.id} — {note}", instanceId=link.instance_id, connectionId=conn.id)

        if r.pin.role == "signal" and is_gpio(board_pin):
            add_user(link.board_instance_id, board_pin.id, conn.id, f"{r.placed.label} · {r.pin.name}", shared_bus_capability(r.pin))
            if r.pin.max_input_voltage and board.logic_voltage > r.pin.max_input_voltage + 0.01:
                push(
                    "module-input-overvoltage", "warning",
                    f"{r.placed.label} · {r.pin.name}: {board.name} 의 {js_str(board.logic_voltage)} V 신호가 이 핀의 허용 전압({js_str(r.pin.max_input_voltage)} V)을 넘습니다.",
                    hint="전압 분배기나 레벨 시프터로 신호를 낮춰 연결하세요.", instanceId=link.instance_id, connectionId=conn.id,
                )
            if is_usb_serial_pin(board, board_pin):
                push(
                    "usb-serial", "warning",
                    f"{r.placed.label} · {r.pin.name} → {board_pin.id}: USB 시리얼(스케치 업로드·시리얼 모니터)과 공유되는 핀입니다.",
                    hint="업로드가 실패하거나 시리얼 통신이 방해받을 수 있습니다.", instanceId=link.instance_id, connectionId=conn.id,
                )
            for restriction in board_pin.restrictions or []:
                relevant = (
                    restriction.kind in ("strapping", "onboard-led")
                    or (restriction.kind == "no-internal-pull" and r.pin.pull == "up")
                    or (restriction.kind == "adc2-wifi" and "analog" in r.pin.requires)
                )
                if not relevant:
                    continue
                push(
                    "pin-restriction", "info" if restriction.kind == "onboard-led" else "warning",
                    f"{r.placed.label} · {r.pin.name} → {pin_display_name(board_pin)}: {restriction.description}",
                    hint="[자동 핀 배정]은 이런 핀을 가능한 한 피합니다." if restriction.kind in ("strapping", "no-internal-pull") else None,
                    instanceId=link.instance_id, connectionId=conn.id,
                )
            if servo and "pwm" in (r.pin.prefers or []) and board_pin.id in board.servo_pwm_conflict_pins:
                push(
                    "servo-pwm", "warning",
                    f"{r.placed.label}: Servo 라이브러리를 사용하면 {board_pin.id} 에서 analogWrite(PWM 밝기 조절)를 쓸 수 없습니다.",
                    hint="켜기/끄기는 가능합니다. 밝기 조절이 필요하면 다른 PWM 핀으로 옮기세요.", instanceId=link.instance_id, connectionId=conn.id,
                )

    # ---------- 핀 충돌 ----------
    for users in gpio_users.values():
        if len(users) < 2:
            continue
        bus = users[0]["bus"]
        if bus and all(u["bus"] == bus for u in users):
            continue
        prefix = f"{board_label(c, users[0]['boardInstanceId'])} " if len(c.boards) > 1 else ""
        push(
            "pin-conflict", "error",
            f"핀 충돌: {prefix}{users[0]['pinId']} 에 신호 {len(users)}개가 연결되어 있습니다 ({', '.join(u['label'] for u in users)}).",
            hint="[자동 핀 배정]을 누르면 나중에 연결된 신호를 빈 핀으로 재배치합니다.",
            connectionId=users[-1]["connectionId"], boardInstanceId=users[0]["boardInstanceId"],
        )

    # ---------- 미연결 핀 ----------
    for item in c.placed:
        module = c.module_def(item.module_id)
        missing = [p for p in required_pins(c.connections, item.instance_id, module) if not is_pin_connected(c.connections, item.instance_id, p.id)]
        if missing:
            hint = "모터는 보드에 바로 연결하지 않습니다. 모터 드라이버(L298N 등)를 추가하고 [자동 핀 배정]을 누르세요." if module.motor else "핀을 끌어 보드 핀에 연결하거나 [자동 핀 배정]을 사용하세요."
            push("unconnected", "warning", f"{item.label}: {', '.join(p.name for p in missing)} 미연결", hint=hint, instanceId=item.instance_id)

    # ---------- 전압 레벨 (넷 단위) ----------
    for f in analyze_levels(c, netlist):
        conn = next((x for x in c.connections if endpoint_key(x.from_) == f.key or endpoint_key(x.to) == f.key), None)
        code = {"error": "level-overvoltage", "warning": "level-low-high"}.get(f.severity, "level-margin")
        push(code, f.severity, f.message, hint=f.hint, instanceId=f.driver.instance_id, connectionId=conn.id if conn else None, boardInstanceId=f.board_instance_id)

    # ---------- 보드 간 GND 공통 ----------
    ground_net: dict[str, str] = {}
    for b in c.boards:
        d = c.board_def(b.instance_id)
        grounds = ground_pins_of(d) if d else []
        if grounds:
            ground_net[b.instance_id] = netlist.net_of(f"board:{b.instance_id}:{grounds[0]}")
    reported: set[str] = set()
    for keys in netlist.members.values():
        boards_in_net: set[str] = set()
        for k in keys:
            m = re.match(r"^board:([^:]+):(.+)$", k)
            if not m:
                continue
            rr = resolve_board_pin(c, m.group(1), m.group(2))
            if rr and rr.pin and is_gpio(rr.pin):
                boards_in_net.add(m.group(1))
        ids = sorted(boards_in_net)
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                pair = f"{ids[i]}|{ids[j]}"
                if pair in reported or ground_net.get(ids[i]) == ground_net.get(ids[j]):
                    continue
                reported.add(pair)
                push(
                    "ground-not-common", "error",
                    f"{board_label(c, ids[i])} 와 {board_label(c, ids[j])} 가 신호로 연결되어 있지만 GND 가 연결되어 있지 않습니다.",
                    hint="두 보드의 GND 를 서로 연결하세요. 기준 전압이 다르면 신호를 읽을 수 없습니다.", boardInstanceId=ids[j],
                )

    # ---------- 보드 간 통신 연결 완전성 ----------
    for link in c.links:
        missing = [
            p for p in link.pairs
            if traced.net_of(f"board:{link.a.board_instance_id}:{p.a}") != traced.net_of(f"board:{link.b.board_instance_id}:{p.b}")
        ]
        if missing:
            push(
                "link-incomplete", "warning",
                f"{link.protocol} 통신 ({board_label(c, link.a.board_instance_id)} ↔ {board_label(c, link.b.board_instance_id)}): {', '.join(p.signal for p in missing)} 연결이 빠져 있습니다.",
                hint="연결 방식 창에서 통신 연결을 지우고 다시 만들 수 있습니다.", boardInstanceId=link.b.board_instance_id,
            )

    # ---------- 직렬 저항 · 전류 ----------
    gpio_ma: dict[str, float] = {}
    five_ma: dict[str, float] = {}
    for res in compute_series_resistors(c):
        item = c.placed_module(res["instanceId"])
        if res["status"] == "insufficient-voltage":
            push(
                "led-insufficient-voltage", "error",
                f"{item.label}: 공급 전압({js_str(res['supplyVoltage'])} V)이 순방향 전압(약 {js_str(res['forwardVoltage'])} V)보다 높지 않아 켜지지 않습니다.",
                instanceId=item.instance_id,
            )
        if res["status"] == "unknown-voltage":
            push("led-unknown-voltage", "warning", f"{item.label}: {res['boardPinId']} 의 전압을 알 수 없어 저항을 계산할 수 없습니다.", instanceId=item.instance_id)
        if res["status"] != "ok":
            continue
        target = resolve_board_pin(c, res["boardInstanceId"], res["boardPinId"])
        ch = res["choice"]
        if ch["supplyVoltage"] - ch["forwardVoltage"] < 0.5:
            push(
                "led-low-margin", "warning",
                f"{item.label}: 공급 전압({js_str(ch['supplyVoltage'])} V)과 순방향 전압(약 {js_str(ch['forwardVoltage'])} V)의 차이가 작아 제품에 따라 어둡거나 켜지지 않을 수 있습니다.",
                hint="5 V 핀이나 GPIO(5 V)에 연결하는 것을 권장합니다.", instanceId=item.instance_id,
            )
        if target.pin and is_gpio(target.pin):
            gpio_ma[res["boardInstanceId"]] = gpio_ma.get(res["boardInstanceId"], 0) + ch["actualMa"]
            if ch["actualMa"] > target.board.io_pin_current_limit_ma * 0.9:
                push(
                    "led-near-limit", "warning",
                    f"{item.label}: {res['boardPinId']} 전류 약 {to_fixed(ch['actualMa'], 1)} mA 로 핀 권장 한계({js_str(target.board.io_pin_current_limit_ma)} mA)에 가깝습니다.",
                    hint="목표 전류를 10 mA 정도로 낮추는 것을 권장합니다.", instanceId=item.instance_id,
                )
        else:
            five_ma[res["boardInstanceId"]] = five_ma.get(res["boardInstanceId"], 0) + ch["actualMa"]
            push(
                "led-always-on", "info",
                f"{item.label}: {res['boardPinId']} 에 직접 연결되어 항상 켜져 있습니다 (직렬 저항 {format_ohms(ch['standardOhms'])}).",
                instanceId=item.instance_id,
            )
    for bid, ma in gpio_ma.items():
        board = c.board_def(bid)
        if ma > board.total_current_limit_ma:
            push(
                "gpio-total-current", "error",
                f"GPIO 출력 전류 합계 약 {to_fixed(ma, 0)} mA 가 {board.microcontroller} 전체 한계({js_str(board.total_current_limit_ma)} mA)를 넘습니다.",
                hint="LED 목표 전류를 낮추거나 트랜지스터로 구동하세요.", boardInstanceId=bid,
            )

    # ---------- 5V 전원 예산 ----------
    unknown: dict[str, list[str]] = {}
    for item in c.placed:
        module = c.module_def(item.module_id)
        for pin in [p for p in module.pins if p.role == "power"]:
            link = next(
                (l for l in (as_module_board_link(x) for x in c.connections) if l and l.instance_id == item.instance_id and l.module_pin_id == pin.id),
                None,
            )
            target = resolve_board_pin(c, link.board_instance_id, link.pin_id) if link else None
            sp = supply_pin_of(target.board, link.pin_id) if target else None
            if not link or not target or (sp.voltage if sp else 0) < 4.5:
                continue
            typical = load_of_pin(c, netlist, item, module, pin)["typicalMa"]
            if typical is not None:
                five_ma[link.board_instance_id] = five_ma.get(link.board_instance_id, 0) + typical
            else:
                unknown.setdefault(link.board_instance_id, []).append(item.label)
    for bid, ma in five_ma.items():
        if ma > USB_5V_BUDGET_MA:
            push("usb-budget", "warning", f"보드 5V 사용 전류가 약 {to_fixed(ma, 0)} mA 로 USB 전원 여유(약 {USB_5V_BUDGET_MA} mA)를 넘을 수 있습니다.", boardInstanceId=bid)
    for bid, labels in unknown.items():
        push(
            "unknown-current", "info",
            f"소비 전류를 알 수 없는 부품이 5V 에 연결되어 있습니다: {', '.join(labels)}. 전원 예산은 제품 사양으로 확인하세요.",
            boardInstanceId=bid,
        )

    # ---------- I²C 주소 중복 ----------
    by_bus: dict[str, list[tuple[str, str]]] = {}
    for item in c.placed:
        module = c.module_def(item.module_id)
        sda = next((p for p in module.pins if "i2c-sda" in p.requires), None)
        if not module.i2c_address or not sda:
            continue
        key = endpoint_key(module_ep(item.instance_id, sda.id))
        bus_key = traced.net_of(key) if is_pin_connected(c.connections, item.instance_id, sda.id) else f"host:{item.host_board_id}"
        by_bus.setdefault(bus_key, []).append((module.i2c_address, item.label))
    for link in c.links:
        if link.protocol == "I2C" and link.i2c_address and link.b.pins.get("SDA"):
            by_bus.setdefault(traced.net_of(f"board:{link.b.board_instance_id}:{link.b.pins['SDA']}"), []).append(
                (link.i2c_address, f"{board_label(c, link.b.board_instance_id)} (I²C 주변장치)")
            )
    for devices in by_bus.values():
        by_address: dict[str, list[str]] = {}
        for address, label in devices:
            by_address.setdefault(address, []).append(label)
        for address, labels in by_address.items():
            if len(labels) > 1:
                push(
                    "i2c-address", "warning", f"I²C 주소 충돌 가능: {', '.join(labels)} 의 기본 주소가 모두 {address} 입니다.",
                    hint="모듈 뒷면의 주소 점퍼(A0–A2)로 주소를 서로 다르게 설정해야 합니다.",
                )

    # ---------- 전원 (외부 전원·레귤레이터·보드 전원 핀) ----------
    power = analyze_power(c, netlist)
    for s in power["sources"]:
        for load in s["loads"]:
            if load["maxVoltage"] is not None and s["voltage"] > load["maxVoltage"] + 0.01:
                push(
                    "supply-overvoltage", "error",
                    f"{load['label']} · {load['pinName']}: {s['label']} 전압({js_str(s['voltage'])} V)이 허용 최대 전압({js_str(load['maxVoltage'])} V)을 넘습니다.",
                    hint="맞는 전압의 전원으로 바꾸거나 벅 컨버터로 전압을 낮추세요.", instanceId=load["instanceId"],
                )
            elif s["kind"] != "board" and load["minVoltage"] is not None and s["voltage"] < load["minVoltage"] - 0.01:
                push(
                    "supply-undervoltage", "warning",
                    f"{load['label']} · {load['pinName']}: {s['label']} 전압({js_str(s['voltage'])} V)이 최소 동작 전압({js_str(load['minVoltage'])} V)보다 낮습니다.",
                    instanceId=load["instanceId"],
                )
        if s["kind"] != "board" and s["limitMa"] is not None and s["status"] == "overload":
            push(
                "supply-overload", "error",
                f"{s['label']}: 평상시 전류 {format_current(s['typicalMa'])} 가 전원 용량 {format_current(s['limitMa'])} 을 넘습니다.",
                hint="[전원] 탭에서 맞는 전원을 고르세요.",
            )
        elif s["kind"] != "board" and s["limitMa"] is not None and s["status"] == "peak":
            push(
                "supply-peak", "warning",
                f"{s['label']}: 기동·스톨 때 최대 {format_current(s['peakMa'])} 까지 흘러 전원 용량 {format_current(s['limitMa'])} 을 넘을 수 있습니다.",
                hint="전압이 순간적으로 떨어져 보드가 리셋될 수 있습니다. 용량이 더 큰 전원을 권장합니다.",
            )
        if s["parallel"]:
            push(
                "supply-parallel", "warning",
                f"{s['label']} 와 {', '.join(s['parallel'])} 의 + 가 같은 넷에 연결되어 있습니다. 전원 두 개를 바로 이으면 역전류가 흐를 수 있습니다.",
                hint="전원은 하나만 연결하고 GND 만 공통으로 잇는 것이 안전합니다.",
            )

    # ---------- 모터 ↔ 드라이버 ----------
    for item in c.placed:
        module = c.module_def(item.module_id)
        driver = module.driver
        if not driver:
            continue
        supply = net_voltage(c, netlist, endpoint_key(module_ep(item.instance_id, driver.supply_pin)))
        for channel in driver.channels:
            motors = motors_on_channel(c, netlist, item, channel)
            if not motors:
                continue
            typical = sum(m.motor.typical_ma for _, m in motors)
            peak = sum(m.motor.peak_ma for _, m in motors)
            if typical > driver.channel_ma:
                push(
                    "driver-overcurrent", "error",
                    f"{item.label} {channel.label}: 모터 전류 {format_current(typical)} 가 채널 정격 {format_current(driver.channel_ma)} 을 넘습니다.",
                    hint="전류가 더 큰 드라이버를 쓰거나 모터를 채널에 나눠 연결하세요.", instanceId=item.instance_id,
                )
            elif peak > driver.channel_peak_ma:
                push(
                    "driver-peak", "warning",
                    f"{item.label} {channel.label}: 모터 스톨 전류 {format_current(peak)} 가 채널 최대 {format_current(driver.channel_peak_ma)} 을 넘습니다.",
                    hint="모터가 걸려서 멈추면 드라이버가 손상될 수 있습니다.", instanceId=item.instance_id,
                )
            if supply is None:
                continue
            volts = js_round((supply - driver.drop_voltage) * 10) / 10
            for placed, m in motors:
                spec = m.motor
                if volts > spec.max_voltage + 0.01:
                    push(
                        "motor-overvoltage", "error",
                        f"{placed.label}: 모터에 약 {js_str(volts)} V 가 걸려 허용 전압({js_str(spec.max_voltage)} V)을 넘습니다.",
                        hint="전압이 낮은 전원을 쓰세요. PWM 으로 평균 전압을 낮출 수도 있지만 코드 실수로 모터가 탈 수 있습니다.", instanceId=placed.instance_id,
                    )
                elif volts < spec.min_voltage - 0.01:
                    push(
                        "motor-undervoltage", "warning",
                        f"{placed.label}: 드라이버 전압 강하 뒤 모터 전압이 약 {js_str(volts)} V 로 최소 동작 전압({js_str(spec.min_voltage)} V)보다 낮습니다.",
                        instanceId=placed.instance_id,
                    )

    # ---------- 레귤레이터 입력 여유 ----------
    for item in c.placed:
        module = c.module_def(item.module_id)
        if not module.regulator:
            continue
        input_v = net_voltage(c, netlist, endpoint_key(module_ep(item.instance_id, module.regulator.input_pin)))
        output = max((source_voltage(module, item, p) or 0) for p in module.pins if p.role == "source")
        needed = js_round((output + module.regulator.drop_voltage) * 10) / 10
        if input_v is not None and input_v < needed - 0.01:
            push(
                "regulator-headroom", "warning",
                f"{item.label}: 입력 {js_str(input_v)} V 로는 출력 {js_str(output)} V 를 만들 수 없습니다 (입력 {js_str(needed)} V 이상 필요).",
                instanceId=item.instance_id,
            )

    # ---------- 외부 전원을 쓰는 부품의 GND 공통 ----------
    for item in c.placed:
        module = c.module_def(item.module_id)
        grounds = [p for p in module.pins if p.role == "ground" and is_pin_connected(c.connections, item.instance_id, p.id)]
        if not grounds:
            continue
        boards_used: set[str] = set()
        for pin in [p for p in module.pins if p.role == "signal"]:
            key = endpoint_key(module_ep(item.instance_id, pin.id))
            for k in netlist.members.get(netlist.net_of(key), []):
                e = parse_endpoint_key(k)
                if not isinstance(e, BoardEndpoint):
                    continue
                rr = resolve_board_pin(c, e.board_instance_id, e.pin_id)
                if rr and rr.pin and is_gpio(rr.pin):
                    boards_used.add(e.board_instance_id)
        for bid in sorted(boards_used):
            board_ground = ground_net.get(bid)
            if any(netlist.net_of(endpoint_key(module_ep(item.instance_id, p.id))) == board_ground for p in grounds):
                continue
            push(
                "module-ground-not-common", "error",
                f"{item.label}: 신호는 {board_label(c, bid)}에 연결되어 있는데 GND 가 {board_label(c, bid)}와 이어져 있지 않습니다.",
                hint="외부 전원 − 를 보드 GND 에 연결하세요. 기준 전압이 다르면 신호가 통하지 않습니다.", instanceId=item.instance_id,
            )
            break

    # ---------- 브레드보드 허용 전류 ----------
    for conn in c.connections:
        if conn.via != "breadboard":
            continue
        peak = wire_peak_ma(c, conn.from_, conn.to, netlist)
        if peak >= BREADBOARD_CURRENT_LIMIT_MA:
            push(
                "breadboard-current", "warning",
                f"{describe_endpoint(conn.from_, c)} ↔ {describe_endpoint(conn.to, c)}: 최대 {format_current(peak)} 가 흘러 브레드보드 접점 허용 전류(약 {format_current(BREADBOARD_CURRENT_LIMIT_MA)})를 넘습니다.",
                hint="이 전선을 선택해 [보드 직결]로 바꾸세요.", connectionId=conn.id,
            )

    # ---------- 설치 안내 ----------
    for item in c.placed:
        note = c.module_def(item.module_id).setup_note
        if note:
            push("setup-note", "info", f"{item.label}: {note}", instanceId=item.instance_id)

    return sorted(issues, key=lambda i: (SEVERITY_ORDER[i["severity"]], int(i["id"])))


def count_issues(issues: list[dict]) -> dict[str, int]:
    return {s: sum(1 for i in issues if i["severity"] == s) for s in ("error", "warning", "info")}
