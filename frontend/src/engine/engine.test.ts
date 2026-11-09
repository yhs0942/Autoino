import { describe, expect, it } from 'vitest'
import { getBoard } from '../data/boards'
import { circuitOf, circuitReducer, createInitialState, type CircuitAction, type CircuitState } from '../state/circuitState'
import type { Endpoint } from '../types'
import { autoAssign } from './autoAssign'
import { boardPinFor } from './connections'
import { bomCsv, buildBom, buildPinTable } from './exporters'
import { parseProjectFile, ProjectFileError, toProjectFile } from './project'
import { toProjectData } from '../state/circuitState'
import { validateCircuit } from './validate'

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) => actions.reduce(circuitReducer, state)
const add = (moduleId: string): CircuitAction => ({ type: 'addModule', moduleId })
const mod = (instanceId: string, pinId: string): Endpoint => ({ kind: 'module', instanceId, pinId })
const pin = (pinId: string): Endpoint => ({ kind: 'board', boardInstanceId: 'board-1', pinId })
const issuesOf = (s: CircuitState) => validateCircuit(circuitOf(s))
const assigned = (s: CircuitState, instanceId: string, pinId: string) => boardPinFor(s.connections, instanceId, pinId)?.pinId ?? null

describe('자동 핀 배정', () => {
  it('모든 부품을 규칙에 맞게 연결하고 오류가 없다', () => {
    const s = run([add('led-5mm'), add('push-button'), add('hc-sr04'), add('sg90'), add('i2c-lcd-1602'), { type: 'autoAssign' }])
    const errors = issuesOf(s).filter((i) => i.severity === 'error')
    expect(errors).toEqual([])
    // LCD → I²C 버스 (Uno: A4/A5)
    expect(assigned(s, 'i2c-lcd-1602#5', 'sda')).toBe('A4')
    expect(assigned(s, 'i2c-lcd-1602#5', 'scl')).toBe('A5')
    // 전원/GND
    expect(assigned(s, 'hc-sr04#3', 'vcc')).toBe('5V')
    expect(assigned(s, 'hc-sr04#3', 'gnd')).toBe('GND')
    expect(assigned(s, 'push-button#2', 'pin1a')).toBe('GND')
    // LED 는 PWM 핀, Servo 사용 시 D9/D10 은 피한다
    const led = assigned(s, 'led-5mm#1', 'anode')!
    expect(getBoard('arduino-uno-r3').pwmPins).toContain(led)
    expect(['D9', 'D10']).not.toContain(led)
    // USB 시리얼 핀은 쓰지 않는다
    const used = s.connections.map((c) => (c.to.kind === 'board' ? c.to.pinId : ''))
    expect(used).not.toContain('D0')
    expect(used).not.toContain('D1')
  })

  it('GPIO 는 서로 겹치지 않고, I²C 는 여러 장치가 공유한다', () => {
    const s = run([add('i2c-lcd-1602'), add('i2c-lcd-1602'), add('hc-sr04'), add('hc-sr04'), { type: 'autoAssign' }])
    expect(assigned(s, 'i2c-lcd-1602#1', 'sda')).toBe('A4')
    expect(assigned(s, 'i2c-lcd-1602#2', 'sda')).toBe('A4')
    const signals = ['hc-sr04#3', 'hc-sr04#4'].flatMap((id) => [assigned(s, id, 'trig'), assigned(s, id, 'echo')])
    expect(new Set(signals).size).toBe(4)
    // 같은 기본 주소의 LCD 두 개 → 주소 충돌 경고
    expect(issuesOf(s).some((i) => i.message.includes('I²C 주소 충돌'))).toBe(true)
  })

  it('수동 연결을 유지하고, 충돌하는 연결만 재배치한다', () => {
    let s = run([
      add('led-5mm'),
      add('led-5mm'),
      { type: 'connect', from: mod('led-5mm#1', 'anode'), to: pin('D6') },
      { type: 'connect', from: mod('led-5mm#2', 'anode'), to: pin('D6') },
    ])
    expect(issuesOf(s).some((i) => i.severity === 'error' && i.message.includes('핀 충돌'))).toBe(true)
    s = circuitReducer(s, { type: 'autoAssign' })
    expect(assigned(s, 'led-5mm#1', 'anode')).toBe('D6')
    const moved = assigned(s, 'led-5mm#2', 'anode')
    expect(moved).not.toBe('D6')
    expect(moved).toBeTruthy()
    expect(issuesOf(s).filter((i) => i.severity === 'error')).toEqual([])
  })

  it('보드 변경 후 새 보드에 맞게 재배정한다 (Uno A4 → Mega D20)', () => {
    let s = run([add('i2c-lcd-1602'), { type: 'autoAssign' }, { type: 'setBoard', boardInstanceId: 'board-1', boardId: 'arduino-mega-2560' }])
    expect(issuesOf(s).some((i) => i.severity === 'error')).toBe(true) // Mega 의 A4 는 I²C 가 아님
    s = circuitReducer(s, { type: 'autoAssign' })
    expect(assigned(s, 'i2c-lcd-1602#1', 'sda')).toBe('D20')
    expect(assigned(s, 'i2c-lcd-1602#1', 'scl')).toBe('D21')
  })

  it('핀이 부족하면 실패를 보고한다', () => {
    const board = getBoard('arduino-nano')
    let s = run([{ type: 'setBoard', boardInstanceId: 'board-1', boardId: board.id }])
    for (let i = 0; i < 12; i++) s = circuitReducer(s, add('hc-sr04'))
    const result = autoAssign(circuitOf(s), 1)
    expect(result.failed.length).toBeGreaterThan(0)
  })
})

describe('전기적 검증', () => {
  it('잘못된 연결을 오류로 표시한다', () => {
    const s = run([
      add('i2c-lcd-1602'),
      add('hc-sr04'),
      { type: 'connect', from: mod('i2c-lcd-1602#1', 'sda'), to: pin('D7') },
      { type: 'connect', from: mod('i2c-lcd-1602#1', 'vcc'), to: pin('GND') },
      { type: 'connect', from: mod('hc-sr04#2', 'gnd'), to: pin('5V') },
      { type: 'connect', from: mod('hc-sr04#2', 'trig'), to: pin('5V') },
    ])
    const errors = issuesOf(s).filter((i) => i.severity === 'error').map((i) => i.message)
    expect(errors.some((m) => m.includes('I²C SDA'))).toBe(true)
    expect(errors.filter((m) => m.includes('단락')).length).toBe(2)
    expect(errors.some((m) => m.includes('신호 핀을 5V'))).toBe(true)
  })

  it('미연결 핀과 USB 시리얼 핀 사용을 경고한다', () => {
    const s = run([add('led-5mm'), { type: 'connect', from: mod('led-5mm#1', 'anode'), to: pin('D0') }])
    const warnings = issuesOf(s).filter((i) => i.severity === 'warning').map((i) => i.message)
    expect(warnings.some((m) => m.includes('캐소드') && m.includes('미연결'))).toBe(true)
    expect(warnings.some((m) => m.includes('USB 시리얼'))).toBe(true)
  })

  it('LED 애노드를 5V 에 연결하면 상시 점등 안내, 서보 5V 연결은 경고', () => {
    const s = run([
      add('led-5mm'),
      add('sg90'),
      { type: 'connect', from: mod('led-5mm#1', 'anode'), to: pin('5V') },
      { type: 'connect', from: mod('sg90#2', 'vcc'), to: pin('5V') },
    ])
    const issues = issuesOf(s)
    expect(issues.some((i) => i.severity === 'info' && i.message.includes('항상 켜져'))).toBe(true)
    expect(issues.some((i) => i.severity === 'warning' && i.message.includes('서보'))).toBe(true)
    expect(issues.some((i) => i.severity === 'error')).toBe(false)
  })

  it('3.3V 에 흰색 LED 는 전압 여유 부족 경고, 빨강은 경고 없음', () => {
    let s = run([add('led-5mm'), { type: 'connect', from: mod('led-5mm#1', 'anode'), to: pin('3.3V') }])
    const marginWarning = (st: CircuitState) => issuesOf(st).some((i) => i.message.includes('차이가 작아'))
    expect(marginWarning(s)).toBe(false)
    s = circuitReducer(s, { type: 'setParam', instanceId: 'led-5mm#1', paramId: 'color', value: 'white' })
    expect(marginWarning(s)).toBe(true)
  })

  it('Servo 사용 시 D9 의 LED PWM 제한을 경고한다 (Uno)', () => {
    const s = run([add('sg90'), add('led-5mm'), { type: 'connect', from: mod('led-5mm#2', 'anode'), to: pin('D9') }])
    expect(issuesOf(s).some((i) => i.message.includes('Servo 라이브러리'))).toBe(true)
  })
})

describe('연결 편집', () => {
  it('모듈 핀 하나에는 전선 하나: 새 연결이 기존 연결을 대체한다', () => {
    const s = run([
      add('led-5mm'),
      { type: 'connect', from: mod('led-5mm#1', 'anode'), to: pin('D5') },
      { type: 'connect', from: pin('D6'), to: mod('led-5mm#1', 'anode') },
    ])
    expect(s.connections).toHaveLength(1)
    expect(assigned(s, 'led-5mm#1', 'anode')).toBe('D6')
  })

  it('보드-보드, 같은 부품 내 연결은 거부한다', () => {
    const s = run([
      add('push-button'),
      { type: 'connect', from: pin('D2'), to: pin('GND') },
      { type: 'connect', from: mod('push-button#1', 'pin1a'), to: mod('push-button#1', 'pin2a') },
    ])
    expect(s.connections).toHaveLength(0)
  })

  it('부품 삭제 시 연결도 제거된다', () => {
    let s = run([add('hc-sr04'), add('led-5mm'), { type: 'autoAssign' }])
    s = circuitReducer(s, { type: 'removeModule', instanceId: 'hc-sr04#1' })
    expect(s.connections.every((c) => JSON.stringify(c).includes('led-5mm#2'))).toBe(true)
    expect(s.connections).toHaveLength(2)
  })
})

describe('저장 · 불러오기', () => {
  it('저장한 프로젝트를 그대로 복원한다', () => {
    const s = run([add('led-5mm'), add('i2c-lcd-1602'), { type: 'autoAssign' }, { type: 'setProjectName', name: '테스트' }])
    const text = JSON.stringify(toProjectFile(toProjectData(s)))
    const data = parseProjectFile(text)
    expect(data).toEqual(toProjectData(s))
    const restored = circuitReducer(createInitialState(), { type: 'loadProject', data })
    const next = circuitReducer(restored, add('led-5mm'))
    expect(next.placed[2].label).toBe('LED 2')
    expect(new Set(next.placed.map((p) => p.instanceId)).size).toBe(3)
  })

  it.each([
    ['not json', /JSON/],
    ['{"format":"other"}', /Autoino/],
    ['{"format":"autoino-project","version":99}', /버전/],
    ['{"format":"autoino-project","version":1,"boardId":"esp32","modules":[],"connections":[]}', /보드/],
    [
      '{"format":"autoino-project","version":1,"boardId":"arduino-uno-r3","modules":[],"connections":[{"id":"w1","from":{"kind":"module","instanceId":"x#1","pinId":"a"},"to":{"kind":"board","pinId":"D2"}}]}',
      /존재하지 않는 부품/,
    ],
  ])('잘못된 파일 거부: %s', (text, message) => {
    expect(() => parseProjectFile(text)).toThrow(ProjectFileError)
    expect(() => parseProjectFile(text)).toThrow(message)
  })
})

describe('내보내기', () => {
  it('BOM 에 부품 수량과 자동 선정 저항이 포함된다', () => {
    const s = run([add('led-5mm'), add('led-5mm'), add('hc-sr04'), { type: 'autoAssign' }])
    const bom = buildBom(circuitOf(s))
    expect(bom.find((r) => r.item === 'LED')?.quantity).toBe(2)
    expect(bom.find((r) => r.item === '저항')).toMatchObject({ spec: '330 Ω 1/4 W (E12)', quantity: 2 })
    const csv = bomCsv(circuitOf(s))
    expect(csv.startsWith('﻿품목,사양,수량,비고')).toBe(true)
  })

  it('핀 배정표에 모든 부품 핀이 나온다', () => {
    const s = run([add('push-button'), { type: 'autoAssign' }])
    const rows = buildPinTable(circuitOf(s))
    expect(rows).toHaveLength(4)
    expect(rows.find((r) => r.pinName === '1B')?.note).toContain('연결 불필요')
  })
})
