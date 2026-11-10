import { describe, expect, it } from 'vitest'
import { circuitOf, circuitReducer, createInitialState, type CircuitAction, type CircuitState } from '../state/circuitState'
import type { Endpoint } from '../types'
import { buildAiPrompt, codePin, extractSketches } from './aiPrompt'
import { getBoard } from '../data/boards'

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) => actions.reduce(circuitReducer, state)
const add = (moduleId: string, hostBoardId?: string): CircuitAction => ({ type: 'addModule', moduleId, hostBoardId })
const mod = (instanceId: string, pinId: string): Endpoint => ({ kind: 'module', instanceId, pinId })
const bp = (pinId: string, board = 'board-1'): Endpoint => ({ kind: 'board', boardInstanceId: board, pinId })
const link = (a: Endpoint, b: Endpoint): CircuitAction => ({ type: 'connect', from: a, to: b })

describe('AI 프롬프트', () => {
  const s = run([
    add('led-5mm'),
    add('push-button'),
    add('sg90'),
    add('i2c-lcd-1602'),
    add('uln2003'),
    add('stepper-28byj48'),
    { type: 'attachMotor', motorId: 'stepper-28byj48#6', driverId: 'uln2003#5', route: 'direct' },
    link(mod('led-5mm#1', 'anode'), bp('D9')),
    { type: 'autoAssign' },
  ])
  const prompt = buildAiPrompt(circuitOf(s), { goal: '버튼을 누르면 LED 를 켜고 서보를 90도로' })

  it('만들 동작, 보드, 부품마다 핀과 코드 번호', () => {
    expect(prompt).toContain('버튼을 누르면 LED 를 켜고 서보를 90도로')
    expect(prompt).toContain('Arduino Uno R3')
    expect(prompt).toContain('애노드 (+) → D9 — 코드 번호 9')
    expect(prompt).toMatch(/캐소드 \(−\) → GND/)
    expect(prompt).toContain('INPUT_PULLUP')
    expect(prompt).toContain('LiquidCrystal_I2C lcd(0x27, 16, 2)')
  })

  it('실수하기 쉬운 점: 28BYJ-48 의 코일 순서, AVR 의 int 크기', () => {
    expect(prompt).toMatch(/Stepper motor\(2048, \d+, \d+, \d+, \d+\); \(순서 IN1, IN3, IN2, IN4 주의\)/)
    expect(prompt).toContain('int 16비트')
  })

  it('시뮬레이터에서 실행할 수 있는 조건 (라이브러리 목록, 코드 블록 형식)', () => {
    expect(prompt).toContain('```cpp 코드 블록 하나')
    expect(prompt).toContain('Adafruit_NeoPixel')
    expect(prompt).toContain('Wi-Fi')
  })

  it('보드가 여러 개면 보드마다 코드 블록과 보드 이름 주석을 요청하고, 고른 보드의 부품만', () => {
    const m = run([add('led-5mm'), link(mod('led-5mm#1', 'anode'), bp('D9')), { type: 'addBoard', boardId: 'esp32-devkit-v1' }, add('sg90', 'board-2'), { type: 'autoAssign' }])
    const all = buildAiPrompt(circuitOf(m), { goal: '' })
    expect(all).toContain('보드마다 하나씩')
    expect(all).toContain('// 보드 1')
    expect(all).toContain('ESP32Servo')
    const only2 = buildAiPrompt(circuitOf(m), { goal: '', board: 'board-2' })
    expect(only2).toContain('보드 2에 연결된 부품')
    expect(only2).not.toContain('### LED 1')
    expect(only2).toContain('이번에 코드를 쓰지 않는 보드')
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

  it('코드 블록 없이 코드만 붙여 넣어도 된다', () => {
    expect(extractSketches('void setup() {}\nvoid loop() {}', boards, 'board-1')[0].board).toBe('board-1')
    expect(extractSketches('그냥 설명만', boards)).toEqual([])
  })
})
