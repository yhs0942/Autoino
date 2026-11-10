import { getModule } from '../data/modules'
import type { Board, PlacedModule } from '../types'
import { boardKindOf } from './arduino/core'
import { SUPPORTED_LIBRARIES } from './arduino/libs'
import { boardDefOf, type Circuit } from './circuit'
import { endpointKey, isPinConnected, moduleEndpoint } from './connections'
import { isGroundPin, supplyPinOf } from './electrical'
import { motorDriverOf } from './motorAttach'
import { muxChannelOf, muxUsers } from './mux'
import { buildNetlist, type Netlist } from './netlist'
import { routeToBoard } from './paths'
import { netVoltage } from './power'
import { computeSeriesResistors, formatOhms } from './resistor'
import { computeLadderResistors, shareBoardPin, shareOf } from './shares'

// 다른 생성형 AI(ChatGPT·Gemini·Claude 등)에게 붙여 넣을 프롬프트.
// 지금 배선(보드·부품·핀·전원·보드 간 통신)을 그대로 설명하고, Autoino 시뮬레이터에서 실행할 수 있는 조건을 붙인다.

export interface PromptOptions {
  /** 만들고 싶은 동작 (사용자가 적은 글) */
  goal: string
  /** 코드를 만들 보드 (없으면 모든 보드) */
  board?: string
}

/** 코드에서 쓰는 핀 번호 (D7 → 7, A0 → A0, GPIO21 → 21) */
export function codePin(board: Board, pinId: string): string {
  if (boardKindOf(board.id) === 'esp32') return String(board.pins.find((p) => p.id === pinId)?.gpio ?? pinId.replace(/^GPIO/, ''))
  if (/^D\d+$/.test(pinId)) return pinId.slice(1)
  return pinId
}

interface Ctx {
  circuit: Circuit
  traced: Netlist
  netlist: Netlist
}

/** 부품 핀이 이어진 곳 (보드 핀 / GND / 전원 / 다른 부품) */
function describeEnd(ctx: Ctx, item: PlacedModule, pinId: string): { text: string; board?: string; pin?: string; code?: string } | null {
  const { circuit } = ctx
  if (!isPinConnected(circuit.connections, item.instanceId, pinId)) return null
  const route = routeToBoard(circuit, item.instanceId, pinId, ctx.traced)
  if (route) {
    const def = boardDefOf(circuit, route.boardInstanceId)!
    const label = circuit.boards.length > 1 ? `${circuit.boards.find((b) => b.instanceId === route.boardInstanceId)?.label} ` : ''
    if (isGroundPin(def, route.pinId)) return { text: `${label}GND` }
    const sp = supplyPinOf(def, route.pinId)
    if (sp) return { text: `${label}${route.pinId} (${sp.voltage} V 전원)` }
    const via = route.via.length ? ` (${route.via.join(', ')} 경유)` : ''
    const code = codePin(def, route.pinId)
    return { text: `${label}${route.pinId} — 코드 번호 ${code}${via}`, board: route.boardInstanceId, pin: route.pinId, code }
  }
  const ch = muxChannelOf(circuit, endpointKey(moduleEndpoint(item.instanceId, pinId)))
  if (ch) {
    const mux = circuit.placed.find((p) => p.instanceId === ch.muxId)!
    return { text: `${mux.label} 채널 C${ch.channel}` }
  }
  const key = endpointKey(moduleEndpoint(item.instanceId, pinId))
  const members = ctx.netlist.members.get(ctx.netlist.netOf(key)) ?? []
  const v = netVoltage(circuit, ctx.netlist, key)
  if (v !== null) {
    // 어느 전원에서 오는지 (외부 전원 1 + 출력 등)
    const source = members
      .map((k) => k.split(':'))
      .filter(([kind]) => kind === 'module')
      .map(([, id, pin]) => circuit.placed.find((p) => p.instanceId === id && getModule(p.moduleId).pins.find((x) => x.id === pin)?.role === 'source'))
      .find((p) => p && p !== item)
    return { text: source ? `${source.label} 출력 (${v} V)` : `${v} V 전원` }
  }
  const others = members.filter((k) => k !== key && k.startsWith('module:')).map((k) => {
    const [, id, pin] = k.split(':')
    const it = circuit.placed.find((p) => p.instanceId === id)
    const m = it && getModule(it.moduleId)
    return it && m ? `${it.label} ${m.pins.find((p) => p.id === pin)?.name ?? pin}` : k
  })
  if (members.some((k) => k.startsWith('board:') && /:GND/.test(k))) return { text: 'GND' }
  return { text: others.length ? others.join(', ') : '다른 부품' }
}

/** 부품별로 코드를 쓸 때 알아야 할 점 */
function tips(ctx: Ctx, item: PlacedModule, pins: Record<string, string | undefined>, board: Board | undefined): string[] {
  const esp = board ? boardKindOf(board.id) === 'esp32' : false
  const adcMax = esp ? 4095 : 1023
  const p = (id: string) => pins[id] ?? '?'
  const servoLib = esp ? 'ESP32Servo.h' : 'Servo.h'
  switch (item.moduleId) {
    case 'led-5mm':
      return ['애노드 핀을 HIGH 로 하면 켜짐 (analogWrite 로 밝기 조절은 PWM 핀만)']
    case 'push-button':
      return [`pinMode(${Object.values(pins).find(Boolean) ?? '핀'}, INPUT_PULLUP) — 누르면 LOW, 떼면 HIGH. 떨림(채터링)을 막으려면 20~50 ms 디바운스`]
    case 'relay-1ch':
      return ['IN 을 LOW 로 하면 릴레이가 붙음 (LOW 에서 켜지는 모듈). 시작할 때 HIGH 로 두어 꺼 두기']
    case 'active-buzzer':
      return ['SIG 를 HIGH 로 하면 소리 (능동 부저: tone() 없이 digitalWrite 로 충분)']
    case 'sg90':
    case 'mg90s':
    case 'mg996r':
      return [`#include <${servoLib}> → Servo s; s.attach(${p('signal')}); s.write(0~180)`]
    case 'fs90r':
      return [`연속 회전 서보: #include <${servoLib}>, write(90) 정지 · 90 보다 크면 정방향 · 작으면 역방향 (각도가 아니라 속도)`]
    case 'hc-sr04':
      return [`TRIG(${p('trig')}) 에 10 µs HIGH 펄스 → pulseIn(ECHO(${p('echo')}), HIGH, 30000) 의 µs × 0.0343 / 2 = cm (또는 NewPing 라이브러리)`]
    case 'i2c-lcd-1602':
      return ['#include <LiquidCrystal_I2C.h> → LiquidCrystal_I2C lcd(0x27, 16, 2); lcd.init(); lcd.backlight(); lcd.setCursor(열, 줄); lcd.print(…). 줄 바꿈은 println 대신 setCursor']
    case 'oled-ssd1306':
      return ['#include <Adafruit_SSD1306.h> → Adafruit_SSD1306 display(128, 64, &Wire, -1); display.begin(SSD1306_SWITCHCAPVCC, 0x3C); clearDisplay() → setCursor/print → display() 를 불러야 화면에 나옴']
    case 'neopixel-strip':
      return [`#include <Adafruit_NeoPixel.h> → Adafruit_NeoPixel strip(${item.params.count ?? '8'}, ${p('din')}, NEO_GRB + NEO_KHZ800); strip.begin(); setPixelColor → show(). 전류를 줄이려면 setBrightness(40) 정도`]
    case 'tm1637-display':
      return [`#include <TM1637Display.h> → TM1637Display seg(${p('clk')}, ${p('dio')}); seg.setBrightness(5); seg.showNumberDec(값)`]
    case 'dht-sensor':
      return [`#include <DHT.h> → DHT dht(${p('data')}, ${item.params.model === 'DHT22' ? 'DHT22' : 'DHT11'}); dht.begin(); readTemperature()/readHumidity() — 2초에 한 번만 읽기, 실패하면 NaN (isnan 으로 확인)`]
    case 'potentiometer':
      return [`analogRead → 0~${adcMax} (손잡이 위치)`]
    case 'ldr-module':
      return [`AO analogRead → 어두울수록 값이 큼 (0~${adcMax}). DO 는 어두우면 HIGH`]
    case 'soil-moisture':
      return [`AO analogRead → 마를수록 값이 큼 (0~${adcMax}). DO 는 마르면 HIGH`]
    case 'mq2-gas':
      return [`AO analogRead → 가스가 많을수록 값이 큼 (0~${adcMax}). 켠 뒤 20초쯤 예열. DO 는 가스가 많으면 LOW`]
    case 'joystick-ky023':
      return [`VRx·VRy analogRead → 가운데 약 ${Math.round(adcMax / 2)}, 끝 0 / ${adcMax}. SW 는 INPUT_PULLUP, 누르면 LOW`]
    case 'rotary-encoder':
      return ['CLK·DT 는 모듈에 풀업이 있음 (INPUT). CLK 가 바뀔 때 DT 와 다르면 시계 방향. SW 는 INPUT_PULLUP, 누르면 LOW. 놓치지 않으려면 CLK 에 attachInterrupt']
    case 'pir-hc-sr501':
      return ['OUT 이 HIGH 면 움직임 감지 (감지 후 몇 초 HIGH 유지). pinMode(INPUT)']
    case 'line-tracker':
      return ['DO 가 HIGH 면 검은 선 위, LOW 면 흰 바닥']
    case 'mpu6050':
      return ['I²C 주소 0x68. #include <Adafruit_MPU6050.h> (mpu.begin(); getEvent(&a, &g, &temp)) 또는 Wire 로 0x6B=0 (깨우기) 후 0x3B 부터 가속도 읽기']
    case 'hc-05':
      return [`기본 9600 baud. ${esp ? 'Serial2.begin(9600, SERIAL_8N1, RX, TX)' : 'SoftwareSerial bt(RX, TX)'} — 모듈 TXD 가 보드 RX, 모듈 RXD 가 보드 TX`]
    case 'rc522-rfid':
      return [`#include <SPI.h> <MFRC522.h> → MFRC522 rfid(${p('sda')}, ${p('rst')}); SPI.begin(); rfid.PCD_Init(); PICC_IsNewCardPresent() && PICC_ReadCardSerial() 이면 rfid.uid.uidByte[0..size-1]`]
    case 'pca9685':
      return ['I²C 주소 0x40. #include <Adafruit_PWMServoDriver.h> → pwm.begin(); pwm.setOscillatorFrequency(27000000); pwm.setPWMFreq(50); 서보는 pwm.writeMicroseconds(채널, 500~2400)']
    case 'cd74hc4067': {
      const spec = getModule(item.moduleId).mux!
      const users = muxUsers(ctx.circuit, item.instanceId)
      return [`S0~S3 (${spec.select.map((s) => p(s)).join(', ')}) 로 채널 번호를 2진수로 고른 뒤 SIG(${p(spec.common)}) 를 analogRead. 채널: ${users.map((u) => `C${u.channel} = ${ctx.circuit.placed.find((x) => u.key.startsWith(`module:${x.instanceId}:`))?.label}`).join(', ') || '없음'}`]
    }
    case 'level-shifter-4ch':
    case 'voltage-divider':
      return ['신호를 그대로 전달하는 부품이라 코드가 필요 없음']
  }
  const module = getModule(item.moduleId)
  if (module.driver) return driverTips(ctx, item, pins)
  return []
}

function driverTips(ctx: Ctx, item: PlacedModule, pins: Record<string, string | undefined>): string[] {
  const module = getModule(item.moduleId)
  const motors = ctx.circuit.placed.filter((m) => motorDriverOf(ctx.circuit, m)?.driver === item)
  const names = motors.map((m) => m.label).join(', ')
  const p = (id: string) => pins[id] ?? '?'
  switch (module.code?.template) {
    case 'h-bridge':
      return module.code.scheme === 'en-in1-in2'
        ? [`모터(${names || '없음'}): EN 핀 analogWrite(0~255) = 속도, IN1·IN2 = 방향 (HIGH/LOW 정방향, LOW/HIGH 역방향, 둘 다 LOW 정지)`]
        : [`모터(${names || '없음'}): 두 입력 중 하나를 analogWrite(속도), 다른 하나 LOW → 방향. 둘 다 LOW 면 정지${module.code.standbyPin ? `. ${module.code.standbyPin.toUpperCase()} 는 HIGH 로` : ''}`]
    case 'stepper-coils':
      return [`28BYJ-48: #include <Stepper.h> → Stepper motor(2048, ${p('in1')}, ${p('in3')}, ${p('in2')}, ${p('in4')}); (순서 IN1, IN3, IN2, IN4 주의) setSpeed(10) 이하`]
    case 'step-dir':
      return [`STEP(${p('step')}) 에 펄스 하나 = 한 스텝 (200 스텝 = 한 바퀴), DIR(${p('dir')}) HIGH/LOW 로 방향. #include <AccelStepper.h> → AccelStepper st(AccelStepper::DRIVER, ${p('step')}, ${p('dir')}) 도 가능`]
    case 'esc':
      return [`#include <Servo.h> → esc.attach(${p('sig')}); 처음 2초 동안 writeMicroseconds(1000) 으로 시동(arming) 후 1000~2000 으로 속도`]
  }
  return []
}

function boardSummary(board: Board): string[] {
  const kind = boardKindOf(board.id)
  const esp = kind === 'esp32'
  const pin = (ids: string[]) => ids.map((id) => codePin(board, id)).join(', ')
  const i2c = board.buses.find((b) => b.kind === 'I2C')
  const spi = board.buses.find((b) => b.kind === 'SPI')
  const uarts = board.buses.filter((b) => b.kind === 'UART').map((b) => `${b.name.split(' ')[0]}(${b.pins.map((p) => `${p.role} ${codePin(board, p.pinId)}`).join(', ')})`)
  return [
    `${board.name} (${board.microcontroller}, ${board.clockSpeed}, ${board.logicVoltage} V 로직, ${board.core} 코어)`,
    `PWM 핀: ${esp ? '대부분의 출력 핀 (analogWrite 또는 ledc)' : pin(board.pwmPins)} · 외부 인터럽트: ${esp ? '모든 GPIO' : pin(board.interruptPins)}`,
    i2c ? `I²C: SDA ${codePin(board, i2c.pins.find((p) => p.role === 'SDA')!.pinId)}, SCL ${codePin(board, i2c.pins.find((p) => p.role === 'SCL')!.pinId)}` : '',
    spi ? `SPI: ${spi.pins.map((p) => `${p.role} ${codePin(board, p.pinId)}`).join(', ')}` : '',
    `UART: ${uarts.join(' · ')}`,
    esp ? 'int 32비트, analogRead 0~4095 (12비트), Servo 는 ESP32Servo 라이브러리' : 'int 16비트 (32767 넘으면 long), double = float, analogRead 0~1023, sprintf 의 %f 는 지원 안 됨 (dtostrf 사용)',
  ].filter(Boolean)
}

/** 보드에 연결된 (또는 그 보드가 제어하는) 부품 */
function modulesOf(circuit: Circuit, traced: Netlist, boardId: string | undefined): PlacedModule[] {
  if (!boardId) return circuit.placed
  return circuit.placed.filter((item) => {
    const module = getModule(item.moduleId)
    const routes = module.pins.filter((p) => p.role === 'signal').map((p) => routeToBoard(circuit, item.instanceId, p.id, traced)?.boardInstanceId)
    if (routes.some((b) => b === boardId)) return true
    if (routes.some((b) => b)) return false
    const link = module.motor ? motorDriverOf(circuit, item) : null
    if (link) return modulesOf(circuit, traced, boardId).includes(link.driver)
    return item.hostBoardId === boardId
  })
}

export function buildAiPrompt(circuit: Circuit, options: PromptOptions): string {
  const traced = buildNetlist(circuit, { passThrough: true })
  const netlist = buildNetlist(circuit)
  const ctx: Ctx = { circuit, traced, netlist }
  const targets = options.board ? circuit.boards.filter((b) => b.instanceId === options.board) : circuit.boards
  const multi = circuit.boards.length > 1
  const resistors = computeSeriesResistors(circuit)
  const ladder = computeLadderResistors(circuit)
  const out: string[] = []
  const goal = options.goal.trim()

  out.push('# Arduino 스케치 작성 요청', '')
  out.push(`너는 Arduino 펌웨어 개발자야. 아래 회로에 그대로 맞는 Arduino 스케치를 ${targets.length > 1 ? `보드마다 하나씩(${targets.length}개)` : '하나'} 작성해 줘.`)
  out.push('배선은 이미 끝났으니 핀 번호를 바꾸지 말고, 이 회로를 미리 시뮬레이션해 볼 수 있도록 아래 "지켜야 할 것"을 따라 줘.', '')
  out.push('## 만들고 싶은 동작', goal || '(여기에 원하는 동작을 적어 주세요. 예: 버튼을 누를 때마다 LED 가 켜졌다 꺼지고, 서보가 0° ↔ 90° 로 움직인다)', '')

  out.push('## 보드')
  for (const b of circuit.boards) {
    const def = boardDefOf(circuit, b.instanceId)!
    const [first, ...rest] = boardSummary(def)
    const mark = targets.includes(b) ? '' : ' — 이번에 코드를 쓰지 않는 보드'
    out.push(`- ${multi ? `${b.label}: ` : ''}${first}${mark}`)
    for (const r of rest) out.push(`  - ${r}`)
  }
  out.push('')

  for (const b of targets) {
    const def = boardDefOf(circuit, b.instanceId)!
    const items = modulesOf(circuit, traced, multi ? b.instanceId : undefined)
    out.push(`## ${multi ? `${b.label}에 ` : ''}연결된 부품과 배선`)
    if (!items.length) out.push('- (연결된 부품 없음)')
    for (const item of items) {
      const module = getModule(item.moduleId)
      const param = module.parameters?.filter((pp) => pp.bom || pp.id === 'color' || pp.id === 'model' || pp.id === 'count').map((pp) => pp.options.find((o) => o.value === item.params[pp.id])?.label).filter(Boolean)
      out.push(`### ${item.label} — ${module.name}${param?.length ? ` (${param.join(', ')})` : ''}`)
      const pins: Record<string, string | undefined> = {}
      for (const pin of module.pins) {
        const end = describeEnd(ctx, item, pin.id)
        if (!end) continue
        if (end.code) pins[pin.id] = end.code
        const notes: string[] = []
        const res = resistors.find((r) => r.instanceId === item.instanceId && r.pinId === pin.id)
        if (res?.status === 'ok') notes.push(`직렬 저항 ${formatOhms(res.choice.standardOhms)}`)
        const rung = ladder.find((r) => r.instanceId === item.instanceId && r.pinId === pin.id)
        if (rung) notes.push(`저항 사다리 (${rung.ohms ? formatOhms(rung.ohms) : '저항 없이'}) — 한 아날로그 핀으로 버튼 여러 개를 analogRead 값으로 구분`)
        const share = shareOf(circuit, endpointKey(moduleEndpoint(item.instanceId, pin.id)))
        if (share && end.pin && shareBoardPin(circuit, share)?.pinId === end.pin && !rung) notes.push(`핀 공유: ${share.members.length}개 부품이 같은 핀을 씀 (같이 켜지고 같은 신호를 받음)`)
        out.push(`- ${pin.name} → ${end.text}${notes.length ? ` · ${notes.join(' · ')}` : ''}`)
      }
      if (module.motor) {
        const link = motorDriverOf(circuit, item)
        out.push(`- ${link ? `${link.driver.label} 의 ${link.channel.label} 채널에 연결 (드라이버로 제어)` : '드라이버에 연결되지 않음'}`)
      }
      for (const tip of tips(ctx, item, pins, def)) out.push(`- 코드: ${tip}`)
    }
    out.push('')
  }

  // 전원
  const supplies = circuit.placed.filter((p) => ['external-power', 'buck-lm2596', 'mb102-power'].includes(p.moduleId))
  if (supplies.length) {
    out.push('## 외부 전원')
    for (const s of supplies) {
      const module = getModule(s.moduleId)
      const src = module.pins.find((pin) => pin.role === 'source')
      const v = src ? netVoltage(circuit, netlist, endpointKey(moduleEndpoint(s.instanceId, src.id))) : null
      out.push(`- ${s.label}: ${v !== null ? `${v} V` : '전압 미정'} → 모터·드라이버 전원 (코드와 상관없음, GND 는 보드와 공통)`)
    }
    out.push('')
  }

  // 보드 간 통신
  if (multi && circuit.links.length) {
    out.push('## 보드 간 통신')
    for (const l of circuit.links) {
      const label = (id: string) => circuit.boards.find((b) => b.instanceId === id)?.label ?? id
      const pins = (end: typeof l.a) => {
        const def = boardDefOf(circuit, end.boardInstanceId)
        return Object.entries(end.pins).map(([role, pin]) => `${role} ${def ? codePin(def, pin) : pin}`).join(', ')
      }
      out.push(`- ${label(l.a.boardInstanceId)} (${l.a.bus}: ${pins(l.a)}) ↔ ${label(l.b.boardInstanceId)} (${l.b.bus}: ${pins(l.b)}) · ${l.protocol}${l.baud ? ` ${l.baud} baud` : ''}${l.i2cAddress ? ` · 주변장치 주소 ${l.i2cAddress}` : ''}`)
    }
    out.push('')
  }

  const companion: Record<string, string> = { Adafruit_SSD1306: 'Adafruit_SSD1306(+Adafruit_GFX)', Adafruit_MPU6050: 'Adafruit_MPU6050(+Adafruit_Sensor)', MFRC522: 'MFRC522(+SPI)' }
  const libs = SUPPORTED_LIBRARIES()
    .filter((h) => !h.startsWith('avr/') && h !== 'DHT_U.h')
    .map((h) => h.replace(/\.h$/, ''))
    .map((h) => companion[h] ?? h)
  out.push('## 지켜야 할 것')
  out.push(
    `1. 결과는 \`\`\`cpp 코드 블록${targets.length > 1 ? `을 보드마다 하나씩 (블록 첫 줄에 \`// ${targets.map((b) => b.label).join('`, `// ')}\` 처럼 보드 이름 주석)` : ' 하나'}로 주고, 블록 밖 설명은 짧게.`,
    '2. 위 표의 핀 번호를 const 상수(예: const int LED_PIN = 9;)로 정의해서 써 줘. 배선을 바꾸라고 하지 말 것.',
    `3. 라이브러리는 이 중에서만 골라 줘: ${libs.join(', ')} (그 밖의 라이브러리는 쓰지 말 것).`,
    '4. Wi-Fi·인터넷·ESP32 내장 블루투스, 동적 메모리(new·malloc), 사용자 정의 class·템플릿·람다는 쓰지 말 것 (함수·전역 변수·struct·enum·배열은 괜찮음).',
    '5. 여러 동작을 동시에 해야 하면 긴 delay() 대신 millis() 로 시간을 재 줘.',
    '6. setup() 에서 Serial.begin(115200) 하고, 중요한 상태를 시리얼 모니터에 출력해 줘.',
    '7. 주석은 한국어로 짧게.',
  )
  return out.join('\n')
}

// ------------------------------------------------------------ AI 답변에서 코드 꺼내기

export interface ExtractedSketch {
  board: string
  code: string
}

/** AI 답변(마크다운)에서 코드 블록을 꺼내 보드에 나눠 준다 */
export function extractSketches(text: string, boards: { instanceId: string; label: string }[], preferred?: string): ExtractedSketch[] {
  const blocks: { code: string; before: string }[] = []
  const re = /```[ \t]*([\w+#-]*)[^\n]*\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  let last = 0
  while ((m = re.exec(text))) {
    const lang = m[1].toLowerCase()
    const code = m[2]
    if (lang && !['cpp', 'c++', 'c', 'arduino', 'ino', 'cc', 'h'].includes(lang) && !/void\s+setup\s*\(/.test(code)) {
      last = re.lastIndex
      continue
    }
    blocks.push({ code: code.replace(/\s+$/, '\n'), before: text.slice(last, m.index) })
    last = re.lastIndex
  }
  if (!blocks.length) return /void\s+setup\s*\(/.test(text) ? [{ board: preferred ?? boards[0]?.instanceId ?? 'board-1', code: text.trim() + '\n' }] : []
  const sketches = blocks.filter((b) => /void\s+setup\s*\(/.test(b.code) || blocks.length === 1)
  const used = new Set<string>()
  const out: ExtractedSketch[] = []
  const findBoard = (s: string) => {
    // 길이가 긴 이름부터 (보드 10 이 보드 1 로 잡히지 않게)
    const sorted = [...boards].sort((a, b) => b.label.length - a.label.length)
    return sorted.find((b) => s.includes(b.label) || s.includes(b.instanceId))
  }
  for (const b of sketches) {
    const head = b.code.split('\n').slice(0, 3).join('\n')
    const tail = b.before.split('\n').slice(-3).join('\n')
    const hit = findBoard(head) ?? findBoard(tail)
    if (hit && !used.has(hit.instanceId)) {
      used.add(hit.instanceId)
      out.push({ board: hit.instanceId, code: b.code })
      continue
    }
    out.push({ board: '', code: b.code })
  }
  // 이름으로 못 찾은 블록: 고른 보드 → 남은 보드 순서대로
  const free = [preferred, ...boards.map((b) => b.instanceId)].filter((id): id is string => !!id && !used.has(id))
  for (const o of out) {
    if (o.board) continue
    const next = free.find((id) => !used.has(id))
    if (!next) continue
    o.board = next
    used.add(next)
  }
  return out.filter((o) => o.board)
}
