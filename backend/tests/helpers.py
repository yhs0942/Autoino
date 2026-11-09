"""테스트용 프로젝트 파일 빌더"""

from autoino.engine.circuit import Circuit
from autoino.project import parse_project


def board(instance_id: str, board_id: str) -> dict:
    return {"instanceId": instance_id, "boardId": board_id, "label": f"보드 {instance_id[-1]}", "x": 40, "y": 40}


def module(instance_id: str, module_id: str, host: str = "board-1", **params) -> dict:
    return {"instanceId": instance_id, "moduleId": module_id, "label": instance_id, "x": 0, "y": 0, "params": params, "hostBoardId": host}


def ep(text: str) -> dict:
    """'board-1:D5' 또는 'led#1:anode'"""
    owner, pin = text.rsplit(":", 1)
    if owner.startswith("board-"):
        return {"kind": "board", "boardInstanceId": owner, "pinId": pin}
    return {"kind": "module", "instanceId": owner, "pinId": pin}


def project(boards: list[dict], modules: list[dict], wires: list[tuple[str, str]], links: list[dict] | None = None) -> dict:
    return {
        "format": "autoino-project",
        "version": 2,
        "name": "test",
        "boards": boards,
        "modules": modules,
        "connections": [{"id": f"w{i + 1}", "from": ep(a), "to": ep(b), "auto": False} for i, (a, b) in enumerate(wires)],
        "links": links or [],
    }


def circuit(*args, **kwargs) -> Circuit:
    return Circuit.from_project(parse_project(project(*args, **kwargs)))
