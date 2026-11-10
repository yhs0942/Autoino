// 부품별 시뮬레이션 동작 자료
//
// 실물이 동작할 때의 모습과 대표 수치를 정리했다. 수치는 흔한 제품의 대표값이며 제품마다 다르다.
// - rpm: 정격 전압(ratedVolts)에서 부하 없는 회전수. 실제 회전수는 (전원 − 드라이버 전압 강하) × PWM 비율로 줄여 계산한다.
// - stepsPerRev: 풀스텝 기준 한 바퀴 스텝 수 (28BYJ-48 은 감속비 약 1:64 로 2048 스텝)
// - defaults: 시뮬레이션을 시작할 때의 센서 입력 값 (사람이 카드에서 바꿀 수 있다)

export interface SimInput {
  /** 버튼·조이스틱·엔코더 스위치를 누르고 있음 */
  pressed?: boolean
  /** 가변저항 위치 0–1 */
  value?: number
  /** 조이스틱 −1 … 1 */
  x?: number
  y?: number
  /** 초음파 센서 앞 물체까지 거리 (cm) */
  distance?: number
  /** 온도 (°C), 습도 (%) */
  temperature?: number
  humidity?: number
  /** PIR 앞에서 움직임 */
  motion?: boolean
  /** 라인 센서가 검은 선 위에 있음 */
  onLine?: boolean
  /** IMU 기울기 (°) */
  tiltX?: number
  tiltY?: number
  /** 밝기·흙 수분·가스 농도 0–1 */
  light?: number
  moisture?: number
  gas?: number
  /** 블루투스 모듈에 휴대폰이 연결됨 */
  connected?: boolean
}

export interface Behavior {
  /** 실물이 동작하는 모습 (카드 설명) */
  looks: string
  defaults?: SimInput
  control?: 'value' | 'light' | 'moisture' | 'gas'
  rpm?: number
  ratedVolts?: number
  style?: 'wheel' | 'fan' | 'pump' | 'vibration' | 'prop'
  stepsPerRev?: number
  /** 펌프 유량 (L/분, 정격 전압) */
  flow?: number
  cardUid?: string
}

export const BEHAVIOR: Record<string, Behavior> = {
  'led-5mm': { looks: '애노드에 HIGH 가 들어오고 캐소드가 GND 에 이어지면 빛난다. PWM 이면 밝기가 듀티에 비례한다.' },
  'push-button': { looks: '누르는 동안 두 단자가 붙어 입력이 LOW 가 된다 (내부 풀업 사용).', defaults: { pressed: false } },
  'hc-sr04': { looks: 'TRIG 10 µs 펄스마다 40 kHz 초음파를 쏘고, 돌아온 시간만큼 ECHO 가 HIGH 가 된다. 2–400 cm, 넘으면 응답 없음.', defaults: { distance: 30 } },
  sg90: { looks: '50 Hz 펄스 폭(0.5–2.5 ms)에 맞춰 혼이 0°–180° 사이에서 돈다. 약 0.1 s/60° (4.8 V).' },
  mg90s: { looks: '금속 기어 소형 서보. 펄스 폭에 맞춰 혼이 돈다.' },
  mg996r: { looks: '토크가 큰 서보. 움직일 때 수백 mA–2.5 A 를 써서 USB 전원에서는 떨리거나 보드가 리셋되기 쉽다.' },
  fs90r: { looks: '연속 회전 서보: 1.5 ms 에서 멈추고, 길면 한쪽, 짧으면 반대쪽으로 계속 돈다.' },
  'i2c-lcd-1602': { looks: '16×2 글자 LCD. 백라이트가 켜지고 I²C 로 받은 글자를 보여 준다.' },
  'voltage-divider': { looks: '두 저항으로 입력 전압을 비율만큼 낮춘다 (OUT = IN × R2/(R1+R2)).' },
  'level-shifter-4ch': { looks: '채널마다 LV ↔ HV 쪽 신호를 같은 논리값으로 옮긴다.' },
  cd74hc4067: { looks: '선택선 S0–S3 이 가리키는 채널 하나만 SIG 에 이어진다. 코드는 채널을 바꿔 가며 차례로 읽는다.' },
  'external-power': { looks: '설정한 전압을 + 로 내보낸다. 용량을 넘으면 전압이 떨어진다.' },
  'buck-lm2596': { looks: '입력 전압을 설정한 출력 전압으로 낮춘다. 입력이 출력보다 약 1.5 V 이상 높아야 한다.' },
  'mb102-power': { looks: '브레드보드 레일에 5 V·3.3 V 를 공급하고 전원 LED 가 켜진다.' },
  'dc-motor-130': { looks: '고속(6 V 무부하 약 15,000 rpm) 소형 모터. 드라이버 출력 극성에 따라 회전 방향이 바뀐다.', rpm: 15000, ratedVolts: 6, style: 'fan' },
  'dc-gear-tt': { looks: '1:48 감속 모터. 6 V 무부하 약 200 rpm 으로 바퀴를 돌린다.', rpm: 200, ratedVolts: 6, style: 'wheel' },
  'dc-gear-n20': { looks: '소형 금속 감속 모터. 6 V 무부하 약 300 rpm (감속비에 따라 다름).', rpm: 300, ratedVolts: 6, style: 'wheel' },
  'dc-gear-25ga370': { looks: '12 V 감속 모터. 무부하 약 280 rpm (감속비에 따라 다름).', rpm: 280, ratedVolts: 12, style: 'wheel' },
  'vibration-motor': { looks: '코인형 진동 모터. 약 12,000 rpm 편심 추가 돌아 떨린다.', rpm: 12000, ratedVolts: 3, style: 'vibration' },
  'dc-pump-mini': { looks: '소형 수중 펌프. 5 V 에서 약 1.5 L/분 물을 퍼 올린다 (물 없이 돌리지 말 것).', rpm: 3000, ratedVolts: 5, style: 'pump', flow: 1.5 },
  'stepper-28byj48': { looks: '코일을 차례로 켜면 한 스텝씩 돈다. 감속비 약 1:64, 한 바퀴 약 2048 스텝, 최대 약 15 rpm.', stepsPerRev: 2048 },
  'stepper-nema17': { looks: '1.8° 스텝 모터 (200 스텝/바퀴). STEP 펄스마다 한 스텝, DIR 로 방향.', stepsPerRev: 200 },
  'bldc-a2212': { looks: '1000 KV 브러시리스 모터: 회전수 ≈ 1000 × 전압. ESC 스로틀이 최소이면 멈춰 있다.', rpm: 11100, ratedVolts: 11.1, style: 'prop' },
  l298n: { looks: 'IN1·IN2 로 방향, ENA 의 PWM 으로 속도를 정한다. 전원 LED 가 켜지고 약 2 V 전압 강하가 있다.' },
  tb6612fng: { looks: 'STBY 가 HIGH 일 때 AIN·BIN 으로 방향, PWMA·PWMB 로 속도를 정한다. 전압 강하가 작다.' },
  l9110s: { looks: '입력 두 개 중 PWM 이 들어간 쪽 방향으로 돈다.' },
  drv8833: { looks: '입력 두 개 중 PWM 이 들어간 쪽 방향으로 돈다. 저전압 모터에 알맞다.' },
  uln2003: { looks: 'IN1–IN4 가 HIGH 인 코일을 켜고 보드의 A–D LED 가 같이 켜진다.' },
  a4988: { looks: 'STEP 펄스마다 모터를 한 스텝 돌리고 DIR 로 방향을 바꾼다 (MS 핀이 비면 풀스텝).' },
  drv8825: { looks: 'STEP 펄스마다 한 스텝, DIR 로 방향. A4988 과 같은 배선.' },
  'esc-30a': { looks: '전원을 넣으면 삐 소리를 내고, 스로틀 최소(1 ms) 신호를 받으면 시동 준비가 된다.' },
  pca9685: { looks: 'I²C 명령으로 16채널 서보 펄스를 만든다. 전원 LED 가 켜진다.' },
  'relay-1ch': { looks: 'IN 이 LOW 면 코일이 붙어 찰칵 소리가 나고 LED 가 켜지며 COM–NO 가 이어진다.' },
  'active-buzzer': { looks: 'HIGH 를 주면 약 2.3 kHz 소리를 낸다.' },
  'neopixel-strip': { looks: '데이터 한 줄로 LED 마다 색을 정한다. 예시 코드는 파란 점 하나가 흐른다 (밝기 40/255).' },
  potentiometer: { looks: '손잡이를 돌리면 가운데 단자 전압이 0 V – VCC 로 바뀐다.', control: 'value', defaults: { value: 0.5 } },
  'joystick-ky023': { looks: '두 축 가변저항(가운데 약 512)과 누르는 스위치.', defaults: { x: 0, y: 0, pressed: false } },
  'rotary-encoder': { looks: '한 칸 돌릴 때마다 CLK·DT 가 어긋나게 바뀌어 방향을 알 수 있다 (한 바퀴 20칸).', defaults: { pressed: false } },
  'dht-sensor': { looks: '약 2초 간격으로 온도·습도를 디지털로 보낸다 (DHT11: 0–50 °C, 20–90 %).', defaults: { temperature: 24, humidity: 55 } },
  'pir-hc-sr501': { looks: '사람 움직임을 감지하면 OUT 이 HIGH 가 되고, 움직임이 멈춘 뒤에도 정한 시간(최소 약 3 s) 유지한다.', defaults: { motion: false } },
  'ldr-module': { looks: '밝을수록 AO 값이 작아진다. 기준보다 밝으면 DO 표시 LED 가 켜진다.', control: 'light', defaults: { light: 0.5 } },
  'soil-moisture': { looks: '흙이 젖을수록 AO 값이 작아진다. 기준보다 젖으면 DO 표시 LED 가 켜진다.', control: 'moisture', defaults: { moisture: 0.3 } },
  'mq2-gas': { looks: '가스(LPG·연기 등)가 많을수록 AO 값이 커진다. 히터 예열(수십 초 이상) 뒤에 값이 안정된다.', control: 'gas', defaults: { gas: 0 } },
  mpu6050: { looks: '기울이면 가속도 X·Y·Z 값이 바뀐다 (±2 g 에서 1 g = 16384).', defaults: { tiltX: 0, tiltY: 0 } },
  'line-tracker': { looks: '흰 바닥에 반사되면 OUT 이 LOW 가 되고 표시 LED 가 켜진다. 검은 선 위에서는 HIGH.', defaults: { onLine: false } },
  'oled-ssd1306': { looks: '128×64 OLED. I²C 로 받은 글자·그림을 보여 준다.' },
  'tm1637-display': { looks: '4자리 7세그먼트. CLK·DIO 로 받은 숫자를 보여 준다.' },
  'hc-05': { looks: '연결 전에는 LED 가 빠르게, 휴대폰과 연결되면 2초에 두 번 깜박인다. 받은 글자를 TXD 로 보낸다.', defaults: { connected: false } },
  'rc522-rfid': { looks: '13.56 MHz 카드를 대면 UID 를 읽는다.', cardUid: 'DE AD BE EF' },
}
