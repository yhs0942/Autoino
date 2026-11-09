# 2단계: 배선 · 자동 핀 배정 · 저항 선정 · 검증 · 저장

1단계(기본 화면) 위에 다음 기능을 추가했다.

| 기능 | 상태 | 주요 파일 |
| --- | --- | --- |
| 핀 단위 배선 편집기 (모듈 핀 ↔ 보드 핀/모듈 핀 드래그) | 구현 | `frontend/src/components/CircuitCanvas/` |
| 자동 핀 배정 + 충돌·오류 연결 자동 재배치 | 구현 | `frontend/src/engine/autoAssign.ts` |
| LED 직렬 저항 자동 선정 (E12) | 구현 | `frontend/src/engine/resistor.ts` |
| 전기적 검증 (오류/경고/정보) | 구현 | `frontend/src/engine/validate.ts` |
| 프로젝트 저장·불러오기 (.autoino.json) + 브라우저 자동 저장 | 구현 | `frontend/src/engine/project.ts`, `frontend/src/state/persistence.ts` |
| 부품 목록(BOM)·핀 배정표 CSV 내보내기 | 구현 | `frontend/src/engine/exporters.ts` |
| 부품·보드 데이터를 `data/*.json` 으로 분리 + 로드 시 구조 검증 | 구현 | `data/`, `frontend/src/data/validate.ts` |
| 회로도 이미지 내보내기 | 준비 중 | — |
| 브레드보드 내부 연결, 전선 경로 최적화 | 미구현 | — |
| 보드 간 통신 연결 | 미구현 | — |
| 회로 시뮬레이션, 아두이노 코드 생성 | 미구현 | — |

## 배선 편집기

- 부품 카드 아래의 핀 칩을 끌어 보드 핀(또는 다른 부품의 핀)에 놓으면 전선이 생긴다. 보드 핀에서 시작해도 된다.
- 끄는 동안 연결 가능한 보드 핀은 초록색, 불가능한 핀은 흐리게 표시된다 (`compatiblePins`).
- 모듈 핀 하나에는 전선 하나만 둔다. 같은 핀에서 다시 연결하면 기존 전선을 대체한다.
  보드의 5V/GND 같은 핀에는 여러 전선이 연결될 수 있다.
- 전선을 클릭하면 선택되고 `Delete` 로 삭제한다. 부품을 삭제하면 그 부품의 전선도 함께 삭제된다.
- 핀 배정은 따로 저장하지 않고 연결 목록에서 계산한다 (모듈 핀 → 보드 핀 연결 = 그 핀의 배정).
- 전선 끝점 좌표는 렌더링 후 DOM 에서 측정한다 (`data-endpoint` 속성).

## 자동 핀 배정 규칙

1. 기존 연결 중 규칙 위반(예: SDA 를 D7 에)이나 GPIO 충돌이 있는 연결을 해제한다. 충돌 시 먼저 연결된 쪽을 유지한다.
2. 사용자가 직접 만든 올바른 연결은 유지한다.
3. 미연결 핀 배정
   - 전원 → `5V` (모듈 데이터의 `supplyVoltage` 가 3.3 이면 `3.3V`), GND → `GND`
   - I²C SDA/SCL → 보드의 I²C 핀 (여러 장치 공유)
   - 그 밖의 신호 → `requires` 를 만족하는 빈 GPIO 중 점수가 낮은 핀
     - `prefers` 기능(LED → PWM)이 있으면 우선
     - 필요 없는 희소 기능(PWM·인터럽트·통신·아날로그)을 가진 핀은 뒤로 미룸
     - USB 시리얼 핀(D0/D1)은 최후순위
     - Servo 라이브러리를 쓰는 부품이 있으면 Uno/Nano 의 D9/D10 은 PWM 선호 핀으로 취급하지 않음
4. 빈 핀이 없으면 실패한 핀을 상태 표시줄에 알린다.

보드를 바꾸면 기존 연결은 유지되고 검증에서 오류로 표시된다. [자동 핀 배정]을 누르면 새 보드에 맞게 재배치된다
(예: Uno A4/A5 → Mega D20/D21).

## 저항 자동 선정

`R = (공급 전압 − Vf) ÷ 목표 전류` 를 계산한 뒤 그 이상인 가장 작은 E12 표준값을 고른다(전류가 목표를 넘지 않도록).
LED 인스턴스마다 색상(대표 Vf)과 목표 전류(5–20 mA)를 설정할 수 있다. 예: 5 V, 빨강(2.0 V), 10 mA → 300 Ω → **330 Ω**.
공급 전압은 연결된 보드 핀으로 판단한다 (GPIO = 보드 논리 전압, 5V, 3.3V).

## 전기적 검증 항목

- 오류: 기능 불일치(예: SDA 를 I²C 가 아닌 핀에), 전원↔GND 단락, 신호 핀을 전원/GND 에 직접 연결, VIN 으로 부품 전원 공급,
  GPIO 충돌, 보드에 없는 핀, LED 공급 전압 부족, GPIO 전류 합계 초과
- 경고: 미연결 핀, USB 시리얼 핀 사용, 5 V 부품을 3.3 V 에 연결, 서보를 보드 5V 로 구동, Servo 라이브러리와 PWM 핀 충돌,
  LED 전류가 핀 한계에 근접, LED 전압 여유 부족, I²C 기본 주소 중복, 5V 전류 예산 초과
- 정보: LED 를 5V 에 직접 연결(상시 점등), 소비 전류를 알 수 없는 부품

검증은 데이터에 정의된 규칙과 대표값을 기준으로 하며 실제 회로의 안전을 보장하지 않는다.

## 데이터 (`data/*.json`)

- `data/boards.json`, `data/modules.json` 이 단일 원본이다. 프런트엔드는 `@data/*` 별칭으로 가져오고
  `frontend/src/data/validate.ts` 가 앱 시작 시 구조(허용된 핀 기능, 존재하는 핀 참조, ID 중복 등)를 검증한다.
- 새 필드: 보드 `logicVoltage`, `ioPinCurrentLimitMa`, `totalCurrentLimitMa`, `servoPwmConflictPins`,
  모듈 핀 `prefers`, `supplyVoltage`, 모듈 `parameters`, `seriesResistor`, `typicalCurrentMa`, `i2cAddress`,
  `boardPowerWarning`, `library`.

## 프로젝트 파일 형식

```json
{
  "format": "autoino-project",
  "version": 1,
  "savedAt": "2026-10-27T00:00:00.000Z",
  "name": "제목 없는 프로젝트",
  "boardId": "arduino-uno-r3",
  "modules": [{ "instanceId": "led-5mm#1", "moduleId": "led-5mm", "label": "LED 1", "x": 408, "y": 40, "params": { "color": "red", "current": "10" } }],
  "connections": [{ "id": "w1", "from": { "kind": "module", "instanceId": "led-5mm#1", "pinId": "anode" }, "to": { "kind": "board", "pinId": "D5" }, "auto": true }],
  "nextSeq": 2,
  "nextConnSeq": 2,
  "labelCounters": { "led-5mm": 1 }
}
```

불러올 때 형식·버전·보드·부품 ID·연결 대상을 검증하며, 알 수 없는 파라미터 값은 기본값으로 되돌린다.
작업 내용은 브라우저 `localStorage` 에도 자동 저장되어 새로고침 후 복원된다 (다른 기기로 옮기려면 파일 저장 사용).

## 다음 단계 후보

1. 브레드보드 배치와 내부 연결(전원 레일, 5홀 스트립) 반영, 실제 저항 부품 배치
2. 아두이노 스케치 코드 생성 (`library` 필드와 핀 배정 사용)
3. 회로도 이미지(SVG/PNG) 내보내기
4. 여러 메인 보드 배치와 보드 간 UART/I²C/SPI 연결
5. 실행 취소/다시 실행, 전선 경로 최적화
