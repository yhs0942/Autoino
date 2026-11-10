"""Arduino 스케치 생성 테스트.

g++ 가 있으면 tests/arduino_stubs 의 Arduino API 스텁 헤더로 -fsyntax-only 검사를 한다.
스텁은 공개 API 시그니처만 흉내 내므로 실제 AVR/ESP32 툴체인 컴파일을 대신하지 않는다.
"""

import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import pytest

from autoino.codegen import generate_sketches, pin_expr
from autoino.engine.circuit import Circuit
from autoino.project import parse_project

STUBS = Path(__file__).parent / "arduino_stubs"
NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)


def circuit_of(case) -> Circuit:
    return Circuit.from_project(parse_project(case["after"]))


def case_by(cases, name):
    return next(c for c in cases if c["name"] == name)


def stub_define(c: Circuit, board_instance_id: str) -> str:
    board = c.board_def(board_instance_id)
    if board.core == "arduino-esp32":
        return "AUTOINO_STUB_ESP32"
    return "AUTOINO_STUB_MEGA" if board.id == "arduino-mega-2560" else "AUTOINO_STUB_AVR"


def test_pin_expressions(engine_cases):
    c = circuit_of(case_by(engine_cases, "multi-uart-shifter"))
    uno, esp = c.boards[0].instance_id, c.boards[1].instance_id
    assert pin_expr(c, uno, "D5") == "5"
    assert pin_expr(c, uno, "A0") == "A0"
    assert pin_expr(c, esp, "GPIO32") == "32"


def test_one_sketch_per_board(engine_cases):
    for case in engine_cases:
        c = circuit_of(case)
        sketches = generate_sketches(c, case["name"], NOW)
        assert [s.board_instance_id for s in sketches] == [b.instance_id for b in c.boards]
        assert len({s.filename for s in sketches}) == len(sketches)
        for s in sketches:
            assert "void setup()" in s.code and "void loop()" in s.code
            # 핀 상수에는 숫자 또는 A0 형식만 들어간다 (전원 핀 이름 같은 잘못된 값 금지)
            for value in re.findall(r"const uint8_t \w+ = ([^;]+);", s.code):
                assert re.fullmatch(r"\d+|A\d+|0x[0-9A-Fa-f]+", value), value


def test_esp32_uses_esp32servo_and_wire_pins(engine_cases):
    c = circuit_of(case_by(engine_cases, "esp32-all"))
    [s] = generate_sketches(c, "t", NOW)
    assert "#include <ESP32Servo.h>" in s.code and "#include <Servo.h>" not in s.code
    assert "Wire.begin(21, 22);" in s.code
    assert "LiquidCrystal_I2C lcd1(0x27, 16, 2);" in s.code
    assert any(lib["name"] == "ESP32Servo" and not lib["builtIn"] for lib in s.libraries)


def test_uno_uses_servo_library(engine_cases):
    [s] = generate_sketches(circuit_of(case_by(engine_cases, "uno-all")), "t", NOW)
    assert "#include <Servo.h>" in s.code
    assert "Wire.begin();" in s.code


def test_uart_link_softwareserial_and_serial2(engine_cases):
    c = circuit_of(case_by(engine_cases, "multi-uart-shifter"))
    uno, esp = generate_sketches(c, "t", NOW)
    assert "SoftwareSerial link1(4, 7);" in uno.code
    assert "link1.begin(115200);" in uno.code
    assert "Serial2.begin(115200, SERIAL_8N1, 16, 17);" in esp.code
    # 레벨 시프터를 거친 신호가 아니라 보드 간 직결이므로 via 표시는 없음, 대신 상대 보드 이름 주석
    assert "와 UART" in esp.code


def test_i2c_link_controller_and_peripheral(engine_cases):
    c = circuit_of(case_by(engine_cases, "i2c-link-shared"))
    ctrl, peri = generate_sketches(c, "t", NOW)
    assert "Wire.beginTransmission(LINK1_ADDRESS);" in ctrl.code
    assert "Wire.begin(0x27);" in peri.code and "Wire.onReceive(onReceive_link1);" in peri.code
    assert any("I²C 주변장치" in w for w in peri.warnings)


def test_spi_link_avr_peripheral(engine_cases):
    c = circuit_of(case_by(engine_cases, "spi-link-mega"))
    ctrl, peri = generate_sketches(c, "t", NOW)
    assert "SPI.transfer(" in ctrl.code and "LINK1_SS = 53;" in ctrl.code
    assert "ISR(SPI_STC_vect)" in peri.code and "SPCR |= _BV(SPE);" in peri.code


def test_led_on_supply_pin_is_not_a_gpio_constant(engine_cases):
    [s] = generate_sketches(circuit_of(case_by(engine_cases, "led-variants")), "t", NOW)
    assert "항상 켜져 있습니다" in s.code
    assert "= 3.3V" not in s.code and "= 5V" not in s.code


def test_errors_are_announced(engine_cases):
    [s] = generate_sketches(circuit_of(case_by(engine_cases, "uno-manual-errors")), "t", NOW)
    assert s.warnings[0].startswith("검사 오류")
    assert "주의: 검사 오류" in s.code
    assert any("연결되지 않아" in w for w in s.warnings)


@pytest.mark.skipif(shutil.which("g++") is None, reason="g++ 없음")
def test_sketches_pass_stub_syntax_check(engine_cases, tmp_path):
    checked = 0
    for case in engine_cases:
        c = circuit_of(case)
        for s in generate_sketches(c, case["name"], NOW):
            src = tmp_path / f"{case['name']}_{s.filename}.cpp"
            src.write_text("#include <Arduino.h>\n" + s.code, encoding="utf-8")
            r = subprocess.run(
                ["g++", "-std=gnu++17", "-fsyntax-only", "-Wall", "-Wextra", "-Werror", f"-D{stub_define(c, s.board_instance_id)}", f"-I{STUBS}", str(src)],
                capture_output=True,
                text=True,
            )
            assert r.returncode == 0, f"{case['name']} / {s.filename}\n{r.stderr}"
            checked += 1
    assert checked >= 15


# ---------------------------------------------------------------- 모터 · 새 부품


def sketch_of(engine_cases, name, index=0):
    return generate_sketches(circuit_of(case_by(engine_cases, name)), "t", NOW)[index]


def test_l298n_channels_become_motor_code(engine_cases):
    s = sketch_of(engine_cases, "motor-l298n-external")
    assert "void driveMotor(uint8_t in1, uint8_t in2, uint8_t en, int speed)" in s.code
    assert s.code.count("void driveMotor(") == 1  # 채널이 둘이어도 함수는 하나
    assert "driveMotor(MOTOR1A_IN1, MOTOR1A_IN2, MOTOR1A_EN," in s.code
    assert "driveMotor(MOTOR1B_IN1, MOTOR1B_IN2, MOTOR1B_EN," in s.code
    assert "모터 드라이버 코드에서 제어합니다" in s.code
    assert "전원 부품이라 별도 코드가 필요 없습니다" in s.code


def test_unused_driver_channel_has_no_code(engine_cases):
    s = sketch_of(engine_cases, "motor-no-supply")
    assert "MOTOR1A_EN" in s.code and "MOTOR1B_EN" not in s.code


def test_tb6612_releases_standby(engine_cases):
    s = sketch_of(engine_cases, "route-breadboard")
    assert "digitalWrite(MOTOR1_STBY, HIGH);" in s.code


def test_l9110_uses_two_input_drive(engine_cases):
    s = sketch_of(engine_cases, "motor-undervoltage-overcurrent")
    assert "void driveMotor2(" in s.code and "driveMotor2(MOTOR1A_IN1, MOTOR1A_IN2," in s.code


def test_stepper_and_esc_code(engine_cases):
    s = sketch_of(engine_cases, "stepper-bldc")
    assert "digitalWrite(STEPPER1_STEP, HIGH);" in s.code  # A4988
    assert "stepCoils(stepper1_Pins" in s.code or "stepCoils(" in s.code  # ULN2003
    assert "esc1.writeMicroseconds(1000);" in s.code
    assert "int esc1Throttle = 1000;" in s.code  # 예시 코드가 모터를 돌리지 않는다


def test_catalog_templates_on_mega(engine_cases):
    s = sketch_of(engine_cases, "catalog-mega")
    for line in (
        "analogRead(POT1_PIN)",
        "analogRead(STICK1_X)",
        "pinMode(STICK1_SW, INPUT_PULLUP);",
        "digitalRead(PIR1_PIN)",
        "DHT dht1(",
        "Adafruit_NeoPixel strip1(30,",
        "Adafruit_SSD1306 oled1(128, 64, &Wire, -1);",
        "oled1.begin(SSD1306_SWITCHCAPVCC, 0x3C)",
        "TM1637Display seg1(",
        "readImuWord(IMU1_ADDRESS, 0x3B)",
        "SoftwareSerial bt1(",
        "MFRC522 rfid1(RFID1_SS, RFID1_RST);",
        "SPI.begin();",
    ):
        assert line in s.code, line
    assert "digitalWrite(RELAY1_PIN, HIGH);" in s.code  # 릴레이는 LOW 에서 켜지므로 시작은 HIGH
    names = {lib["name"] for lib in s.libraries}
    assert {"DHT sensor library", "Adafruit SSD1306", "Adafruit NeoPixel", "TM1637", "MFRC522"} <= names


def test_esp32_uses_hardware_serial_and_explicit_spi_pins(engine_cases):
    s = sketch_of(engine_cases, "catalog-esp32")
    assert "Serial2.begin(9600, SERIAL_8N1, BT1_RX, BT1_TX);" in s.code
    assert "SPI.begin(RFID1_SCK, RFID1_MISO, RFID1_MOSI, RFID1_SS);" in s.code
    assert "SoftwareSerial" not in s.code


# ---------- 핀 공유 확장 · 아날로그 멀티플렉서 ----------


def _code(engine_cases, name: str) -> str:
    c = circuit_of(case_by(engine_cases, name))
    return generate_sketches(c, name, NOW)[0].code


def test_shared_servo_signal_is_driven_once(engine_cases):
    code = _code(engine_cases, "share-servos")
    # 한 핀에 Servo 객체 두 개를 붙이면 펄스가 겹치므로 첫 서보만 제어하고 두 번째는 설명만 남긴다
    assert code.count(".attach(") == 1
    assert "SG90 서보 모터 2: SG90 서보 모터 1 와(과) 같은 핀(D9)을 함께 씁니다" in code
    assert "같은 신호(서보 신호)로 같이 움직입니다" in code


def test_shared_trig_keeps_each_echo(engine_cases):
    code = _code(engine_cases, "share-trig")
    trig = set(re.findall(r"const uint8_t SONAR\d_TRIG = (\w+);", code))
    assert len(trig) == 1  # TRIG 는 한 핀
    assert len(re.findall(r"const uint8_t SONAR\d_ECHO = (\w+);", code)) == 3
    assert code.count("readDistanceCm(SONAR") == 3  # 센서마다 거리 측정


def test_l298n_channels_share_pins_inside_one_module(engine_cases):
    code = _code(engine_cases, "share-l298n-inside")
    en = dict(re.findall(r"const uint8_t (MOTOR\d(?:A|B)_EN) = (\w+);", code))
    assert len(en) == 2 and len(set(en.values())) == 1
    assert "L298N 모터 드라이버 1 ENA, L298N 모터 드라이버 1 ENB" in code


def test_shared_step_mirrors_second_driver(engine_cases):
    code = _code(engine_cases, "share-steppers")
    assert len(re.findall(r"if \(every\(timer_stepper\w*, 2\)\)", code)) == 1  # 펄스를 두 번 내지 않는다
    assert "같은 신호(스텝 펄스(STEP))로 같이 움직입니다" in code


def test_mux_sensors_read_through_one_analog_pin(engine_cases):
    code = _code(engine_cases, "mux-analog")
    assert "int readMux1(uint8_t channel)" in code
    assert "const uint8_t MUX1_SIG = A0;" in code
    assert re.search(r"const uint8_t MUX1_SELECT\[3\] = \{MUX1_S0, MUX1_S1, MUX1_S2\};", code)
    for ch in range(3):
        assert f"readMux1({ch})" in code
    # 조이스틱 X·Y 도 멀티플렉서로 읽고, 버튼은 디지털 핀 그대로
    assert "readMux1(3)" in code and "readMux1(4)" in code
    assert "digitalRead(STICK1_SW)" in code
    assert "analogRead(POT" not in code
    assert "C0" in code and "SIG" in code


def test_mux_on_esp32_uses_gpio_numbers(engine_cases):
    code = _code(engine_cases, "mux-esp32")
    assert "const uint8_t MUX1_SIG = 36;" in code
    assert "MUX1_SELECT[1]" in code
    assert "readMux1(1)" in code
