"""프로젝트 파일(.autoino.json) 검증과 변환.

frontend/src/engine/project.ts 의 parseProjectFile / toProjectFile 과 같은 규칙이다
(버전 2, 버전 1 파일 호환, 같은 한국어 오류 메시지).
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone
from typing import Any

from .catalog import Catalog, get_catalog
from .models import BoardEndpoint, ModuleEndpoint, ProjectData

_HOLE_MAIN = re.compile(r"^([1-9]\d?)([a-j])$")
_HOLE_RAIL = re.compile(r"^(top|bot)([+-])([1-9]\d?)$")


def _valid_hole(hole: str) -> bool:
    """브레드보드 구멍 ID (예: 12c, top-4). 63열까지"""
    m = _HOLE_MAIN.match(hole)
    if m:
        return int(m.group(1)) <= 63
    m = _HOLE_RAIL.match(hole)
    return bool(m) and int(m.group(3)) <= 63


def parse_endpoint_key(key: str):
    from .engine.circuit import parse_endpoint_key as parse

    return parse(key)

PROJECT_FORMAT = "autoino-project"
PROJECT_VERSION = 2
PROTOCOLS = ("UART", "I2C", "SPI")


class ProjectFileError(ValueError):
    """잘못된 프로젝트 파일"""


def _fail(message: str) -> None:
    raise ProjectFileError(message)


def _is_obj(v: Any) -> bool:
    return isinstance(v, dict)


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _is_str(v: Any) -> bool:
    return isinstance(v, str)


def _seq_of(value: str, pattern: str) -> int:
    m = re.search(pattern, value)
    return int(m.group(1)) if m else 0


def _parse_boards(raw: dict, catalog: Catalog) -> list[dict]:
    if isinstance(raw.get("boards"), list):
        if not raw["boards"]:
            _fail("보드가 하나 이상 필요합니다.")
        boards = []
        for i, b in enumerate(raw["boards"]):
            if not _is_obj(b) or not _is_str(b.get("instanceId")) or not _is_str(b.get("boardId")):
                _fail(f"보드 #{i + 1} 의 형식이 잘못되었습니다.")
            if not catalog.board(b["boardId"]):
                _fail(f"알 수 없는 보드입니다: {b['boardId']}")
            boards.append(
                {
                    "instanceId": b["instanceId"],
                    "boardId": b["boardId"],
                    "label": b["label"] if _is_str(b.get("label")) and b["label"] else f"보드 {i + 1}",
                    "x": b["x"] if _is_num(b.get("x")) else 40,
                    "y": b["y"] if _is_num(b.get("y")) else 40,
                }
            )
        if len({b["instanceId"] for b in boards}) != len(boards):
            _fail("보드 인스턴스 ID 가 중복되었습니다.")
        return boards
    board_id = raw.get("boardId")
    if not _is_str(board_id) or not catalog.board(board_id):
        _fail(f"알 수 없는 보드입니다: {board_id}")
    rb = raw["board"] if _is_obj(raw.get("board")) else {}
    return [
        {
            "instanceId": rb["instanceId"] if _is_str(rb.get("instanceId")) and rb["instanceId"] else "board-1",
            "boardId": board_id,
            "label": "보드 1",
            "x": rb["x"] if _is_num(rb.get("x")) else 40,
            "y": rb["y"] if _is_num(rb.get("y")) else 40,
        }
    ]


def parse_project(data: Any, catalog: Catalog | None = None) -> ProjectData:
    """프로젝트 파일(문자열 또는 dict)을 검증하고 ProjectData 로 바꾼다."""
    catalog = catalog or get_catalog()
    raw = data
    if isinstance(data, (str, bytes)):
        try:
            raw = json.loads(data)
        except (ValueError, TypeError):
            _fail("JSON 형식이 아닙니다.")
    if not _is_obj(raw) or raw.get("format") != PROJECT_FORMAT:
        _fail("Autoino 프로젝트 파일이 아닙니다.")
    version = raw.get("version")
    if not _is_num(version) or version > PROJECT_VERSION:
        _fail(f"지원하지 않는 파일 버전입니다 ({version}). 프로그램을 업데이트하세요.")
    boards = _parse_boards(raw, catalog)
    board_ids = {b["instanceId"] for b in boards}
    primary = boards[0]["instanceId"]
    if not isinstance(raw.get("modules"), list) or not isinstance(raw.get("connections"), list):
        _fail("부품 또는 연결 목록이 없습니다.")

    placed = []
    for i, m in enumerate(raw["modules"]):
        if not (
            _is_obj(m)
            and _is_str(m.get("instanceId"))
            and _is_str(m.get("moduleId"))
            and _is_str(m.get("label"))
            and _is_num(m.get("x"))
            and _is_num(m.get("y"))
        ):
            _fail(f"부품 #{i + 1} 의 형식이 잘못되었습니다.")
        module = catalog.module(m["moduleId"])
        if not module:
            _fail(f"알 수 없는 부품입니다: {m['moduleId']}")
        saved = m["params"] if _is_obj(m.get("params")) else {}
        params = {}
        for param in module.parameters or []:
            v = saved.get(param.id)
            params[param.id] = v if _is_str(v) and any(o.value == v for o in param.options) else param.default_value
        host = m["hostBoardId"] if _is_str(m.get("hostBoardId")) and m["hostBoardId"] in board_ids else primary
        placed.append(
            {"instanceId": m["instanceId"], "moduleId": m["moduleId"], "label": m["label"], "x": m["x"], "y": m["y"], "params": params, "hostBoardId": host}
        )
    instance_ids = {p["instanceId"] for p in placed}
    if len(instance_ids) != len(placed):
        _fail("부품 인스턴스 ID 가 중복되었습니다.")

    def parse_endpoint(e: Any, where: str) -> dict:
        if _is_obj(e) and e.get("kind") == "board" and _is_str(e.get("pinId")):
            bid = e["boardInstanceId"] if _is_str(e.get("boardInstanceId")) else primary
            if bid not in board_ids:
                _fail(f"{where}: 존재하지 않는 보드({bid})에 연결되어 있습니다.")
            return {"kind": "board", "boardInstanceId": bid, "pinId": e["pinId"]}
        if _is_obj(e) and e.get("kind") == "module" and _is_str(e.get("instanceId")) and _is_str(e.get("pinId")):
            if e["instanceId"] not in instance_ids:
                _fail(f"{where}: 존재하지 않는 부품({e['instanceId']})에 연결되어 있습니다.")
            return {"kind": "module", "instanceId": e["instanceId"], "pinId": e["pinId"]}
        _fail(f"{where}: 연결 끝점 형식이 잘못되었습니다.")
        return {}

    def parse_end(e: Any, where: str) -> dict:
        if not (_is_obj(e) and _is_str(e.get("boardInstanceId")) and e["boardInstanceId"] in board_ids and _is_str(e.get("bus")) and _is_obj(e.get("pins"))):
            _fail(f"{where} 의 형식이 잘못되었습니다.")
        return {"boardInstanceId": e["boardInstanceId"], "bus": e["bus"], "pins": {k: v for k, v in e["pins"].items() if _is_str(v)}}

    links = []
    for i, link in enumerate(raw.get("links") if isinstance(raw.get("links"), list) else []):
        where = f"통신 연결 #{i + 1}"
        if not (_is_obj(link) and _is_str(link.get("id")) and link.get("protocol") in PROTOCOLS and isinstance(link.get("pairs"), list)):
            _fail(f"{where} 의 형식이 잘못되었습니다.")
        pairs = []
        for p in link["pairs"]:
            if not (_is_obj(p) and _is_str(p.get("a")) and _is_str(p.get("b")) and _is_str(p.get("signal"))):
                _fail(f"{where} 의 핀 쌍 형식이 잘못되었습니다.")
            pairs.append({"a": p["a"], "b": p["b"], "signal": p["signal"]})
        item = {"id": link["id"], "protocol": link["protocol"], "a": parse_end(link.get("a"), where), "b": parse_end(link.get("b"), where), "pairs": pairs}
        if _is_str(link.get("i2cAddress")):
            item["i2cAddress"] = link["i2cAddress"]
        if _is_num(link.get("baud")):
            item["baud"] = link["baud"]
        links.append(item)
    link_ids = {link["id"] for link in links}

    connections = []
    for i, c in enumerate(raw["connections"]):
        if not _is_obj(c) or not _is_str(c.get("id")):
            _fail(f"연결 #{i + 1} 의 형식이 잘못되었습니다.")
        conn = {
            "id": c["id"],
            "from": parse_endpoint(c.get("from"), f"연결 #{i + 1}"),
            "to": parse_endpoint(c.get("to"), f"연결 #{i + 1}"),
            "auto": c.get("auto") is True,
        }
        if _is_str(c.get("linkId")) and c["linkId"] in link_ids:
            conn["linkId"] = c["linkId"]
        if c.get("via") == "breadboard":
            conn["via"] = "breadboard"
        connections.append(conn)

    max_seq = max([0, *[_seq_of(p["instanceId"], r"#(\d+)$") for p in placed]])
    max_conn = max([0, *[_seq_of(c["id"], r"^w(\d+)$") for c in connections]])
    max_board = max([0, *[_seq_of(b["instanceId"], r"^board-(\d+)$") for b in boards]])
    max_link = max([0, *[_seq_of(link["id"], r"^link-(\d+)$") for link in links]])
    label_counters: dict[str, int] = {}
    for p in placed:
        m = re.search(r"(\d+)$", p["label"])
        label_counters[p["moduleId"]] = max(label_counters.get(p["moduleId"], 0), int(m.group(1)) if m else 0)
    if _is_obj(raw.get("labelCounters")):
        for k, v in raw["labelCounters"].items():
            if _is_num(v):
                label_counters[k] = max(label_counters.get(k, 0), int(v))

    def counter(v: Any, minimum: int) -> int:
        return max(int(v) if _is_num(v) else 1, minimum)

    # 핀 공유 그룹: 있는 부품 핀만 남기고, 멤버가 둘 미만이면 버린다
    shares: list[dict] = []
    for sh in raw.get("shares") if isinstance(raw.get("shares"), list) else []:
        if not (_is_obj(sh) and _is_str(sh.get("id")) and isinstance(sh.get("members"), list)):
            continue
        members: list[str] = []
        for k in sh["members"]:
            e = parse_endpoint_key(k) if _is_str(k) else None
            if isinstance(e, ModuleEndpoint) and e.instance_id in instance_ids and k not in members:
                members.append(k)
        if len(members) >= 2 and not any(x["id"] == sh["id"] for x in shares):
            shares.append({"id": sh["id"], "members": members})

    # 브레드보드 구멍: 있는 끝점과 올바른 구멍 ID 만 남긴다
    holes: dict[str, str] = {}
    if _is_obj(raw.get("breadboardHoles")):
        for key, hole in raw["breadboardHoles"].items():
            e = parse_endpoint_key(key)
            exists = e is not None and (e.board_instance_id in board_ids if isinstance(e, BoardEndpoint) else e.instance_id in instance_ids)
            if exists and _is_str(hole) and _valid_hole(hole):
                holes[key] = hole

    # 실물 배치 위치: 있는 보드·부품·브레드보드만
    layout: dict[str, dict] = {}
    if _is_obj(raw.get("layout")):
        for key, pos in raw["layout"].items():
            if (key in board_ids or key in instance_ids or key == "breadboard") and _is_obj(pos) and _is_num(pos.get("x")) and _is_num(pos.get("y")):
                layout[key] = {"x": pos["x"], "y": pos["y"]}

    name = raw.get("name")
    breadboard = raw.get("breadboard")
    position = {"breadboard": {"x": breadboard["x"], "y": breadboard["y"]}} if _is_obj(breadboard) and _is_num(breadboard.get("x")) and _is_num(breadboard.get("y")) else {}
    return ProjectData.model_validate(
        {
            "name": name if _is_str(name) and name.strip() else "제목 없는 프로젝트",
            "boards": boards,
            "placed": placed,
            "connections": connections,
            "links": links,
            **position,
            **({"breadboardHoles": holes} if holes else {}),
            **({"shares": shares} if shares else {}),
            **({"layout": layout} if layout else {}),
            "nextSeq": counter(raw.get("nextSeq"), max_seq + 1),
            "nextConnSeq": counter(raw.get("nextConnSeq"), max_conn + 1),
            "nextBoardSeq": counter(raw.get("nextBoardSeq"), max_board + 1),
            "nextLinkSeq": counter(raw.get("nextLinkSeq"), max_link + 1),
            "labelCounters": label_counters,
        }
    )


def to_project_file(project: ProjectData, now: datetime | None = None) -> dict:
    """ProjectData → 프로젝트 파일(dict, 버전 2)"""
    now = now or datetime.now(timezone.utc)
    d = project.dump()
    breadboard = {"breadboard": d["breadboard"]} if "breadboard" in d else {}
    if d.get("breadboardHoles"):
        breadboard["breadboardHoles"] = d["breadboardHoles"]
    if d.get("shares"):
        breadboard["shares"] = d["shares"]
    if d.get("layout"):
        breadboard["layout"] = d["layout"]
    return {
        "format": PROJECT_FORMAT,
        "version": PROJECT_VERSION,
        "savedAt": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "name": d["name"],
        "boardId": d["boards"][0]["boardId"] if d["boards"] else "",
        "boards": d["boards"],
        "modules": d["placed"],
        "connections": d["connections"],
        "links": d["links"],
        **breadboard,
        "nextSeq": d["nextSeq"],
        "nextConnSeq": d["nextConnSeq"],
        "nextBoardSeq": d["nextBoardSeq"],
        "nextLinkSeq": d["nextLinkSeq"],
        "labelCounters": d["labelCounters"],
    }
