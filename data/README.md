# data/

Autoino 의 부품·보드 정의 JSON 데이터베이스입니다. 프런트엔드는 이 파일들을 직접 가져옵니다 (`@data/*` 별칭).

| 파일 | 내용 |
| --- | --- |
| `boards.json` | 메인 보드 사양, 핀별 기능(digital/analog/pwm/interrupt/I²C/SPI/UART), 통신 버스, 전기적 한계 |
| `modules.json` | 부품 정의: 핀(역할·필요 기능), 파라미터(LED 색상 등), 직렬 저항 규칙, 모터·드라이버·전원 사양, 코드 생성 방식, 전기적 사양과 신뢰도 |
| `power-supplies.json` | 전원 탭에 보여 줄 외부 전원 예시: 전압, 최대 전류, 용량. 전압·전류는 `external-power` 부품의 설정 값에 있어야 합니다 |

- 앱 시작 시 `frontend/src/data/validate.ts` 가 구조를 검증합니다. 잘못된 값(예: 없는 핀 기능, 존재하지 않는 핀 참조,
  중복 ID)이 있으면 오류 메시지와 함께 실행이 중단됩니다.
- 전기적 사양의 `confidence` 는 `official`(공식 사양) / `typical`(대표값) / `varies`(제품별 상이) 중 하나입니다.
  확인되지 않은 값을 `official` 로 적지 마세요.
- 보드의 선택 필드(`supplyPins`, `groundPins`, `gpioMaxInputVoltage`, `reservedPins`, `headers`, 핀 `restrictions`)와
  모듈 핀 필드(`direction`, `pull`, `highLevel`)는 [docs/esp32-board.md](../docs/esp32-board.md) 에 설명되어 있습니다.
  생략하면 기존 Arduino 보드와 같은 기본 동작을 합니다.
- 모터·드라이버·전원 필드(`motor`, `driver`, `regulator`, 핀의 `minVoltage`, `maxVoltage`, `typicalMa`, `peakMa`, `external`)는
  [docs/phase-4-motors-power.md](../docs/phase-4-motors-power.md) 에 설명되어 있습니다.
- 데이터를 수정한 뒤 `cd frontend && npm test` 로 검증 테스트를 실행하세요.
