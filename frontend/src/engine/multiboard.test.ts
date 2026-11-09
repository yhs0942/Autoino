import { describe, expect, it } from 'vitest'
import { circuitOf, circuitReducer, createInitialState, type CircuitAction, type CircuitState } from '../state/circuitState'
import type { Endpoint } from '../types'
import { linkBusOptions, SOFTWARE_SERIAL } from './boardLinks'
import { boardPinFor } from './connections'
import { getBoard } from '../data/boards'
import { buildNetlist } from './netlist'
import { routeToBoard } from './paths'
import { buildPinTable } from './exporters'
import { validateCircuit } from './validate'

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) => actions.reduce(circuitReducer, state)
const add = (moduleId: string, hostBoardId?: string): CircuitAction => ({ type: 'addModule', moduleId, hostBoardId })
const mod = (instanceId: string, pinId: string): Endpoint => ({ kind: 'module', instanceId, pinId })
const bp = (boardInstanceId: string, pinId: string): Endpoint => ({ kind: 'board', boardInstanceId, pinId })
const issuesOf = (s: CircuitState) => validateCircuit(circuitOf(s))
const codes = (s: CircuitState, severity = 'error') => issuesOf(s).filter((i) => i.severity === severity).map((i) => i.code)

/** Uno(board-1) + ESP32(board-2) */
const twoBoards = () =>
  run([
    { type: 'addBoard', boardId: 'arduino-uno-r3' },
    { type: 'setBoard', boardInstanceId: 'board-2', boardId: 'esp32-devkit-v1' },
  ])

describe('여러 보드', () => {
  it('보드 추가·인스턴스 이름·위치가 겹치지 않음', () => {
    const s = twoBoards()
    expect(s.boards.map((b) => [b.instanceId, b.label, b.boardId])).toEqual([
      ['board-1', '보드 1', 'arduino-uno-r3'],
      ['board-2', '보드 2', 'esp32-devkit-v1'],
    ])
    const [a, b] = s.boards
    expect(b.y).toBeGreaterThanOrEqual(a.y + getBoard(a.boardId).footprint.height)
  })

  it('부품은 호스트 보드에 자동 배정된다', () => {
    let s = twoBoards()
    s = circuitReducer(s, add('led-5mm', 'board-2'))
    s = circuitReducer(s, add('led-5mm', 'board-1'))
    s = circuitReducer(s, { type: 'autoAssign' })
    expect(boardPinFor(s.connections, 'led-5mm#1', 'anode')?.boardInstanceId).toBe('board-2')
    expect(boardPinFor(s.connections, 'led-5mm#1', 'anode')?.pinId).toMatch(/^GPIO/)
    expect(boardPinFor(s.connections, 'led-5mm#2', 'anode')?.boardInstanceId).toBe('board-1')
    expect(codes(s)).toEqual([])
  })

  it('호스트 보드를 바꾸고 자동 배정하면 새 보드로 옮겨진다', () => {
    let s = run([add('led-5mm'), { type: 'autoAssign' }])
    s = circuitReducer(s, { type: 'addBoard', boardId: 'arduino-nano' })
    s = circuitReducer(s, { type: 'setHostBoard', instanceId: 'led-5mm#1', boardInstanceId: 'board-2' })
    s = circuitReducer(s, { type: 'clearConnections' })
    s = circuitReducer(s, { type: 'autoAssign' })
    expect(boardPinFor(s.connections, 'led-5mm#1', 'anode')?.boardInstanceId).toBe('board-2')
  })

  it('보드를 삭제하면 그 보드의 전선이 지워지고 부품은 첫 보드로 돌아간다', () => {
    let s = twoBoards()
    s = circuitReducer(s, add('led-5mm', 'board-2'))
    s = circuitReducer(s, { type: 'autoAssign' })
    s = circuitReducer(s, { type: 'removeBoard', boardInstanceId: 'board-2' })
    expect(s.boards).toHaveLength(1)
    expect(s.connections).toEqual([])
    expect(s.placed[0].hostBoardId).toBe('board-1')
    // 마지막 보드는 삭제할 수 없다
    const t = circuitReducer(s, { type: 'removeBoard', boardInstanceId: 'board-1' })
    expect(t.boards).toHaveLength(1)
  })

  it('같은 보드의 핀끼리는 연결하지 않는다', () => {
    const s = run([{ type: 'connect', from: bp('board-1', 'D2'), to: bp('board-1', 'D3') }])
    expect(s.connections).toEqual([])
  })
})

describe('보드 간 통신', () => {
  it('Uno 는 SoftwareSerial, ESP32 는 Serial2 를 제공한다 (USB 시리얼 제외)', () => {
    expect(linkBusOptions(getBoard('arduino-uno-r3'), 'UART').map((o) => o.value)).toEqual([SOFTWARE_SERIAL])
    expect(linkBusOptions(getBoard('esp32-devkit-v1'), 'UART').map((o) => o.value)).toEqual(['Serial2 (UART2)'])
    expect(linkBusOptions(getBoard('arduino-mega-2560'), 'UART').map((o) => o.value)).toEqual(['Serial1', 'Serial2', 'Serial3'])
  })

  it('UART: TX↔RX 교차 + GND, 5 V → 3.3 V 수신 쪽 레벨 오류', () => {
    const s = circuitReducer(twoBoards(), {
      type: 'addBoardLink',
      request: { protocol: 'UART', a: 'board-1', b: 'board-2', aBus: SOFTWARE_SERIAL, bBus: 'Serial2 (UART2)' },
    })
    expect(s.links).toHaveLength(1)
    const link = s.links[0]
    expect(link.b.pins).toEqual({ RX: 'GPIO16', TX: 'GPIO17' })
    expect(link.a.pins.RX).not.toBe(link.a.pins.TX)
    expect(['D0', 'D1']).not.toContain(link.a.pins.TX)
    expect(s.connections.filter((c) => c.linkId === link.id)).toHaveLength(3) // TX, RX, GND
    const net = buildNetlist(circuitOf(s))
    expect(net.netOf(`board:board-1:${link.a.pins.TX}`)).toBe(net.netOf('board:board-2:GPIO16'))
    expect(net.netOf('board:board-1:GND')).toBe(net.netOf('board:board-2:GND2')) // 보드 내부 GND 묶음 + GND 전선
    const errs = issuesOf(s).filter((i) => i.severity === 'error')
    expect(errs.map((i) => i.code)).toEqual(['level-overvoltage'])
    expect(errs[0].message).toContain('GPIO16')
    // 반대 방향(ESP32 TX 3.3 V → Uno RX)은 오류가 아니라 여유 작음 안내
    expect(issuesOf(s).some((i) => i.code === 'level-margin')).toBe(true)
  })

  it('레벨 변환 자동 추가 → 시프터 채널로 바꾸고 오류가 사라진다, 통신 연결은 유지', () => {
    let s = circuitReducer(twoBoards(), {
      type: 'addBoardLink',
      request: { protocol: 'UART', a: 'board-1', b: 'board-2', aBus: SOFTWARE_SERIAL, bBus: 'Serial2 (UART2)' },
    })
    s = circuitReducer(s, { type: 'insertLevelShifters' })
    expect(s.placed.map((p) => p.moduleId)).toEqual(['level-shifter-4ch'])
    expect(codes(s)).toEqual([])
    expect(codes(s, 'warning')).not.toContain('link-incomplete')
    // 시프터 HV = Uno 5V, LV = ESP32 3V3
    expect(boardPinFor(s.connections, 'level-shifter-4ch#1', 'hv')).toEqual({ boardInstanceId: 'board-1', pinId: '5V' })
    expect(boardPinFor(s.connections, 'level-shifter-4ch#1', 'lv')).toEqual({ boardInstanceId: 'board-2', pinId: '3V3' })
    // 링크를 지우면 링크 전선도 지워진다
    const t = circuitReducer(s, { type: 'removeBoardLink', linkId: s.links[0].id })
    expect(t.connections.some((c) => c.linkId)).toBe(false)
  })

  it('I²C: 컨트롤러/주변장치, 기존 LCD 와 버스 공유, 주소 충돌 검사', () => {
    let s = run([add('i2c-lcd-1602'), { type: 'autoAssign' }, { type: 'addBoard', boardId: 'arduino-nano' }])
    s = circuitReducer(s, { type: 'addBoardLink', request: { protocol: 'I2C', a: 'board-1', b: 'board-2', aBus: 'Wire', bBus: 'Wire', i2cAddress: '0x27' } })
    expect(s.links[0].i2cAddress).toBe('0x27')
    expect(codes(s)).toEqual([]) // A4/A5 를 LCD 와 공유해도 충돌 아님
    expect(issuesOf(s).some((i) => i.code === 'i2c-address')).toBe(true) // LCD 0x27 과 같은 주소
  })

  it('GND 가 공통이 아니면 오류', () => {
    let s = twoBoards()
    s = circuitReducer(s, { type: 'connect', from: bp('board-1', 'D7'), to: bp('board-2', 'GPIO23') })
    expect(codes(s)).toContain('ground-not-common')
    s = circuitReducer(s, { type: 'connect', from: bp('board-1', 'GND'), to: bp('board-2', 'GND') })
    expect(codes(s)).not.toContain('ground-not-common')
  })

  it('보드 간 전원·GND 단락과 서로 다른 전압 전원 연결은 오류', () => {
    let s = twoBoards()
    s = circuitReducer(s, { type: 'connect', from: bp('board-1', '5V'), to: bp('board-2', 'GND') })
    s = circuitReducer(s, { type: 'connect', from: bp('board-1', '3.3V'), to: bp('board-2', 'VIN') })
    const msgs = issuesOf(s).filter((i) => i.code === 'board-board').map((i) => i.message)
    expect(msgs.some((m) => m.includes('단락'))).toBe(true)
    expect(msgs.some((m) => m.includes('전압이 다른 전원'))).toBe(true)
  })

  it('UART 핀이 이미 쓰이면 통신 연결을 만들지 않는다', () => {
    let s = run([{ type: 'setBoard', boardInstanceId: 'board-1', boardId: 'arduino-mega-2560' }, add('led-5mm')])
    s = circuitReducer(s, { type: 'connect', from: mod('led-5mm#1', 'anode'), to: bp('board-1', 'D18') })
    s = circuitReducer(s, { type: 'addBoard', boardId: 'arduino-mega-2560' })
    const t = circuitReducer(s, { type: 'addBoardLink', request: { protocol: 'UART', a: 'board-1', b: 'board-2', aBus: 'Serial1', bBus: 'Serial1' } })
    expect(t.links).toHaveLength(0)
    expect(t.statusMessage).toContain('이미 다른 연결에 사용 중')
  })
})

describe('넷 단위 레벨 검사와 레벨 변환', () => {
  const esp = () => createInitialState('esp32-devkit-v1')

  it('HC-SR04 Echo → 전압 분배기, LCD SDA/SCL → 레벨 시프터 1개(2채널)', () => {
    let s = run([add('hc-sr04'), add('i2c-lcd-1602'), { type: 'autoAssign' }], esp())
    expect(codes(s).filter((c) => c === 'level-overvoltage')).toHaveLength(3)
    s = circuitReducer(s, { type: 'insertLevelShifters' })
    expect(s.placed.map((p) => p.moduleId).sort()).toEqual(['hc-sr04', 'i2c-lcd-1602', 'level-shifter-4ch', 'voltage-divider'])
    expect(codes(s)).toEqual([])
    // 핀 배정표는 경유 부품을 따라 보드 핀을 보여 준다
    const rows = buildPinTable(circuitOf(s))
    const echo = rows.find((r) => r.moduleLabel.startsWith('HC-SR04') && r.pinName === 'Echo')!
    expect(echo.boardPin).toMatch(/^GPIO/)
    expect(echo.note).toContain('전압 분배기 1 경유')
    const sda = routeToBoard(circuitOf(s), 'i2c-lcd-1602#2', 'sda')!
    expect(sda.pinId).toBe('GPIO21')
    expect(sda.via).toEqual(['레벨 시프터 (4채널) 1'])
    // 다시 실행해도 더 추가하지 않는다
    const again = circuitReducer(s, { type: 'insertLevelShifters' })
    expect(again.placed).toHaveLength(4)
  })

  it('분배기 비율이 부족하면 여전히 오류 (2.2k/3.3k 는 5 V → 3.0 V 로 통과, 직접 계산 확인)', () => {
    let s = run([add('hc-sr04'), { type: 'autoAssign' }, { type: 'insertLevelShifters' }], esp())
    expect(codes(s)).toEqual([])
    s = circuitReducer(s, { type: 'setParam', instanceId: 'voltage-divider#2', paramId: 'ratio', value: '2k2-3k3' })
    expect(codes(s)).toEqual([])
  })

  it('Uno 에서는 레벨 변환이 필요 없다', () => {
    const s = run([add('hc-sr04'), add('i2c-lcd-1602'), { type: 'autoAssign' }, { type: 'insertLevelShifters' }])
    expect(s.placed).toHaveLength(2)
    expect(s.statusMessage).toContain('오류가 없습니다')
  })
})
