"""JavaScript 와 같은 방식으로 숫자를 다루는 도우미.

프런트엔드(TypeScript) 엔진과 메시지·수치가 한 글자까지 같도록,
Number.prototype.toFixed, Math.round, String(number) 동작을 흉내 낸다.
"""

from __future__ import annotations

import math
from decimal import ROUND_HALF_UP, Decimal


def to_fixed(value: float, digits: int) -> str:
    """JS (value).toFixed(digits): 이진 부동소수의 정확한 값을 기준으로 반올림(0.5 는 올림)."""
    q = Decimal(1).scaleb(-digits)
    d = Decimal(value).quantize(q, rounding=ROUND_HALF_UP)
    text = format(d, "f")
    return "0" if text == "-0" and digits == 0 else text


def js_round(value: float) -> int:
    """JS Math.round: x.5 는 +∞ 방향으로 올림."""
    return math.floor(value + 0.5)


def js_str(value: float | int) -> str:
    """JS String(number): 정수면 소수점 없이, 아니면 가장 짧은 표현."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if math.isfinite(value) and value == int(value) and abs(value) < 1e21:
        return str(int(value))
    return repr(value)


def js_num_from_fixed(value: float, digits: int) -> str:
    """JS `${+(value).toFixed(digits)}` (불필요한 0 제거)."""
    return js_str(float(to_fixed(value, digits)))
