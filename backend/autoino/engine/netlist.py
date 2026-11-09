"""넷리스트 (netlist.ts): 전기적으로 연결된 끝점 묶음 (union-find)"""

from __future__ import annotations

from dataclasses import dataclass

from .circuit import Circuit, endpoint_key, module_ep
from .electrical import ground_pins_of


@dataclass
class Netlist:
    parent: dict[str, str]
    members: dict[str, list[str]]

    def net_of(self, key: str) -> str:
        if key not in self.parent:
            return key
        root = key
        while self.parent[root] != root:
            root = self.parent[root]
        return root


def build_netlist(c: Circuit, pass_through: bool = False) -> Netlist:
    parent: dict[str, str] = {}

    def find(k: str) -> str:
        root = k
        while root in parent and parent[root] != root:
            root = parent[root]
        cur = k
        while cur in parent and parent[cur] != root:
            nxt = parent[cur]
            parent[cur] = root
            cur = nxt
        return root

    def add(k: str) -> None:
        parent.setdefault(k, k)

    def union(a: str, b: str) -> None:
        add(a)
        add(b)
        ra, rb = find(a), find(b)
        if ra == rb:
            return
        # 결정적인 결과를 위해 사전순으로 작은 키를 대표로 둔다 (TS 와 동일)
        if ra < rb:
            parent[rb] = ra
        else:
            parent[ra] = rb

    for conn in c.connections:
        union(endpoint_key(conn.from_), endpoint_key(conn.to))
    for inst in c.boards:
        board = c.board_def(inst.instance_id)
        if not board:
            continue
        grounds = [f"board:{inst.instance_id}:{g}" for g in ground_pins_of(board)]
        for g in grounds[1:]:
            union(grounds[0], g)
    for item in c.placed:
        module = c.module_def(item.module_id)
        pairs = list((module.internal_connections or []) if module else [])
        if pass_through and module:
            pairs += list(module.pass_through or [])
        for a, b in pairs:
            union(endpoint_key(module_ep(item.instance_id, a)), endpoint_key(module_ep(item.instance_id, b)))

    members: dict[str, list[str]] = {}
    for k in sorted(parent):
        members.setdefault(find(k), []).append(k)
    return Netlist(parent, members)
