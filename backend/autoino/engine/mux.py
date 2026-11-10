"""아날로그 멀티플렉서 (frontend/src/engine/mux.ts 와 같은 규칙)

아날로그 센서 출력은 한 아날로그 핀에 바로 묶으면 서로 부딪치므로, 센서마다 멀티플렉서 채널을 하나씩 주고
SIG 를 아날로그 핀 하나에 잇는다. 선택선(S0…)은 쓰는 채널 수만큼만 보드 핀에 잇고 나머지는 GND 에 묶는다.
"""

from __future__ import annotations

import math

from ..models import ModuleEndpoint
from .circuit import Circuit, endpoint_key


def mux_channel_pin(c: Circuit, e) -> tuple[str, int] | None:
    """끝점이 멀티플렉서 채널 핀이면 (멀티플렉서 인스턴스 ID, 채널 번호)"""
    if not isinstance(e, ModuleEndpoint):
        return None
    item = c.placed_module(e.instance_id)
    module = c.module_def(item.module_id) if item else None
    if not module or not module.mux or e.pin_id not in module.mux.channels:
        return None
    return item.instance_id, module.mux.channels.index(e.pin_id)


def mux_channel_of(c: Circuit, key: str) -> tuple[str, int] | None:
    """센서 핀(끝점 키)이 이어진 멀티플렉서 채널"""
    for conn in c.connections:
        ends = [conn.from_, conn.to]
        for i, e in enumerate(ends):
            if endpoint_key(e) == key:
                found = mux_channel_pin(c, ends[1 - i])
                if found:
                    return found
    return None


def mux_users(c: Circuit, mux_id: str) -> list[tuple[int, str]]:
    """멀티플렉서에 이어진 센서 핀 (채널, 끝점 키), 채널 순"""
    users = []
    for conn in c.connections:
        for a, b in ((conn.from_, conn.to), (conn.to, conn.from_)):
            ch = mux_channel_pin(c, a)
            if ch and ch[0] == mux_id and not mux_channel_pin(c, b):
                users.append((ch[1], endpoint_key(b)))
    return sorted(users)


def select_bits_for(max_channel: int) -> int:
    return max(1, math.ceil(math.log2(max_channel + 1)))
