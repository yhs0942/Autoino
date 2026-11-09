import { describe, expect, it } from 'vitest'
import { getBoard } from '../data/boards'
import { circuitOf, circuitReducer, createInitialState, type CircuitAction, type CircuitState } from '../state/circuitState'
import type { Endpoint } from '../types'
import { boardPinFor } from './connections'
import { parseProjectFile, toProjectFile } from './project'
import { computeSeriesResistors } from './resistor'
import { toProjectData } from '../state/circuitState'
import { validateCircuit } from './validate'

const ESP = 'esp32-devkit-v1'
const run = (actions: CircuitAction[], state: CircuitState = createInitialState(ESP)) => actions.reduce(circuitReducer, state)
const add = (moduleId: string): CircuitAction => ({ type: 'addModule', moduleId })
const mod = (instanceId: string, pinId: string): Endpoint => ({ kind: 'module', instanceId, pinId })
const pin = (pinId: string): Endpoint => ({ kind: 'board', boardInstanceId: 'board-1', pinId })
const issuesOf = (s: CircuitState) => validateCircuit(circuitOf(s))
const errors = (s: CircuitState) => issuesOf(s).filter((i) => i.severity === 'error').map((i) => i.message)
const assigned = (s: CircuitState, instanceId: string, pinId: string) => boardPinFor(s.connections, instanceId, pinId)?.pinId ?? null

describe('ESP32 자동 핀 배정', () => {
  const s = run([add('led-5mm'), add('push-button'), add('hc-sr04'), add('sg90'), add('i2c-lcd-1602'), { type: 'autoAssign' }])
  // 부품이 더 많아 우선순위가 낮은 핀까지 내려가는 경우
  const many = run([add('led-5mm'), add('led-5mm'), add('push-button'), add('hc-sr04'), add('sg90'), add('i2c-lcd-1602'), add('led-5mm'), add('led-5mm'), { type: 'autoAssign' }])
  const esp = getBoard(ESP)
  const restrictionsOf = (id: string | null) => esp.pins.find((p) => p.id === id)?.restrictions?.map((r) => r.kind) ?? []

  it('출력 신호는 입력 전용 핀(GPIO34–39)에 배정하지 않는다', () => {
    for (const [id, p] of [['led-5mm#1', 'anode'], ['hc-sr04#3', 'trig'], ['sg90#4', 'signal']] as const)
      expect(restrictionsOf(assigned(s, id, p))).not.toContain('input-only')
  })

  it('스트래핑 핀과 USB 시리얼 핀은 사용하지 않는다 (부품이 많아도)', () => {
    for (const st of [s, many]) {
      const used = st.connections.map((c) => (c.to.kind === 'board' ? c.to.pinId : ''))
      for (const id of ['GPIO2', 'GPIO5', 'GPIO12', 'GPIO15', 'GPIO1', 'GPIO3']) expect(used).not.toContain(id)
    }
    expect(errors(many).filter((m) => !m.includes('GPIO 최대 입력 전압'))).toEqual([])
  })

  it('TX0(GPIO1) 에 직접 연결하면 USB 시리얼 경고', () => {
    const st = run([add('led-5mm'), { type: 'connect', from: mod('led-5mm#1', 'anode'), to: pin('GPIO1') }])
    expect(issuesOf(st).some((i) => i.severity === 'warning' && i.message.includes('USB 시리얼'))).toBe(true)
  })

  it('버튼(내부 풀업 사용)은 풀업이 없는 핀에 두지 않는다', () => {
    expect(restrictionsOf(assigned(s, 'push-button#2', 'pin2a'))).not.toContain('no-internal-pull')
  })

  it('I²C 는 GPIO21/22, 5 V 부품 전원은 VIN, GND 는 GND', () => {
    expect(assigned(s, 'i2c-lcd-1602#5', 'sda')).toBe('GPIO21')
    expect(assigned(s, 'i2c-lcd-1602#5', 'scl')).toBe('GPIO22')
    expect(assigned(s, 'hc-sr04#3', 'vcc')).toBe('VIN')
    expect(assigned(s, 'hc-sr04#3', 'gnd')).toBe('GND')
  })

  it('5 V 로 구동한 HC-SR04 Echo 와 I²C LCD 신호의 레벨 위험을 오류로 표시한다', () => {
    const e = errors(s)
    expect(e.filter((m) => m.includes('GPIO 최대 입력 전압'))).toHaveLength(3) // Echo, SDA, SCL
    expect(e.some((m) => m.includes('HC-SR04') && m.includes('Echo'))).toBe(true)
    // 그 밖의 오류는 없다 (입력 전용·충돌 등)
    expect(e.filter((m) => !m.includes('GPIO 최대 입력 전압'))).toEqual([])
  })

  it('LED 직렬 저항은 3.3 V 기준으로 계산한다 (빨강 10 mA → 150 Ω)', () => {
    const r = computeSeriesResistors(circuitOf(s)).find((x) => x.instanceId === 'led-5mm#1')!
    expect(r.status).toBe('ok')
    if (r.status === 'ok') {
      expect(r.choice.supplyVoltage).toBe(3.3)
      expect(r.choice.standardOhms).toBe(150)
    }
  })
})

describe('ESP32 전기적 검증', () => {
  it('입력 전용 핀에 출력 신호(Trig)를 연결하면 오류, 입력(Echo)은 허용', () => {
    const s = run([
      add('hc-sr04'),
      { type: 'connect', from: mod('hc-sr04#1', 'trig'), to: pin('GPIO34') },
      { type: 'connect', from: mod('hc-sr04#1', 'echo'), to: pin('GPIO35') },
      { type: 'connect', from: mod('hc-sr04#1', 'vcc'), to: pin('3V3') },
      { type: 'connect', from: mod('hc-sr04#1', 'gnd'), to: pin('GND2') },
    ])
    const e = errors(s)
    expect(e.some((m) => m.includes('입력 전용') && m.includes('Trig'))).toBe(true)
    expect(e.some((m) => m.includes('Echo'))).toBe(false)
    // 3.3 V 로 구동하면 레벨 오류는 없고, 5 V 부품을 3.3 V 에 연결했다는 경고가 나온다
    expect(e.some((m) => m.includes('GPIO 최대 입력 전압'))).toBe(false)
    expect(issuesOf(s).some((i) => i.severity === 'warning' && i.message.includes('5 V 부품을 3V3'))).toBe(true)
  })

  it('버튼을 풀업 없는 핀에 연결하면 외부 풀업 경고', () => {
    const s = run([add('push-button'), { type: 'connect', from: mod('push-button#1', 'pin2a'), to: pin('GPIO36') }])
    expect(issuesOf(s).some((i) => i.severity === 'warning' && i.message.includes('외부 풀업'))).toBe(true)
  })

  it('스트래핑 핀 사용 경고 (GPIO12)', () => {
    const s = run([add('led-5mm'), { type: 'connect', from: mod('led-5mm#1', 'anode'), to: pin('GPIO12') }])
    expect(issuesOf(s).some((i) => i.severity === 'warning' && i.message.includes('MTDI'))).toBe(true)
  })

  it('EN 핀은 GPIO 가 아니다', () => {
    const s = run([add('led-5mm'), { type: 'connect', from: mod('led-5mm#1', 'anode'), to: pin('EN') }])
    expect(errors(s).some((m) => m.includes('EN'))).toBe(true)
  })

  it('Uno 에서는 같은 배선에 레벨 오류가 없다 (기존 동작 유지)', () => {
    const s = run([add('hc-sr04'), add('i2c-lcd-1602'), { type: 'autoAssign' }], createInitialState('arduino-uno-r3'))
    expect(errors(s)).toEqual([])
  })
})

describe('보드 인스턴스', () => {
  it('보드를 바꿔도 인스턴스 ID·위치는 유지된다', () => {
    const s0 = createInitialState()
    const s = circuitReducer(s0, { type: 'setBoard', boardInstanceId: 'board-1', boardId: ESP })
    expect(s.boards[0]).toEqual({ ...s0.boards[0], boardId: ESP })
  })

  it('프로젝트 파일에 보드 인스턴스가 저장·복원되고, 버전 1 형식(board 하나)도 열린다', () => {
    const s = run([add('led-5mm'), { type: 'autoAssign' }])
    const file = toProjectFile(toProjectData(s))
    expect(file.boardId).toBe(ESP)
    expect(parseProjectFile(JSON.stringify(file)).boards).toEqual(s.boards)
    const v1 = {
      format: 'autoino-project',
      version: 1,
      name: 'old',
      boardId: ESP,
      board: { instanceId: 'board-1', boardId: ESP, x: 40, y: 40 },
      modules: [{ instanceId: 'led-5mm#1', moduleId: 'led-5mm', label: 'LED 1', x: 400, y: 40, params: {} }],
      connections: [{ id: 'w1', from: { kind: 'module', instanceId: 'led-5mm#1', pinId: 'anode' }, to: { kind: 'board', pinId: 'GPIO32' }, auto: true }],
    }
    const data = parseProjectFile(JSON.stringify(v1))
    expect(data.boards).toEqual([{ instanceId: 'board-1', boardId: ESP, label: '보드 1', x: 40, y: 40 }])
    expect(data.connections[0].to).toEqual({ kind: 'board', boardInstanceId: 'board-1', pinId: 'GPIO32' })
    expect(data.placed[0].hostBoardId).toBe('board-1')
  })
})
