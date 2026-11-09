"""생성한 스케치를 실제 보드 툴체인으로 컴파일한다 (선택 실행).

arduino-cli 와 보드 코어(arduino:avr, esp32:esp32)가 설치된 PC 에서 다음처럼 실행한다.

    AUTOINO_COMPILE=1 python -m pytest tests/test_arduino_compile.py

라이브러리는 전용 폴더(AUTOINO_ARDUINO_LIBS, 없으면 임시 폴더)에 받으므로 사용자의 Arduino 폴더를 건드리지 않는다.
보드에 올려 실행해 보는 시험은 아니다.
"""

import json
import os
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import pytest

from autoino.codegen import generate_sketches
from autoino.engine.circuit import Circuit
from autoino.project import parse_project

ROOT = Path(__file__).resolve().parents[2]
ENABLED = os.environ.get("AUTOINO_COMPILE") == "1" and shutil.which("arduino-cli") is not None
NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)

FQBN = {
    "arduino-uno-r3": "arduino:avr:uno",
    "arduino-mega-2560": "arduino:avr:mega",
    "arduino-nano": "arduino:avr:nano",
    "esp32-devkit-v1": "esp32:esp32:esp32",
}
LIBRARIES = [
    "Servo",
    "ESP32Servo",
    "LiquidCrystal I2C",
    "DHT sensor library",
    "Adafruit Unified Sensor",
    "Adafruit GFX Library",
    "Adafruit SSD1306",
    "Adafruit BusIO",
    "Adafruit NeoPixel",
    "TM1637",
    "MFRC522",
]


def _sketches():
    with open(ROOT / "shared" / "fixtures" / "engine-cases.json", encoding="utf-8") as f:
        cases = json.load(f)["cases"]
    params = []
    for case in cases:
        c = Circuit.from_project(parse_project(case["after"]))
        for s in generate_sketches(c, case["name"], NOW):
            board = c.board_def(s.board_instance_id)
            params.append(pytest.param(s, FQBN[board.id], id=f"{case['name']}-{s.board_instance_id}"))
    return params


pytestmark = pytest.mark.skipif(not ENABLED, reason="AUTOINO_COMPILE=1 과 arduino-cli 가 필요합니다")


@pytest.fixture(scope="session")
def arduino_env():
    user_dir = os.environ.get("AUTOINO_ARDUINO_LIBS") or tempfile.mkdtemp(prefix="autoino-arduino-")
    env = {**os.environ, "ARDUINO_DIRECTORIES_USER": user_dir}
    done = subprocess.run(["arduino-cli", "lib", "install", *LIBRARIES], env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    assert done.returncode == 0, done.stderr
    return env


@pytest.mark.parametrize(("sketch", "fqbn"), _sketches() if ENABLED else [])
def test_sketch_compiles(sketch, fqbn, arduino_env, tmp_path):
    folder = tmp_path / sketch.filename[: -len(".ino")]
    folder.mkdir()
    (folder / sketch.filename).write_text(sketch.code, encoding="utf-8")
    done = subprocess.run(
        ["arduino-cli", "compile", "--fqbn", fqbn, str(folder)],
        env=arduino_env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert done.returncode == 0, f"{sketch.filename} ({fqbn})\n{done.stderr[-3000:]}"
