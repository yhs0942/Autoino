# ESP32 DevKit V1 보드 지원

보드 ID `esp32-devkit-v1` (ESP32-WROOM-32 모듈, 30핀 DOIT DevKit V1 배열). 정의는 `data/boards.json` 의 네 번째 항목이다.
기존 Arduino Uno R3 · Mega 2560 · Nano 항목은 변경하지 않았다.

## 반영한 데이터

| 항목 | 내용 |
| --- | --- |
| 노출 GPIO (25개) | 1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36(VP), 39(VN) |
| 출력 가능(PWM) | 위 25개 중 GPIO34–39 를 제외한 21개 (LEDC 는 출력 가능한 모든 GPIO 에 연결 가능) |
| ADC | ADC1: 36, 39, 32, 33, 34, 35 / ADC2: 4, 2, 15, 13, 12, 14, 27, 25, 26 (총 15개) |
| DAC | GPIO25, GPIO26 |
| 터치 | T0=4, T2=2, T3=15, T4=13, T5=12, T6=14, T7=27, T8=33, T9=32 (T1=GPIO0 은 헤더에 없음) |
| UART | UART0(USB 시리얼) TX 1 / RX 3, UART2 TX 17 / RX 16 (실크 TX2/RX2) |
| I²C | SDA 21 / SCL 22 (Arduino-ESP32 기본값) |
| SPI | VSPI SS 5 / MOSI 23 / MISO 19 / SCK 18 (Arduino 기본), HSPI SS 15 / MOSI 13 / MISO 12 / SCK 14 |
| 입력 전용 | GPIO34, 35, 36, 39 — 출력 불가, 내부 풀업/풀다운 없음 (`input-only`, `no-internal-pull`) |
| 스트래핑 | GPIO2, 5, 12(MTDI), 15(MTDO) (`strapping`). GPIO0 은 BOOT 버튼에 연결되어 헤더에 없으므로 예약 핀으로 기록 |
| 플래시 예약 | GPIO6–11 — 모듈 내부 SPI 플래시. `reservedPins` 에 기록하고 사용 가능한 핀 목록에는 넣지 않음 |
| 기타 제약 | JTAG(12–15), ADC2 와 Wi-Fi 동시 사용 불가, 내장 LED(GPIO2), GPIO36/39 인터럽트 주의 |
| 전원 | 3V3(3.3 V), VIN(5 V, USB 전원 시), GND 2개 |
| 논리 전압 | `logicVoltage: 3.3`, `gpioMaxInputVoltage: 3.6` |

## 대조한 자료

이 세션의 네트워크 정책상 espressif.com 은 접속할 수 없어, Espressif 의 GitHub 저장소 원문으로 대조했다.

- esp-idf `docs/en/api-reference/peripherals/gpio/esp32.inc`: GPIO 표(ADC 채널, DAC, GPI(34–39) 입력 전용·풀업 없음,
  GPIO6–11 플래시, GPIO16–17 은 PSRAM 탑재 모듈에서만 사용됨, JTAG 12–15, ADC2·Wi-Fi 제한, GPIO36/39 인터럽트 주의)
- esptool `docs/en/advanced-topics/boot-mode-selection.rst`: GPIO0·GPIO2 부팅 모드, GPIO12(MTDI) 플래시 전압, GPIO15(MTDO) 부트 로그
- arduino-esp32 `variants/doitESP32devkitV1/pins_arduino.h`: LED_BUILTIN=2, SDA/SCL, SS/MOSI/MISO/SCK, A0–A19, T0–T9, DAC1/2
- arduino-esp32 `cores/esp32/HardwareSerial.h`: UART0 1/3. **Serial2 기본 핀은 RX 4 / TX 25** 로, 보드 실크의 RX2/TX2(16/17)와 다르다.

## 확인되지 않은 부분 (데이터에 `typical`/`varies` 로 표시)

- 헤더 핀 순서: 일반적인 DOIT 30핀 배열 기준이다. 호환 보드마다 배열·실크 표기가 다를 수 있다.
- GPIO5 의 스트래핑 기능(SDIO 슬레이브 타이밍)은 ESP32 데이터시트의 Strapping Pins 표 내용이며, 위 GitHub 문서에는 없다.
- GPIO 최대 입력 3.6 V, 핀당 최대 약 40 mA, 전체 1200 mA 는 데이터시트 사본 기준이다 (공식 사이트 직접 확인 필요).
  Autoino 는 20 mA 를 핀당 권장 상한으로 검사한다.
- VIN 의 허용 입력 범위와 3V3 공급 가능 전류는 보드 레귤레이터에 따라 다르다.

## 데이터 구조 (3.3 V 로직 대응)

- 보드: `logicVoltage`, `gpioMaxInputVoltage`, `supplyPins`, `groundPins`, `reservedPins`, `headers`,
  핀별 `gpio`, `restrictions[] { kind, description }`, 핀 그룹 `control`(EN), 핀 기능 `dac`, `touch`
- 모듈 핀: `direction`(out/in/inout), `pull: 'up'`(내부 풀업 사용), `highLevel: 'supply'`(신호 HIGH = 부품 전원 전압)
- 새 필드는 모두 선택 항목이며, 없으면 기존 동작(5V/3.3V/GND, 제약 없음)과 같다.

## 동작 범위

- 자동 핀 배정: 출력 신호를 입력 전용 핀에 두지 않고, 스트래핑·USB 시리얼 핀은 피하며, 내부 풀업이 필요한 버튼은 풀업 없는 핀에 두지 않는다.
  5 V 부품 전원은 VIN, GND 는 GND 에 연결한다.
- 전기적 검사: 입력 전용 핀에 출력 신호(오류), 5 V 로 구동한 부품의 신호(`highLevel: 'supply'`)가 GPIO 최대 입력 전압을 넘음(오류),
  스트래핑 핀 사용·풀업 없는 핀에 버튼(경고), 내장 LED 핀(정보).
- 레벨 시프터·전압 분배기 회로를 자동으로 넣어 주지는 않는다 (안내만 표시).
- 보드 간 통신, ESP32 전용 라이브러리(ESP32Servo 등) 선택, 코드 생성은 구현되지 않았다.
