import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="session")
def engine_cases():
    with open(ROOT / "shared" / "fixtures" / "engine-cases.json", encoding="utf-8") as f:
        return json.load(f)["cases"]
