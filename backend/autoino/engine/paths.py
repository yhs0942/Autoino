"""부품 핀 → 보드 핀 신호 경로 (paths.ts)"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..models import BoardEndpoint
from .circuit import Circuit, board_pin_for, endpoint_key, module_ep, parse_endpoint_key, resolve_board_pin
from .electrical import is_gpio
from .netlist import Netlist, build_netlist


@dataclass
class SignalRoute:
    board_instance_id: str
    pin_id: str
    via: list[str] = field(default_factory=list)


def route_to_board(c: Circuit, instance_id: str, pin_id: str, traced: Netlist | None = None) -> SignalRoute | None:
    direct = board_pin_for(c.connections, instance_id, pin_id)
    if direct:
        return SignalRoute(direct[0], direct[1], [])
    net = traced or build_netlist(c, pass_through=True)
    key = endpoint_key(module_ep(instance_id, pin_id))
    members = net.members.get(net.net_of(key), [])
    best: tuple[str, str, bool] | None = None
    via: list[str] = []
    for k in members:
        e = parse_endpoint_key(k)
        if e is None:
            continue
        if isinstance(e, BoardEndpoint):
            r = resolve_board_pin(c, e.board_instance_id, e.pin_id)
            gpio = bool(r and r.pin and is_gpio(r.pin))
            if best is None or (gpio and not best[2]):
                best = (e.board_instance_id, e.pin_id, gpio)
        elif e.instance_id != instance_id:
            item = c.placed_module(e.instance_id)
            module = c.module_def(item.module_id) if item else None
            if item and module and any(e.pin_id in pair for pair in module.pass_through or []) and item.label not in via:
                via.append(item.label)
    return SignalRoute(best[0], best[1], via) if best else None
