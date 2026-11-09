"""회로 문서 묶음과 조회 함수 (circuit.ts + connections.ts)"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..catalog import Catalog, get_catalog
from ..models import (
    Board,
    BoardEndpoint,
    BoardLink,
    BoardPin,
    Connection,
    Endpoint,
    Module,
    ModuleEndpoint,
    ModulePin,
    PlacedBoard,
    PlacedModule,
    ProjectData,
)


@dataclass
class Circuit:
    boards: list[PlacedBoard]
    placed: list[PlacedModule]
    connections: list[Connection]
    links: list[BoardLink]
    catalog: Catalog = field(default_factory=get_catalog)
    #: 핀 공유 그룹
    shares: list = field(default_factory=list)

    @classmethod
    def from_project(cls, project: ProjectData, catalog: Catalog | None = None) -> "Circuit":
        return cls(list(project.boards), list(project.placed), list(project.connections), list(project.links), catalog or get_catalog(), list(project.shares or []))

    def board_instance(self, board_instance_id: str) -> PlacedBoard | None:
        return next((b for b in self.boards if b.instance_id == board_instance_id), None)

    def board_def(self, board_instance_id: str) -> Board | None:
        inst = self.board_instance(board_instance_id)
        return self.catalog.board(inst.board_id) if inst else None

    def module_def(self, module_id: str) -> Module | None:
        return self.catalog.module(module_id)

    def placed_module(self, instance_id: str) -> PlacedModule | None:
        return next((p for p in self.placed if p.instance_id == instance_id), None)


@dataclass
class ResolvedBoardPin:
    instance: PlacedBoard
    board: Board
    pin: BoardPin | None


@dataclass
class ResolvedModulePin:
    placed: PlacedModule
    module: Module
    pin: ModulePin


def resolve_board_pin(c: Circuit, board_instance_id: str, pin_id: str) -> ResolvedBoardPin | None:
    inst = c.board_instance(board_instance_id)
    board = c.catalog.board(inst.board_id) if inst else None
    if not inst or not board:
        return None
    return ResolvedBoardPin(inst, board, board.pin(pin_id))


def host_board_of(c: Circuit, item: PlacedModule) -> PlacedBoard | None:
    return c.board_instance(item.host_board_id) or (c.boards[0] if c.boards else None)


def board_label(c: Circuit, board_instance_id: str) -> str:
    if len(c.boards) <= 1:
        return "보드"
    inst = c.board_instance(board_instance_id)
    return inst.label if inst else board_instance_id


# ---------------------------------------------------------------- 끝점


def endpoint_key(e: Endpoint) -> str:
    if isinstance(e, BoardEndpoint):
        return f"board:{e.board_instance_id}:{e.pin_id}"
    return f"module:{e.instance_id}:{e.pin_id}"


def parse_endpoint_key(key: str) -> Endpoint | None:
    def split(rest: str) -> tuple[str, str] | None:
        sep = rest.rfind(":")
        return (rest[:sep], rest[sep + 1 :]) if sep > 0 else None

    if key.startswith("board:"):
        parts = split(key[len("board:") :])
        return BoardEndpoint(kind="board", board_instance_id=parts[0], pin_id=parts[1]) if parts else None
    if key.startswith("module:"):
        parts = split(key[len("module:") :])
        return ModuleEndpoint(kind="module", instance_id=parts[0], pin_id=parts[1]) if parts else None
    return None


def board_ep(board_instance_id: str, pin_id: str) -> BoardEndpoint:
    return BoardEndpoint(kind="board", board_instance_id=board_instance_id, pin_id=pin_id)


def module_ep(instance_id: str, pin_id: str) -> ModuleEndpoint:
    return ModuleEndpoint(kind="module", instance_id=instance_id, pin_id=pin_id)


def touches(c: Connection, e: Endpoint) -> bool:
    k = endpoint_key(e)
    return endpoint_key(c.from_) == k or endpoint_key(c.to) == k


def is_board_to_board(c: Connection) -> bool:
    return isinstance(c.from_, BoardEndpoint) and isinstance(c.to, BoardEndpoint)


@dataclass
class ModuleBoardLink:
    instance_id: str
    module_pin_id: str
    board_instance_id: str
    pin_id: str


def as_module_board_link(c: Connection) -> ModuleBoardLink | None:
    a, b = c.from_, c.to
    if isinstance(a, ModuleEndpoint) and isinstance(b, BoardEndpoint):
        return ModuleBoardLink(a.instance_id, a.pin_id, b.board_instance_id, b.pin_id)
    if isinstance(b, ModuleEndpoint) and isinstance(a, BoardEndpoint):
        return ModuleBoardLink(b.instance_id, b.pin_id, a.board_instance_id, a.pin_id)
    return None


def board_pin_for(connections: list[Connection], instance_id: str, pin_id: str) -> tuple[str, str] | None:
    """모듈 핀에 직접 연결된 보드 핀 (board_instance_id, pin_id)"""
    for c in connections:
        link = as_module_board_link(c)
        if link and link.instance_id == instance_id and link.module_pin_id == pin_id:
            return (link.board_instance_id, link.pin_id)
    return None


def is_pin_connected(connections: list[Connection], instance_id: str, pin_id: str) -> bool:
    e = module_ep(instance_id, pin_id)
    return any(touches(c, e) for c in connections)


def is_internal_pin(module: Module, pin_id: str) -> bool:
    """부품 안에서 다른 핀과 이어진 핀 (택트 스위치 1B, 레벨 시프터 채널 등)"""
    return any(pin_id in pair for pair in [*(module.internal_connections or []), *(module.pass_through or [])])


def active_channels(connections: list[Connection], instance_id: str, module: Module) -> list:
    """쓰고 있는 드라이버 채널. 연결이 하나도 없으면 첫 번째 채널을 쓴다고 본다"""
    channels = module.driver.channels if module.driver else []
    used = [ch for ch in channels if any(is_pin_connected(connections, instance_id, p) for p in [*ch.outputs, *ch.inputs])]
    return used if used else channels[:1]


def idle_pins(connections: list[Connection], instance_id: str, module: Module) -> set[str]:
    """쓰지 않는 드라이버 채널의 핀"""
    active = active_channels(connections, instance_id, module)
    idle: set[str] = set()
    for ch in module.driver.channels if module.driver else []:
        if ch not in active:
            idle.update([*ch.outputs, *ch.inputs])
    return idle


def required_pins(connections: list[Connection], instance_id: str, module: Module) -> list[ModulePin]:
    """연결해야 하는 핀. 수동 핀·전원 출력 핀과 쓰지 않는 드라이버 채널의 핀은 빠진다"""
    idle = idle_pins(connections, instance_id, module)
    return [p for p in module.pins if p.role not in ("passive", "source") and p.id not in idle]


def resolve_module_pin(c: Circuit, e: Endpoint) -> ResolvedModulePin | None:
    if not isinstance(e, ModuleEndpoint):
        return None
    item = c.placed_module(e.instance_id)
    module = c.module_def(item.module_id) if item else None
    pin = module.pin(e.pin_id) if module else None
    return ResolvedModulePin(item, module, pin) if item and module and pin else None


def describe_endpoint(e: Endpoint, c: Circuit) -> str:
    if isinstance(e, BoardEndpoint):
        return f"{board_label(c, e.board_instance_id)} {e.pin_id}"
    r = resolve_module_pin(c, e)
    return f"{r.placed.label} · {r.pin.name}" if r else f"알 수 없는 핀 ({e.pin_id})"
