import { describe, expect, it } from 'vitest'
import { circuitOf, circuitReducer, createInitialState, type CircuitAction, type CircuitState } from '../state/circuitState'
import type { Endpoint } from '../types'
import { buildSetupText, codePin, extractSketches, pastedSketches } from './setupText'
import { getBoard } from '../data/boards'

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) => actions.reduce(circuitReducer, state)
const add = (moduleId: string, hostBoardId?: string): CircuitAction => ({ type: 'addModule', moduleId, hostBoardId })
const mod = (instanceId: string, pinId: string): Endpoint => ({ kind: 'module', instanceId, pinId })
const bp = (pinId: string, board = 'board-1'): Endpoint => ({ kind: 'board', boardInstanceId: board, pinId })
const link = (a: Endpoint, b: Endpoint): CircuitAction => ({ type: 'connect', from: a, to: b })

describe('회로 설정 텍스트', () => {
  const s = run([
    add('led-5mm'),
    add('push-button'),
    add('sg90'),
    add('i2c-lcd-1602'),
    add('relay-1ch'),
    add('l298n'),
    add('dc-gear-tt'),
    { type: 'attachMotor', motorId: 'dc-gear-tt#7', driverId: 'l298n#6', route: 'direct' },
    add('external-power'),
    link(mod('led-5mm#1', 'anode'), bp('D9')),
    { type: 'autoAssign' },
  ])
  const text = buildSetupText(circuitOf(s))

  it('보드와 부품마다 핀 연결, 코드에서 쓰는 핀 번호, 직렬 저항', () => {
    expect(text).toContain('Arduino Uno R3')
    expect(text).toMatch(/LED 1 · 빨강/)
    expect(text).toMatch(/애노드 \(\+\) → D9 \(9\) · 직렬 저항 \d+ Ω/)
    expect(text).toContain('캐소드 (−) → GND')
    expect(text).toContain('SDA → A4')
  })

  it('부품의 성질: I²C 주소, LOW 에서 켜지는 릴레이, 모터가 물린 드라이버 채널', () => {
    expect(text).toMatch(/I²C LCD 1602 1 · I²C 주소 0x27/)
    expect(text).toMatch(/릴레이 모듈 \(1채널\) 1 · IN 이 LOW 일 때 켜짐/)
    expect(text).toMatch(/TT 기어드 모터 1 · L298N 모터 드라이버 1 의 모터 A 채널에 연결/)
  })

  it('외부 전원은 무엇에 전원을 주는지 적는다', () => {
    expect(text).toMatch(/외부 전원 1 · 12 V/)
    expect(text).toMatch(/\+ 출력 → L298N 모터 드라이버 1 12V/)
  })

  it('설정만 적는다: 코드 작성 요청·코드 요령·라이브러리 조건은 넣지 않는다', () => {
    for (const s of ['작성해', '너는', '만들고 싶은 동작', '지켜야 할 것', 'INPUT_PULLUP', '#include', '```', '라이브러리']) expect(text).not.toContain(s)
  })

  it('원하면 시뮬레이터에서 돌릴 조건(지원 라이브러리, 부품별 라이브러리)을 덧붙인다', () => {
    const sim = buildSetupText(circuitOf(s), { simulator: true })
    expect(sim).toContain(text.trimEnd())
    expect(sim).toContain('Autoino 시뮬레이터')
    expect(sim).toContain('Adafruit_NeoPixel')
    expect(sim).toMatch(/SG90 서보 모터 1 → Servo/)
    expect(sim).toMatch(/I²C LCD 1602 1 → LiquidCrystal_I2C/)
    expect(sim).toContain('Wi-Fi')
  })

  it('보드가 여러 개면 보드마다 부품을 나누고, 고른 보드의 부품만 적을 수 있다', () => {
    const m = run([add('led-5mm'), link(mod('led-5mm#1', 'anode'), bp('D9')), { type: 'addBoard', boardId: 'esp32-devkit-v1' }, add('sg90', 'board-2'), { type: 'autoAssign' }])
    const all = buildSetupText(circuitOf(m))
    expect(all).toContain('[보드 1 에 연결된 부품]')
    expect(all).toContain('[보드 2 에 연결된 부품]')
    expect(all).toMatch(/Signal \(주황\) → 보드 2 GPIO\d+ \(\d+\)/)
    const only2 = buildSetupText(circuitOf(m), { board: 'board-2' })
    expect(only2).toContain('[보드 2 에 연결된 부품]')
    expect(only2).not.toContain('LED 1')
    const sim = buildSetupText(circuitOf(m), { simulator: true })
    expect(sim).toContain('// 보드 1')
    expect(sim).toMatch(/SG90 서보 모터 1 → ESP32Servo/)
  })

  it('코드 번호: Uno D7 → 7, A0 → A0, ESP32 GPIO21 → 21', () => {
    expect(codePin(getBoard('arduino-uno-r3'), 'D7')).toBe('7')
    expect(codePin(getBoard('arduino-uno-r3'), 'A0')).toBe('A0')
    expect(codePin(getBoard('esp32-devkit-v1'), 'GPIO21')).toBe('21')
  })
})

describe('AI 답변에서 코드 꺼내기', () => {
  const boards = [
    { instanceId: 'board-1', label: '보드 1' },
    { instanceId: 'board-2', label: '보드 2' },
  ]

  it('코드 블록 하나 → 고른 보드', () => {
    const text = '여기 코드입니다:\n```cpp\nvoid setup() {}\nvoid loop() {}\n```\n설명…'
    expect(extractSketches(text, boards, 'board-2')).toEqual([{ board: 'board-2', code: 'void setup() {}\nvoid loop() {}\n' }])
  })

  it('보드 이름 주석이 있으면 그 보드로 (순서가 바뀌어도)', () => {
    const text = '```cpp\n// 보드 2 (ESP32)\nvoid setup() { Serial.begin(115200); }\nvoid loop() {}\n```\n\n```arduino\n// 보드 1\nvoid setup() {}\nvoid loop() {}\n```'
    const out = extractSketches(text, boards)
    expect(out.map((o) => o.board)).toEqual(['board-2', 'board-1'])
    expect(out[0].code).toContain('115200')
  })

  it('블록 위 제목으로도 찾고, 설명용 블록(bash 등)은 건너뛴다', () => {
    const text = '### 보드 2 코드\n```cpp\nvoid setup() {}\nvoid loop() {}\n```\n라이브러리 설치:\n```bash\narduino-cli lib install Servo\n```'
    expect(extractSketches(text, boards)).toEqual([{ board: 'board-2', code: 'void setup() {}\nvoid loop() {}\n' }])
  })
})

describe('편집기에 AI 답변 붙여 넣기', () => {
  const boards = [
    { instanceId: 'board-1', label: '보드 1' },
    { instanceId: 'board-2', label: '보드 2' },
  ]

  it('코드 블록(```)이 없는 글은 그대로 붙여 넣는다', () => {
    expect(pastedSketches('void setup() {}\nvoid loop() {}', boards, 'board-1')).toBeNull()
    expect(pastedSketches('digitalWrite(13, HIGH);', boards, 'board-1')).toBeNull()
  })

  it('답변 전체를 붙여 넣으면 설명은 빼고 코드만, 블록이 하나면 지금 보고 있는 보드에', () => {
    const answer = '좋아요! 아래 코드를 쓰세요.\n\n```cpp\n// 보드 2\nvoid setup() {}\nvoid loop() {}\n```\n\n설명: …'
    expect(pastedSketches(answer, boards, 'board-1')).toEqual([{ board: 'board-1', code: '// 보드 2\nvoid setup() {}\nvoid loop() {}\n' }])
  })

  it('보드마다 코드 블록이 있으면 보드 이름을 보고 나눠 넣는다', () => {
    const answer = '```cpp\n// 보드 1\nvoid setup() {}\nvoid loop() {}\n```\n```cpp\n// 보드 2\nvoid setup() { Serial.begin(9600); }\nvoid loop() {}\n```'
    const out = pastedSketches(answer, boards, 'board-2')!
    expect(out.map((o) => o.board)).toEqual(['board-1', 'board-2'])
    expect(out[1].code).toContain('9600')
  })

  it('코드가 없는 블록뿐이면 그대로 붙여 넣는다', () => {
    expect(pastedSketches('설치:\n```bash\narduino-cli lib install Servo\n```', boards, 'board-1')).toBeNull()
  })
})
