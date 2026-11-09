"""Autoino 명령줄 도구

  python -m autoino serve [--host 127.0.0.1] [--port 8000] [--reload]
  python -m autoino check-data
  python -m autoino analyze 프로젝트.autoino.json [--json]
  python -m autoino codegen 프로젝트.autoino.json [-o 출력폴더]
  python -m autoino simulate 프로젝트.autoino.json [--gpio board-1:D5=low] [--press push-button#3] [--json]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .catalog import CatalogError, get_catalog
from .project import ProjectFileError
from .simulate import SimulationError


def _read(path: str) -> str:
    try:
        return Path(path).read_text(encoding="utf-8")
    except OSError as e:
        raise SystemExit(f"파일을 읽을 수 없습니다: {path} ({e.strerror})") from e


def _print_json(data: object) -> None:
    json.dump(data, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    uvicorn.run("autoino.api:app", host=args.host, port=args.port, reload=args.reload)
    return 0


def cmd_check_data(_: argparse.Namespace) -> int:
    catalog = get_catalog()
    print(f"데이터 정상: 보드 {len(catalog.boards)}종, 부품 {len(catalog.modules)}종")
    for b in catalog.boards:
        print(f"  보드  {b.id:<22} {b.name} ({b.logic_voltage:g} V 로직, 핀 {len(b.pins)}개)")
    for m in catalog.modules:
        print(f"  부품  {m.id:<22} {m.name} (핀 {len(m.pins)}개)")
    return 0


def cmd_analyze(args: argparse.Namespace) -> int:
    from .service import analyze

    result = analyze(_read(args.file))
    if args.json:
        _print_json(result)
        return 0
    counts = result["counts"]
    print(f"{result['name']}: 오류 {counts['error']} · 경고 {counts['warning']} · 정보 {counts['info']}")
    marks = {"error": "오류", "warning": "경고", "info": "정보"}
    for issue in result["issues"]:
        print(f"  [{marks[issue['severity']]}] {issue['message']}")
    print("핀 배정표")
    for row in result["pinTable"]:
        board = f"{row['boardName']} " if row["boardName"] else ""
        print(f"  {row['moduleLabel']} · {row['pinName']} → {board}{row['boardPin'] or '-'} {row['note']}".rstrip())
    return 1 if counts["error"] else 0


def cmd_codegen(args: argparse.Namespace) -> int:
    from .service import codegen

    result = codegen(_read(args.file))
    out = Path(args.output) if args.output else None
    for sketch in result["sketches"]:
        if out:
            # Arduino IDE 는 스케치 파일이 같은 이름의 폴더 안에 있어야 연다
            folder = out / sketch["filename"][: -len(".ino")]
            folder.mkdir(parents=True, exist_ok=True)
            (folder / sketch["filename"]).write_text(sketch["code"], encoding="utf-8")
            print(f"{folder / sketch['filename']} ({sketch['boardName']})")
        else:
            print(f"// ===== {sketch['filename']} ({sketch['boardName']}) =====")
            print(sketch["code"])
        for warning in sketch["warnings"]:
            print(f"  경고: {warning}", file=sys.stderr)
    return 0


def cmd_simulate(args: argparse.Namespace) -> int:
    from .service import run_simulation

    options: dict = {"gpio": {}, "pressed": args.press or [], "moduleOutputs": {}, "servoMoving": args.servo_moving or []}
    for item in args.gpio or []:
        key, _, value = item.partition("=")
        options["gpio"][key] = value
    for item in args.module_output or []:
        key, _, value = item.partition("=")
        options["moduleOutputs"][key] = value
    if args.no_resistors:
        options["includeSeriesResistors"] = False
    result = run_simulation(_read(args.file), options)
    if args.json:
        _print_json(result)
        return 0
    print("GPIO")
    for g in result["gpio"]:
        v = "-" if g["voltage"] is None else f"{g['voltage']:.3f} V"
        print(f"  {g['boardInstanceId']} {g['pinId']:<7} {g['mode']:<12} {v:>9} {g['currentMa']:>8.2f} mA  {g['logic']:<16} {g['reason']}")
    if result["leds"]:
        print("LED")
        for led in result["leds"]:
            print(f"  {led['label']}: {led['currentMa']:.2f} mA ({led['state']}, 밝기 {led['brightness']:.0f}%)")
    if result["loads"]:
        print("부품 전원")
        for load in result["loads"]:
            v = "-" if load["voltage"] is None else f"{load['voltage']:.2f} V"
            print(f"  {load['label']}: {v}, {load['currentMa']:.1f} mA ({load['status']})")
    print("전원 핀")
    for s in result["supplies"]:
        print(f"  {s['boardInstanceId']} {s['pinId']}: {s['currentMa']:.1f} mA")
    for w in result["warnings"]:
        print(f"경고: {w}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="autoino", description="Autoino 백엔드 도구")
    parser.add_argument("--version", action="version", version=f"autoino {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("serve", help="API 서버 실행")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--reload", action="store_true", help="코드가 바뀌면 다시 시작 (개발용)")
    p.set_defaults(func=cmd_serve)

    p = sub.add_parser("check-data", help="data/*.json 구조 검사")
    p.set_defaults(func=cmd_check_data)

    p = sub.add_parser("analyze", help="회로 검사와 핀 배정표")
    p.add_argument("file")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_analyze)

    p = sub.add_parser("codegen", help="보드별 Arduino 스케치 생성")
    p.add_argument("file")
    p.add_argument("-o", "--output", help="스케치를 저장할 폴더 (없으면 화면에 출력)")
    p.set_defaults(func=cmd_codegen)

    p = sub.add_parser("simulate", help="DC 시뮬레이션")
    p.add_argument("file")
    p.add_argument("--gpio", action="append", metavar="보드:핀=high|low|input|input-pullup")
    p.add_argument("--press", action="append", metavar="버튼 인스턴스 ID")
    p.add_argument("--module-output", action="append", metavar="부품:핀=high|low")
    p.add_argument("--servo-moving", action="append", metavar="서보 인스턴스 ID")
    p.add_argument("--no-resistors", action="store_true", help="계산된 LED 직렬 저항을 빼고 계산")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_simulate)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (ProjectFileError, SimulationError, CatalogError) as e:
        print(f"오류: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
