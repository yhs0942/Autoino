"""생성한 스케치 모음 (shared/fixtures/sketches.json)

frontend 의 코드 시뮬레이터(src/engine/sim/sketches.test.ts)가 이 스케치를 그대로 실행해
배선된 부품이 예시 동작대로 움직이는지 확인한다. 코드 생성을 바꾸면

    UPDATE_FIXTURES=1 python -m pytest tests/test_sketch_fixtures.py

로 파일을 다시 만든 뒤 frontend 테스트를 실행한다.
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from autoino.codegen import generate_sketches
from autoino.engine.circuit import Circuit
from autoino.project import parse_project

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "shared" / "fixtures"
NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _generate() -> list[dict]:
    with open(FIXTURES / "engine-cases.json", encoding="utf-8") as f:
        cases = json.load(f)["cases"]
    out = []
    for case in cases:
        c = Circuit.from_project(parse_project(case["after"]))
        for s in generate_sketches(c, case["name"], NOW):
            out.append({"case": case["name"], "board": s.board_instance_id, "code": s.code})
    return out


def test_sketch_fixture_is_current():
    sketches = _generate()
    path = FIXTURES / "sketches.json"
    if os.environ.get("UPDATE_FIXTURES") == "1":
        path.write_text(json.dumps({"sketches": sketches}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    saved = json.loads(path.read_text(encoding="utf-8"))["sketches"]
    assert saved == sketches, "코드 생성이 바뀌었습니다. UPDATE_FIXTURES=1 로 shared/fixtures/sketches.json 을 다시 만드세요"
