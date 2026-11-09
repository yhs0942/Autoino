# Autoino 백엔드

FastAPI 기반 파이썬 백엔드입니다. 프런트엔드의 회로 엔진(검사·자동 핀 배정·저항 선정·내보내기)을 파이썬으로 옮기고,
Arduino 코드 생성·DC 시뮬레이션·서버 프로젝트 저장을 제공합니다.

## 설치와 실행

```bash
cd backend
python -m venv .venv
.venv/bin/pip install -r requirements-dev.txt   # 실행만 할 때는 requirements.txt
.venv/bin/python -m autoino serve               # http://127.0.0.1:8000, API 문서 /docs
.venv/bin/python -m pytest                      # 테스트
```

환경 변수: `AUTOINO_DATA_DIR`(기본 `../data`), `AUTOINO_PROJECTS_DIR`(기본 `../projects`), `AUTOINO_FRONTEND_DIST`(기본 `../frontend/dist`).

## 명령줄

```bash
python -m autoino check-data                        # data/*.json 구조 검사
python -m autoino analyze 파일.autoino.json [--json]  # 검사 결과와 핀 배정표 (오류가 있으면 종료 코드 1)
python -m autoino codegen 파일.autoino.json -o out/   # 보드별 스케치 폴더 생성
python -m autoino simulate 파일.autoino.json --gpio board-1:D5=low --press push-button#2
```

## API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/health` | 상태, 버전, 기능 목록 |
| GET | `/api/catalog`, `/api/boards[/{id}]`, `/api/modules[/{id}]` | 부품·보드 데이터 (data/*.json 원본 형식) |
| GET/POST | `/api/projects` | 서버 프로젝트 목록 / 새로 저장 (본문: 프로젝트 파일) |
| GET/PUT/DELETE | `/api/projects/{id}` | 열기 / 덮어쓰기 / 삭제 |
| POST | `/api/analyze` | `{project}` → 검사 결과, 저항, 핀 배정표, BOM, 전원 분석(`power`) |
| POST | `/api/auto-assign` | `{project, route}` → 자동 핀 배정 후 프로젝트 (`route`: `direct` 또는 `breadboard`) |
| POST | `/api/codegen` | `{project}` → 보드별 스케치, 라이브러리, 경고 |
| POST | `/api/simulate` | `{project, options}` → 넷 전압, GPIO, LED, 부품 전원, 모터, 경고, 가정 |

잘못된 프로젝트 파일은 422 와 한국어 `detail` 메시지(프런트엔드와 같은 문장)로 응답합니다.
프로젝트 ID 는 서버가 만든 12자리 16진수만 받으므로 경로 조작이 불가능합니다.

## 구조

- `autoino/models.py` 데이터 모델(pydantic), `catalog.py` 데이터 로드·검증, `project.py` 프로젝트 파일 검증(버전 1 변환 포함)
- `autoino/engine/` TypeScript 엔진 포팅(전원 분석 `power.py` 포함). `tests/test_engine_parity.py` 가 `shared/fixtures/engine-cases.json`
  (프런트엔드 `fixtures.test.ts` 가 생성)과 결과를 비교합니다. 엔진을 바꾸면 `cd frontend && UPDATE_FIXTURES=1 npm test` 로 픽스처를 다시 만드세요.
- `autoino/codegen.py` Arduino 스케치 생성, `simulate.py` DC 시뮬레이션, `storage.py` 프로젝트 저장소, `api.py` REST API, `__main__.py` CLI

## 한계 (정직한 범위)

- **코드 생성**: 배선 확인용 동작 예시입니다. g++ 가 있으면 `tests/arduino_stubs/` 의 스텁 헤더로 구문을 검사합니다.
  `arduino-cli` 가 있으면 `AUTOINO_COMPILE=1 python -m pytest tests/test_arduino_compile.py` 로 실제 AVR/ESP32 툴체인 컴파일을 확인할 수 있습니다
  (라이브러리는 전용 폴더에 받습니다. 보드에 올려 실행해 보는 시험은 아닙니다).
  ESP32 를 SPI 주변장치로 쓰는 코드는 만들지 않고 경고합니다.
- **시뮬레이션**: 한 순간의 직류 정상 상태만 계산합니다. GPIO 출력 저항, 내부 풀업, LED·모듈·모터 전류 등은 가정값이며
  결과의 `assumptions` 에 모두 적혀 있습니다. PWM, 통신 파형, 시간 변화, 프로그램 실행, 배터리 전압 강하는 다루지 않습니다.
