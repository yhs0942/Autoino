"""핀 배정표·부품 목록 (exporters.ts, 브레드보드 배치 정보는 제외)"""

from __future__ import annotations

from .circuit import Circuit, board_label, is_internal_pin, is_pin_connected, required_pins, resolve_board_pin
from .electrical import CAPABILITY_LABELS, ROLE_LABELS
from .netlist import build_netlist
from .paths import route_to_board
from .resistor import compute_series_resistors, format_ohms
from .mux import mux_channel_of
from .shares import compute_ladder_resistors, share_board_pin, share_of


def build_pin_table(c: Circuit) -> list[dict]:
    resistors = compute_series_resistors(c)
    ladder = compute_ladder_resistors(c)
    traced = build_netlist(c, pass_through=True)
    rows: list[dict] = []
    for item in c.placed:
        module = c.module_def(item.module_id)
        required = required_pins(c.connections, item.instance_id, module)
        for pin in module.pins:
            connected = is_pin_connected(c.connections, item.instance_id, pin.id)
            route = route_to_board(c, item.instance_id, pin.id, traced) if connected else None
            target = resolve_board_pin(c, route.board_instance_id, route.pin_id) if route else None
            res = next((r for r in resistors if r["instanceId"] == item.instance_id and r["pinId"] == pin.id), None)
            notes: list[str] = []
            if res and res["status"] == "ok":
                notes.append(f"직렬 저항 {format_ohms(res['choice']['standardOhms'])}")
            rung = next((r for r in ladder if r["instanceId"] == item.instance_id and r["pinId"] == pin.id), None)
            if rung:
                notes.append(f"사다리 저항 {format_ohms(rung['ohms'])}" if rung["ohms"] else "사다리 (저항 없이)")
            share = share_of(c, f"module:{item.instance_id}:{pin.id}")
            if share and route:
                share_pin = share_board_pin(c, share)
                if share_pin and share_pin[1] == route.pin_id:
                    notes.append(f"핀 공유 ({len(share.members)}개)")
            if route and route.via:
                notes.append(f"{', '.join(route.via)} 경유")
            optional = pin not in required
            if not connected and optional:
                notes.append("연결 불필요 (내부 연결)" if is_internal_pin(module, pin.id) else "연결 불필요")
            elif connected and not route:
                ch = mux_channel_of(c, f"module:{item.instance_id}:{pin.id}")
                mux = c.placed_module(ch[0]) if ch else None
                if mux:
                    sig = route_to_board(c, mux.instance_id, c.module_def(mux.module_id).mux.common, traced)
                    notes.append(f"{mux.label} C{ch[1]} (SIG → {sig.pin_id if sig else '미연결'})")
                else:
                    notes.append("다른 부품에 연결")
            rows.append(
                {
                    "instanceId": item.instance_id,
                    "moduleLabel": item.label,
                    "pinName": pin.name,
                    "role": ROLE_LABELS[pin.role],
                    "optional": optional,
                    "boardName": board_label(c, route.board_instance_id) if route and len(c.boards) > 1 else "",
                    "boardPin": route.pin_id if route else "",
                    "boardPinFeatures": ", ".join(CAPABILITY_LABELS[x] for x in target.pin.capabilities) if target and target.pin else "",
                    "note": " · ".join(notes),
                }
            )
    return rows


def build_bom(c: Circuit) -> list[dict]:
    rows: list[dict] = []
    by_board: dict[str, list[str]] = {}
    for b in c.boards:
        by_board.setdefault(b.board_id, []).append(b.label)
    for board_id, labels in by_board.items():
        board = c.catalog.board(board_id)
        if board:
            rows.append({"item": board.name, "spec": board.microcontroller, "quantity": len(labels), "note": f"메인 보드 ({', '.join(labels)})"})
    by_module: dict[str, dict] = {}
    for p in c.placed:
        module = c.module_def(p.module_id)
        param_spec = " ".join(
            next((o.label for o in param.options if o.value == p.params.get(param.id, param.default_value)), "")
            for param in module.parameters or []
            if param.bom
        )
        key = f"{p.module_id}|{param_spec}"
        entry = by_module.setdefault(key, {"spec": f"{module.name_en} · {param_spec}" if param_spec else module.name_en, "labels": []})
        entry["labels"].append(p.label)
    for key, entry in by_module.items():
        module = c.module_def(key.split("|")[0])
        rows.append({"item": module.name, "spec": entry["spec"], "quantity": len(entry["labels"]), "note": ", ".join(entry["labels"])})
    by_resistor: dict[str, dict] = {}
    for r in compute_series_resistors(c):
        if r["status"] != "ok":
            continue
        key = f"{format_ohms(r['choice']['standardOhms'])}|{r['choice']['ratingLabel']}"
        entry = by_resistor.setdefault(key, {"quantity": 0, "labels": []})
        entry["quantity"] += 1
        entry["labels"].append(c.placed_module(r["instanceId"]).label)
    for key, entry in by_resistor.items():
        value, rating = key.split("|")
        rows.append({"item": "저항", "spec": f"{value} {rating} (E12)", "quantity": entry["quantity"], "note": f"{', '.join(entry['labels'])} 직렬 저항"})
    by_rung: dict[float, list[str]] = {}
    for r in compute_ladder_resistors(c):
        if not r["ohms"]:
            continue
        by_rung.setdefault(r["ohms"], []).append(c.placed_module(r["instanceId"]).label)
    for ohms, labels in by_rung.items():
        rows.append({"item": "저항", "spec": f"{format_ohms(ohms)} 1/4 W (E12)", "quantity": len(labels), "note": f"{', '.join(labels)} 버튼 사다리"})
    if c.connections:
        rows.append({"item": "점퍼 와이어", "spec": "", "quantity": len(c.connections), "note": "브레드보드 배선에 따라 달라질 수 있음"})
    return rows
