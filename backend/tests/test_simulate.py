"""DC 시뮬레이션: 손으로 계산한 값과 비교"""

import pytest

from autoino.simulate import (
    LED_KNEE,
    LED_RD,
    OUTPUT_R,
    SimulationError,
    divider_resistors,
    simulate,
)
from helpers import board, circuit, module

UNO = board("board-1", "arduino-uno-r3")
ESP = board("board-2", "esp32-devkit-v1")


def gpio(result, board_id, pin_id):
    return next(g for g in result["gpio"] if g["boardInstanceId"] == board_id and g["pinId"] == pin_id)


def led_circuit():
    return circuit([UNO], [module("led", "led-5mm", color="red", current="10")], [("led:anode", "board-1:D5"), ("led:cathode", "board-1:GND")])


def test_led_current_matches_hand_calculation():
    r = simulate(led_circuit())
    [led] = r["leds"]
    assert led["seriesOhms"] == 330
    expected = (5.0 - (2.0 - LED_KNEE)) / (OUTPUT_R["arduino-avr"] + 330 + LED_RD) * 1000
    assert led["currentMa"] == pytest.approx(expected, abs=0.01)
    assert led["state"] == "on"
    assert gpio(r, "board-1", "D5")["currentMa"] == pytest.approx(expected, abs=0.01)
    assert r["converged"]


def test_led_without_resistor_overcurrent():
    r = simulate(led_circuit(), {"includeSeriesResistors": False})
    [led] = r["leds"]
    expected = (5.0 - 1.8) / (25 + 10) * 1000
    assert led["currentMa"] == pytest.approx(expected, abs=0.05)
    assert led["state"] == "over"
    assert gpio(r, "board-1", "D5")["overCurrent"]
    assert any("권장 한계" in w for w in r["warnings"])


def test_gpio_low_turns_led_off():
    r = simulate(led_circuit(), {"gpio": {"board-1:D5": "low"}})
    assert r["leds"][0]["state"] == "off"
    assert r["leds"][0]["currentMa"] == 0


def test_button_pullup_reads_high_then_low_when_pressed():
    c = circuit([UNO], [module("btn", "push-button")], [("btn:pin2a", "board-1:D4"), ("btn:pin1a", "board-1:GND")])
    released = gpio(simulate(c), "board-1", "D4")
    assert released["mode"] == "input-pullup" and released["logic"] == "HIGH"
    pressed = gpio(simulate(c, {"pressed": ["btn"]}), "board-1", "D4")
    assert pressed["logic"] == "LOW" and pressed["voltage"] < 0.01


def test_divider_brings_5v_signal_into_esp32_range():
    c = circuit(
        [UNO, ESP],
        [module("div", "voltage-divider", ratio="1k-2k")],
        [("board-1:D7", "div:in"), ("div:out", "board-2:GPIO16"), ("div:gnd", "board-1:GND"), ("board-1:GND", "board-2:GND")],
    )
    r = simulate(c, {"gpio": {"board-1:D7": "high"}})
    rx = gpio(r, "board-2", "GPIO16")
    assert rx["voltage"] == pytest.approx(5.0 * 2000 / (1000 + 2000 + 25), abs=0.002)
    assert rx["logic"] == "HIGH" and not rx["overVoltage"]


def test_direct_5v_into_esp32_is_overvoltage():
    c = circuit([UNO, ESP], [], [("board-1:D7", "board-2:GPIO16"), ("board-1:GND", "board-2:GND")])
    rx = gpio(simulate(c, {"gpio": {"board-1:D7": "high", "board-2:GPIO16": "input"}}), "board-2", "GPIO16")
    assert rx["overVoltage"]


def test_missing_common_ground_is_not_judged():
    c = circuit([UNO, ESP], [], [("board-2:GPIO17", "board-1:D4")])
    r = simulate(c, {"gpio": {"board-2:GPIO17": "high", "board-1:D4": "input"}})
    assert gpio(r, "board-1", "D4")["logic"] == "no-common-ground"


def test_floating_input_warns():
    c = circuit([board("board-1", "esp32-devkit-v1")], [], [])
    r = simulate(c, {"gpio": {"board-1:GPIO4": "input"}})
    assert gpio(r, "board-1", "GPIO4")["logic"] == "floating"
    assert any("떠 있습니다" in w for w in r["warnings"])


def test_input_only_pin_cannot_drive():
    c = circuit([board("board-1", "esp32-devkit-v1")], [], [])
    r = simulate(c, {"gpio": {"board-1:GPIO34": "high"}})
    assert gpio(r, "board-1", "GPIO34")["mode"] == "input"
    assert any("입력 전용" in w for w in r["warnings"])


def shifter_circuit():
    return circuit(
        [UNO, ESP],
        [module("ls", "level-shifter-4ch")],
        [
            ("ls:hv", "board-1:5V"),
            ("ls:lv", "board-2:3V3"),
            ("ls:gnd", "board-2:GND"),
            ("board-1:GND", "board-2:GND"),
            ("board-1:D7", "ls:hv1"),
            ("ls:lv1", "board-2:GPIO16"),
        ],
    )


def test_level_shifter_passes_high_as_3v3_and_low_as_low():
    high = simulate(shifter_circuit(), {"gpio": {"board-1:D7": "high", "board-2:GPIO16": "input"}})
    rx = gpio(high, "board-2", "GPIO16")
    assert rx["voltage"] == pytest.approx(3.3, abs=0.01) and rx["logic"] == "HIGH" and not rx["overVoltage"]
    low = simulate(shifter_circuit(), {"gpio": {"board-1:D7": "low", "board-2:GPIO16": "input"}})
    rx = gpio(low, "board-2", "GPIO16")
    assert rx["logic"] == "LOW" and rx["voltage"] < 0.05
    assert low["converged"]


def test_hc_sr04_echo_high_overvoltage_on_esp32():
    c = circuit(
        [board("board-1", "esp32-devkit-v1")],
        [module("us", "hc-sr04")],
        [("us:vcc", "board-1:VIN"), ("us:gnd", "board-1:GND"), ("us:trig", "board-1:GPIO23"), ("us:echo", "board-1:GPIO36")],
    )
    low = simulate(c)
    assert gpio(low, "board-1", "GPIO36")["logic"] == "LOW"
    assert low["loads"][0]["currentMa"] == pytest.approx(15.0, abs=0.05)
    high = simulate(c, {"moduleOutputs": {"us:echo": "high"}})
    assert gpio(high, "board-1", "GPIO36")["overVoltage"]


def test_unpowered_module_and_servo_moving_current():
    c = circuit([UNO], [module("sv", "sg90")], [("sv:vcc", "board-1:5V"), ("sv:gnd", "board-1:GND"), ("sv:signal", "board-1:D9")])
    assert simulate(c)["loads"][0]["currentMa"] == pytest.approx(10.0, abs=0.05)
    assert simulate(c, {"servoMoving": ["sv"]})["loads"][0]["currentMa"] == pytest.approx(250.0, rel=0.01)
    c = circuit([UNO], [module("sv", "sg90")], [("sv:signal", "board-1:D9")])
    r = simulate(c)
    assert r["loads"][0]["status"] == "unpowered"


def test_short_circuit_detected():
    c = circuit([UNO], [], [("board-1:5V", "board-1:GND")])
    assert any("단락" in w for w in simulate(c)["warnings"])


def test_divider_parse_and_bad_options():
    assert divider_resistors("2k2-3k3") == (2200.0, 3300.0)
    assert divider_resistors("10k-20k") == (10000.0, 20000.0)
    with pytest.raises(SimulationError):
        simulate(led_circuit(), {"gpio": {"board-1:D5": "on"}})


# ---------------------------------------------------------------- 외부 전원 · 모터


def motor_circuit(volts="7.4", current="5000"):
    return circuit(
        [UNO],
        [module("ps", "external-power", voltage=volts, current=current), module("drv", "l298n"), module("m1", "dc-gear-tt")],
        [
            ("drv:vs", "ps:plus"),
            ("drv:gnd", "ps:minus"),
            ("ps:minus", "board-1:GND"),
            ("m1:m1", "drv:out1"),
            ("m1:m2", "drv:out2"),
            ("drv:ena", "board-1:D6"),
        ],
    )


def supply(result, name):
    return next(s for s in result["supplies"] if s["pinId"] == name)


def test_external_supply_feeds_driver_and_motor():
    r = simulate(motor_circuit())
    s = supply(r, "ps")
    assert s["voltage"] == pytest.approx(7.4, abs=0.05)
    assert s["currentMa"] == pytest.approx(40 + 160, abs=1)
    [motor] = r["motors"]
    assert motor["voltage"] == pytest.approx(5.4, abs=0.05)  # L298N 전압 강하 2 V
    assert motor["status"] == "ok" and not motor["stalled"]
    assert motor["driver"] == "drv" and motor["channel"] == "모터 A"


def test_motor_stall_raises_supply_current():
    r = simulate(motor_circuit(), {"motorsStalled": ["m1"]})
    assert supply(r, "ps")["currentMa"] == pytest.approx(40 + 1500, rel=0.02)
    assert r["motors"][0]["stalled"]


def test_supply_over_capacity_warns():
    r = simulate(motor_circuit(current="500"), {"motorsStalled": ["m1"]})
    assert any("전원 용량" in w for w in r["warnings"])


def test_motor_overvoltage_is_reported():
    r = simulate(motor_circuit(volts="12"))
    assert r["motors"][0]["status"] == "over"
    assert any("허용 전압" in w for w in r["warnings"])


def test_driver_without_supply_leaves_motor_unpowered():
    c = circuit([UNO], [module("drv", "l298n"), module("m1", "dc-gear-tt")], [("m1:m1", "drv:out1"), ("m1:m2", "drv:out2"), ("drv:ena", "board-1:D6")])
    r = simulate(c)
    assert r["motors"][0]["status"] == "unpowered"
    assert any("전원이 연결되지 않아" in w for w in r["warnings"])


def test_external_ground_not_tied_to_board_is_not_judged():
    c = circuit(
        [UNO],
        [module("ps", "external-power", voltage="5", current="2000"), module("pir", "pir-hc-sr501")],
        [("pir:vcc", "ps:plus"), ("pir:gnd", "ps:minus"), ("pir:out", "board-1:D4")],
    )
    assert gpio(simulate(c), "board-1", "D4")["logic"] in ("floating", "no-common-ground")


def test_regulator_output_supplies_load_and_passes_current_to_input():
    c = circuit(
        [UNO],
        [module("ps", "external-power", voltage="12", current="5000"), module("buck", "buck-lm2596", output="5"), module("sv", "mg996r")],
        [("buck:vin", "ps:plus"), ("buck:gnd", "ps:minus"), ("sv:vcc", "buck:vout"), ("sv:gnd", "buck:gnd2")],
    )
    r = simulate(c, {"servoMoving": ["sv"]})
    assert supply(r, "buck")["voltage"] == pytest.approx(5.0, abs=0.05)
    assert supply(r, "buck")["currentMa"] == pytest.approx(700, rel=0.02)
    assert supply(r, "ps")["currentMa"] == pytest.approx(705, rel=0.02)


def test_generic_module_load_uses_catalog_current():
    c = circuit([UNO], [module("gas", "mq2-gas")], [("gas:vcc", "board-1:5V"), ("gas:gnd", "board-1:GND")])
    r = simulate(c)
    [load] = r["loads"]
    assert load["currentMa"] == pytest.approx(150, abs=1)
    assert load["status"] == "ok"


def test_servo_idle_and_moving_current():
    c = circuit([UNO], [module("sv", "mg90s")], [("sv:vcc", "board-1:5V"), ("sv:gnd", "board-1:GND")])
    assert simulate(c)["loads"][0]["currentMa"] == pytest.approx(10, abs=0.5)
    assert simulate(c, {"servoMoving": ["sv"]})["loads"][0]["currentMa"] == pytest.approx(250, abs=2)
