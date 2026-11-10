import { describe, expect, it } from 'vitest'
import { circuitOf, circuitReducer, createInitialState, type CircuitAction, type CircuitState } from '../../state/circuitState'
import type { Endpoint } from '../../types'
import { analyzePower } from '../power'
import { validateCircuit } from '../validate'
import { CodeRuntime } from './codeRuntime'
import type { ModuleView } from './runtime'

// 코드 시뮬레이션: 사용자가 쓴 스케치를 실행해 배선된 부품이 그 코드대로 움직이는지

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) => actions.reduce(circuitReducer, state)
const add = (moduleId: string): CircuitAction => ({ type: 'addModule', moduleId })
const mod = (instanceId: string, pinId: string): Endpoint => ({ kind: 'module', instanceId, pinId })
const bp = (pinId: string, board = 'board-1'): Endpoint => ({ kind: 'board', boardInstanceId: board, pinId })
const link = (a: Endpoint, b: Endpoint): CircuitAction => ({ type: 'connect', from: a, to: b })
const auto: CircuitAction = { type: 'autoAssign' }

function code(s: CircuitState, src: string | Record<string, string>) {
  const circuit = circuitOf(s)
  const sketches = typeof src === 'string' ? { 'board-1': src } : src
  return new CodeRuntime(circuit, { issues: validateCircuit(circuit), power: analyzePower(circuit) }, sketches)
}
const at = (r: CodeRuntime, ms: number) => {
  while (r.t < ms) r.step(Math.min(33, ms - r.t))
  return r
}
const view = <K extends ModuleView['kind']>(r: CodeRuntime, id: string, kind: K) => {
  const v = r.view().modules.get(id)!
  expect(v.kind).toBe(kind)
  return v as Extract<ModuleView, { kind: K }>
}
const monitor = (r: CodeRuntime) => r.serial.map((l) => l.text).join('\n')
const status = (r: CodeRuntime) => r.codeStatus()[0]

describe('코드 시뮬레이션: 출력', () => {
  const led = () => run([add('led-5mm'), link(mod('led-5mm#1', 'anode'), bp('D9')), auto])

  it('blink: 코드의 delay 대로 켜지고 꺼진다', () => {
    const r = code(led(), 'void setup(){ pinMode(9, OUTPUT); }\nvoid loop(){ digitalWrite(9, HIGH); delay(300); digitalWrite(9, LOW); delay(700); }')
    expect(status(r).state).toBe('running')
    expect(view(at(r, 150), 'led-5mm#1', 'led').on).toBe(true)
    expect(view(at(r, 500), 'led-5mm#1', 'led').on).toBe(false)
    expect(view(at(r, 1100), 'led-5mm#1', 'led').on).toBe(true)
  })

  it('analogWrite 는 밝기, 다른 핀을 쓰면 꺼진 채로 알려 준다', () => {
    const r = code(led(), 'void setup(){ pinMode(9, OUTPUT); analogWrite(9, 64); }\nvoid loop(){}')
    const v = view(at(r, 100), 'led-5mm#1', 'led')
    expect(v.on).toBe(true)
    expect(v.level).toBeCloseTo(64 / 255, 2)
    const wrong = code(led(), 'void setup(){ pinMode(8, OUTPUT); digitalWrite(8, HIGH); }\nvoid loop(){}')
    at(wrong, 1000)
    expect(view(wrong, 'led-5mm#1', 'led').on).toBe(false)
    expect(status(wrong).hints.join(' ')).toContain('LED 1')
    expect(status(wrong).hints.join(' ')).toContain('D8')
  })

  it('pinMode(OUTPUT) 을 빠뜨리면 풀업만 켜져 아주 흐리다', () => {
    const r = code(led(), 'void setup(){ digitalWrite(9, HIGH); }\nvoid loop(){}')
    const v = view(at(r, 100), 'led-5mm#1', 'led')
    expect(v.level).toBeLessThan(0.1)
    expect(status(r).warnings.map((w) => w.message).join(' ')).toContain('OUTPUT')
  })

  it('코드가 없는 보드의 부품은 이유를 보여 준다', () => {
    const r = code(led(), {})
    expect(view(at(r, 100), 'led-5mm#1', 'led').on).toBe(false)
    expect(r.codeStatus()[0].state).toBe('no-code')
  })
})

describe('코드 시뮬레이션: 입력', () => {
  it('INPUT_PULLUP 버튼을 누르면 LOW 가 되어 LED 가 켜진다', () => {
    const s = run([add('push-button'), add('led-5mm'), link(mod('push-button#1', 'pin2a'), bp('D2')), link(mod('led-5mm#2', 'anode'), bp('D9')), auto])
    const r = code(s, 'void setup(){ pinMode(2, INPUT_PULLUP); pinMode(9, OUTPUT); Serial.begin(9600); }\nvoid loop(){ bool down = digitalRead(2) == LOW; digitalWrite(9, down); }')
    expect(view(at(r, 100), 'led-5mm#2', 'led').on).toBe(false)
    r.setInput('push-button#1', { pressed: true })
    expect(view(at(r, 200), 'led-5mm#2', 'led').on).toBe(true)
    r.setInput('push-button#1', { pressed: false })
    expect(view(at(r, 300), 'led-5mm#2', 'led').on).toBe(false)
  })

  it('풀업 없이 INPUT 으로 읽으면 떠 있다고 알려 준다', () => {
    const s = run([add('push-button'), link(mod('push-button#1', 'pin2a'), bp('D2')), auto])
    const r = code(s, 'void setup(){ pinMode(2, INPUT); }\nvoid loop(){ digitalRead(2); delay(10); }')
    expect(view(at(r, 200), 'push-button#1', 'button').warn).toContain('INPUT_PULLUP')
  })

  it('가변저항 analogRead 는 손잡이 위치를 따른다', () => {
    const s = run([add('potentiometer'), auto])
    const r = code(s, 'void setup(){ Serial.begin(9600); }\nvoid loop(){ Serial.println(analogRead(A0)); delay(100); }')
    r.setInput('potentiometer#1', { value: 0.25 })
    at(r, 250)
    const last = Number(r.serial.at(-1)!.text)
    expect(last).toBeGreaterThan(240)
    expect(last).toBeLessThan(270)
  })

  it('HC-SR04: pulseIn 으로 잰 거리가 설정한 거리와 같다', () => {
    const s = run([add('hc-sr04'), auto])
    const r = code(
      s,
      `const int TRIG = ${2}; const int ECHO = 3;
void setup(){ Serial.begin(9600); pinMode(TRIG, OUTPUT); pinMode(ECHO, INPUT); }
void loop(){ digitalWrite(TRIG, LOW); delayMicroseconds(2); digitalWrite(TRIG, HIGH); delayMicroseconds(10); digitalWrite(TRIG, LOW);
  long d = pulseIn(ECHO, HIGH); Serial.println(d * 0.034 / 2); delay(200); }`,
    )
    const trig = s.connections.find((c) => c.from.kind === 'module' && c.from.pinId === 'trig')
    const echo = s.connections.find((c) => c.from.kind === 'module' && c.from.pinId === 'echo')
    // 자동 배정된 핀이 D2/D3 이 아니면 그 번호로 다시 만든다
    const pinNo = (e: Endpoint | undefined) => (e?.kind === 'board' ? Number(e.pinId.replace('D', '')) : -1)
    const rr = pinNo(trig?.to) === 2 && pinNo(echo?.to) === 3 ? r : code(s, `const int TRIG = ${pinNo(trig?.to)}; const int ECHO = ${pinNo(echo?.to)};
void setup(){ Serial.begin(9600); pinMode(TRIG, OUTPUT); pinMode(ECHO, INPUT); }
void loop(){ digitalWrite(TRIG, LOW); delayMicroseconds(2); digitalWrite(TRIG, HIGH); delayMicroseconds(10); digitalWrite(TRIG, LOW);
  long d = pulseIn(ECHO, HIGH); Serial.println(d * 0.034 / 2); delay(200); }`)
    rr.setInput('hc-sr04#1', { distance: 40 })
    at(rr, 700)
    const cm = Number(rr.serial.at(-1)!.text)
    expect(cm).toBeGreaterThan(38)
    expect(cm).toBeLessThan(42)
  })

  it('로터리 엔코더: 인터럽트로 센 값이 돌린 칸 수와 같다', () => {
    const s = run([add('rotary-encoder'), link(mod('rotary-encoder#1', 'clk'), bp('D2')), link(mod('rotary-encoder#1', 'dt'), bp('D4')), auto])
    const r = code(
      s,
      `volatile long pos = 0;
void onClk(){ if (digitalRead(4) != digitalRead(2)) pos++; else pos--; }
void setup(){ Serial.begin(9600); pinMode(2, INPUT); pinMode(4, INPUT); attachInterrupt(digitalPinToInterrupt(2), onClk, FALLING); }
void loop(){ static long shown = 0; if (pos != shown) { shown = pos; Serial.println(pos); } delay(5); }`,
    )
    at(r, 50)
    r.rotate('rotary-encoder#1', 1)
    r.rotate('rotary-encoder#1', 1)
    r.rotate('rotary-encoder#1', 1)
    at(r, 200)
    r.rotate('rotary-encoder#1', -1)
    at(r, 300)
    expect(monitor(r).split('\n').slice(-2)).toEqual(['3', '2'])
  })
})

describe('코드 시뮬레이션: 모터', () => {
  it('서보: write(45) 를 하면 그 각도로 (일정한 속도로) 돈다', () => {
    const s = run([add('sg90'), link(mod('sg90#1', 'signal'), bp('D9')), auto])
    const r = code(s, '#include <Servo.h>\nServo s;\nvoid setup(){ s.attach(9); s.write(45); }\nvoid loop(){}')
    const early = view(at(r, 40), 'sg90#1', 'servo').angle
    expect(early).toBeGreaterThan(45)
    expect(view(at(r, 600), 'sg90#1', 'servo').angle).toBe(45)
  })

  it('서보에 analogWrite 를 쓰면 움직이지 않고 이유를 알려 준다', () => {
    const s = run([add('sg90'), link(mod('sg90#1', 'signal'), bp('D9')), auto])
    const r = code(s, 'void setup(){ pinMode(9, OUTPUT); analogWrite(9, 128); }\nvoid loop(){}')
    const v = view(at(r, 300), 'sg90#1', 'servo')
    expect(v.jitter).toBe(true)
    expect(v.warn).toContain('Servo')
  })

  it('L298N: EN 에 PWM, IN1/IN2 로 방향', () => {
    const s = run([
      add('l298n'),
      add('dc-gear-tt'),
      { type: 'attachMotor', motorId: 'dc-gear-tt#2', driverId: 'l298n#1', route: 'direct' },
      { type: 'addModule', moduleId: 'external-power', autoConnect: true, near: 'l298n#1', route: 'direct' },
      link(mod('l298n#1', 'ena'), bp('D5')),
      link(mod('l298n#1', 'in1'), bp('D7')),
      link(mod('l298n#1', 'in2'), bp('D8')),
      auto,
    ])
    const r = code(s, 'void setup(){ pinMode(5, OUTPUT); pinMode(7, OUTPUT); pinMode(8, OUTPUT); }\nvoid loop(){ analogWrite(5, 200); digitalWrite(7, HIGH); digitalWrite(8, LOW); delay(1000); digitalWrite(7, LOW); digitalWrite(8, HIGH); delay(1000); }')
    const fwd = view(at(r, 500), 'dc-gear-tt#2', 'motor')
    expect(fwd.speed).toBeCloseTo(200 / 255, 2)
    expect(view(at(r, 1500), 'dc-gear-tt#2', 'motor').speed).toBeLessThan(0)
  })

  const stepperRig = () => run([add('uln2003'), add('stepper-28byj48'), { type: 'attachMotor', motorId: 'stepper-28byj48#2', driverId: 'uln2003#1', route: 'direct' }, ...['in1', 'in2', 'in3', 'in4'].map((p, i) => link(mod('uln2003#1', p), bp(`D${8 + i}`))), auto])

  it('28BYJ-48: Stepper(2048, IN1, IN3, IN2, IN4) 로 512 스텝이면 90°', () => {
    const r = code(stepperRig(), '#include <Stepper.h>\nStepper m(2048, 8, 10, 9, 11);\nvoid setup(){ m.setSpeed(10); m.step(512); }\nvoid loop(){}')
    const v = view(at(r, 4000), 'stepper-28byj48#2', 'stepper')
    expect(v.angle).toBeCloseTo(90, 0)
  })

  it('코일 순서를 틀리면 (IN1, IN2, IN3, IN4) 돌지 않고 떤다', () => {
    const r = code(stepperRig(), '#include <Stepper.h>\nStepper m(2048, 8, 9, 10, 11);\nvoid setup(){ m.setSpeed(10); }\nvoid loop(){ m.step(1); }')
    const v = view(at(r, 1500), 'stepper-28byj48#2', 'stepper')
    expect(Math.abs(v.angle) < 2 || Math.abs(v.angle - 360) < 2).toBe(true)
    expect(v.status).toContain('떨림')
  })

  it('A4988: STEP 펄스 200 개면 한 바퀴, DIR 로 방향', () => {
    const s = run([
      add('a4988'),
      add('stepper-nema17'),
      { type: 'attachMotor', motorId: 'stepper-nema17#2', driverId: 'a4988#1', route: 'direct' },
      { type: 'addModule', moduleId: 'external-power', autoConnect: true, near: 'a4988#1', route: 'direct' },
      link(mod('a4988#1', 'step'), bp('D3')),
      link(mod('a4988#1', 'dir'), bp('D4')),
      auto,
    ])
    const r = code(s, 'void setup(){ pinMode(3, OUTPUT); pinMode(4, OUTPUT); digitalWrite(4, HIGH); for (int i = 0; i < 50; i++) { digitalWrite(3, HIGH); delayMicroseconds(500); digitalWrite(3, LOW); delayMicroseconds(500); } }\nvoid loop(){}')
    expect(view(at(r, 500), 'stepper-nema17#2', 'stepper').angle).toBeCloseTo(90, 0)
  })
})

describe('코드 시뮬레이션: 라이브러리 장치', () => {
  it('I²C LCD: 글자가 보인다', () => {
    const s = run([add('i2c-lcd-1602'), auto])
    const r = code(s, '#include <Wire.h>\n#include <LiquidCrystal_I2C.h>\nLiquidCrystal_I2C lcd(0x27, 16, 2);\nvoid setup(){ lcd.init(); lcd.backlight(); lcd.setCursor(0, 0); lcd.print("Hello"); lcd.setCursor(3, 1); lcd.print(42); }\nvoid loop(){}')
    const v = view(at(r, 200), 'i2c-lcd-1602#1', 'lcd')
    expect(v.lines[0].startsWith('Hello')).toBe(true)
    expect(v.lines[1]).toBe('   42           ')
    expect(v.backlight).toBe(true)
  })

  it('LCD 주소가 틀리면 아무것도 안 보이고 경고한다', () => {
    const s = run([add('i2c-lcd-1602'), auto])
    const r = code(s, '#include <LiquidCrystal_I2C.h>\nLiquidCrystal_I2C lcd(0x3F, 16, 2);\nvoid setup(){ lcd.init(); lcd.print("Hi"); }\nvoid loop(){}')
    at(r, 200)
    expect(view(r, 'i2c-lcd-1602#1', 'lcd').lines[0].trim()).toBe('')
    expect(status(r).warnings.map((w) => w.message).join(' ')).toContain('0x3F')
  })

  it('NeoPixel: setPixelColor · show', () => {
    const s = run([add('neopixel-strip'), link(mod('neopixel-strip#1', 'din'), bp('D6')), auto])
    const r = code(s, '#include <Adafruit_NeoPixel.h>\nAdafruit_NeoPixel strip(8, 6, NEO_GRB + NEO_KHZ800);\nvoid setup(){ strip.begin(); strip.setPixelColor(0, strip.Color(255, 0, 0)); strip.setPixelColor(2, 0, 0, 255); strip.show(); }\nvoid loop(){}')
    const v = view(at(r, 100), 'neopixel-strip#1', 'pixels')
    expect(v.colors[0]).toBe('rgb(255, 0, 0)')
    expect(v.colors[1]).toBe('off')
    expect(v.colors[2]).toBe('rgb(0, 0, 255)')
  })

  it('DHT: 온도·습도 슬라이더 값을 읽는다', () => {
    const s = run([add('dht-sensor'), link(mod('dht-sensor#1', 'data'), bp('D2')), auto])
    const r = code(s, '#include <DHT.h>\nDHT dht(2, DHT11);\nvoid setup(){ Serial.begin(9600); dht.begin(); }\nvoid loop(){ Serial.println(dht.readTemperature()); delay(2000); }')
    r.setInput('dht-sensor#1', { temperature: 31 })
    at(r, 300)
    expect(r.serial.at(-1)!.text).toBe('31.00')
  })

  it('TM1637: showNumberDec 숫자가 세그먼트로', () => {
    const s = run([add('tm1637-display'), link(mod('tm1637-display#1', 'clk'), bp('D2')), link(mod('tm1637-display#1', 'dio'), bp('D3')), auto])
    const r = code(s, '#include <TM1637Display.h>\nTM1637Display d(2, 3);\nvoid setup(){ d.setBrightness(5); d.showNumberDec(42); }\nvoid loop(){}')
    expect(view(at(r, 100), 'tm1637-display#1', 'seg').text).toBe('  42')
  })

  it('MPU-6050: Wire 로 레지스터를 읽으면 기울기에 따른 값', () => {
    const s = run([add('mpu6050'), auto])
    const r = code(
      s,
      `#include <Wire.h>
void setup(){ Serial.begin(9600); Wire.begin(); Wire.beginTransmission(0x68); Wire.write(0x6B); Wire.write(0); Wire.endTransmission(); }
void loop(){ Wire.beginTransmission(0x68); Wire.write(0x3B); Wire.endTransmission(false); Wire.requestFrom(0x68, 2); int16_t ax = Wire.read() << 8 | Wire.read(); Serial.println(ax); delay(100); }`,
    )
    r.setInput('mpu6050#1', { tiltY: 30 })
    at(r, 250)
    expect(Number(r.serial.at(-1)!.text)).toBe(8192)
  })
})

describe('코드 시뮬레이션: 오류와 여러 보드', () => {
  it('컴파일 오류는 보드별로 줄 번호와 함께', () => {
    const r = code(run([]), 'void setup() {\n  int x = 5\n}\nvoid loop(){}')
    const st = status(r)
    expect(st.state).toBe('compile-error')
    expect(st.errors[0].line).toBe(2)
  })

  it('보드 두 개: 보드마다 다른 코드가 돈다', () => {
    const s = run([add('led-5mm'), link(mod('led-5mm#1', 'anode'), bp('D9')), { type: 'addBoard', boardId: 'arduino-uno-r3' }, { type: 'addModule', moduleId: 'led-5mm', hostBoardId: 'board-2' }, link(mod('led-5mm#2', 'anode'), bp('D9', 'board-2')), auto])
    const r = code(s, { 'board-1': 'void setup(){ pinMode(9, OUTPUT); digitalWrite(9, HIGH); }\nvoid loop(){}', 'board-2': 'void setup(){ pinMode(9, OUTPUT); }\nvoid loop(){}' })
    at(r, 100)
    expect(view(r, 'led-5mm#1', 'led').on).toBe(true)
    expect(view(r, 'led-5mm#2', 'led').on).toBe(false)
    expect(r.codeStatus().map((c) => c.state)).toEqual(['running', 'running'])
  })

  it('시리얼 모니터에서 보낸 글자를 코드가 읽는다', () => {
    const r = code(run([]), 'void setup(){ Serial.begin(9600); }\nvoid loop(){ if (Serial.available()) { String s = Serial.readStringUntil(\'\\n\'); Serial.print("got "); Serial.println(s); } }')
    at(r, 100)
    r.sendSerial('board-1', 'hello\n')
    at(r, 300)
    expect(monitor(r)).toContain('got hello')
  })
})
