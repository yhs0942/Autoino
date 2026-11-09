# 3단계: 미구현 기능 완성과 파이썬 백엔드

## 추가된 기능

| 기능 | 위치 | 비고 |
| --- | --- | --- |
| 여러 보드 · 보드 간 통신 (UART/I²C/SPI) | `frontend/src/engine/boardLinks.ts`, `ConnectionPanel` | UART TX↔RX 교차, AVR 은 SoftwareSerial 자동 선택, I²C 주소, SPI |
| 실행 취소 · 다시 실행 | `state/circuitState.ts` (past/future, 최대 100단계) | 드래그는 첫 이동에서 한 번만 기록 |
| 보드 드래그 | `CircuitCanvas`, `BoardGraphic` | |
| 넷 기반 전압 검사 · 레벨 변환 자동 삽입 | `engine/levels.ts`, `engine/levelShift.ts` | 입력 신호는 전압 분배기, 양방향·보드 간은 4채널 BSS138 레벨 시프터 |
| 브레드보드 배치도 | `engine/breadboard.ts` | 830홀 모델. 4단계에서 배선도 위 브레드보드로 바뀌었습니다 ([phase-4](phase-4-motors-power.md)) |
| 회로도 SVG/PNG, 브레드보드 SVG/PNG | `engine/schematicSvg.ts`, `breadboardSvg.ts`, `utils/svgExport.ts` | 내보내기 대화상자 |
| 배선 경로 정리 | `wireGeometry.ts` (곡선/직각 레인), `engine/arrange.ts` | |
| Arduino 코드 생성 | `backend/autoino/codegen.py`, `CodeDialog` | 보드별 .ino, Servo/ESP32Servo, LiquidCrystal_I2C, SoftwareSerial, 보드 간 통신 예시 |
| DC 시뮬레이션 | `backend/autoino/simulate.py`, `SimulationDialog` | 절점 해석, LED 구간 선형 모델, 레벨 시프터 스위치 근사 |
| 서버 프로젝트 저장 | `backend/autoino/storage.py`, `ServerProjectsDialog` | `projects/<id>.autoino.json` |
| 파이썬 백엔드 | `backend/` | 엔진 포팅(TS 와 결과 동일), REST API, CLI |

## 프런트엔드 ↔ 백엔드

- `frontend/src/api/client.ts` 가 `/api` 를 호출하고, `useBackend.ts` 가 `/api/health` 로 연결 상태를 확인합니다(헤더 배지, 누르면 다시 확인).
- 백엔드가 꺼져 있으면 코드·시뮬레이션·서버 대화상자에 실행 방법을 안내하며, 나머지 기능은 브라우저만으로 동작합니다.
- 개발: `npm run dev`(5173) + `python -m autoino serve`(8000), Vite 프록시가 `/api` 를 넘깁니다. 배포: `npm run build` 후 백엔드가 `frontend/dist` 를 함께 제공합니다.

## 검증

- 프런트엔드: `tsc -b`, `oxlint`, `vitest` 114개, `vite build`
- 백엔드: `pytest` 82개 — 엔진 TS↔Python 일치(11개 시나리오), 코드 생성(18개 스케치 g++ 스텁 구문 검사 `-Werror`),
  시뮬레이션(손 계산값과 비교: LED 전류, 풀업 버튼, 전압 분배기, 레벨 시프터 HIGH/LOW, 과전압, GND 미공유, 단락), API, 저장소, CLI
- 브라우저 E2E(Playwright): 서버 연결 배지, 코드 생성, 시뮬레이션(버튼 누름·저항 제거 시 과전류), 서버 저장·다시 열기, 백엔드 없을 때 안내

## 남은 한계

- 실제 AVR/ESP32 툴체인 컴파일은 하지 못했습니다(이 환경에서 외부 툴체인 설치가 허용되지 않음). 스텁 헤더 구문 검사만 합니다.
- 시뮬레이션은 직류 정상 상태만 다루며, 모델 값은 가정입니다(결과에 표시).
- 서버 저장은 인증이 없는 로컬용입니다. 여러 사람이 쓰는 서버에 그대로 공개하지 마세요.
