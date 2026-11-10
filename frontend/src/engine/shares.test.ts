import { describe, expect, it } from 'vitest'
import { circuitOf, circuitReducer, createInitialState, toProjectData, type CircuitAction, type CircuitState } from '../state/circuitState'
import type { Endpoint } from '../types'
import { routeBreadboard } from './breadboard'
import { isPinConnected } from './connections'
import { buildBom } from './exporters'
import { parseProjectFile, toProjectFile } from './project'
import { computeLadderResistors, ladderThresholds } from './shares'
import { validateCircuit } from './validate'

// 핀 공유: 부품 핀끼리 끌어 이으면 한 보드 핀을 함께 쓰는 그룹이 된다

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) => actions.reduce(circuitReducer, state)
const add = (moduleId: string): CircuitAction => ({ type: 'addModule', moduleId })
const mod = (instanceId: string, pinId: string): Endpoint => ({ kind: 'module', instanceId, pinId })
const bp = (pinId: string): Endpoint => ({ kind: 'board', boardInstanceId: 'board-1', pinId })
const link = (a: Endpoint, b: Endpoint, via?: 'breadboard'): CircuitAction => ({ type: 'connect', from: a, to: b, ...(via ? { via } : {}) })
const boardPinOf = (s: CircuitState, instanceId: string, pinId: string) =>
  s.connections
    .filter((c) => [c.from, c.to].some((e) => e.kind === 'module' && e.instanceId === instanceId && e.pinId === pinId))
    .flatMap((c) => [c.from, c.to])
    .filter((e) => e.kind === 'board')
    .map((e) => (e as { pinId: string }).pinId)
const issues = (s: CircuitState) => validateCircuit(circuitOf(s))

describe('핀 공유 그룹 만들기', () => {
  it('LED 핀을 다른 LED 핀에 끌어 놓으면 둘이 같은 보드 핀을 쓰는 그룹이 되고, 핀 충돌이 아니다', () => {
    const s = run([add('led-5mm'), add('led-5mm'), link(mod('led-5mm#1', 'anode'), bp('D5')), link(mod('led-5mm#2', 'anode'), mod('led-5mm#1', 'anode'))])
    expect(boardPinOf(s, 'led-5mm#2', 'anode')).toEqual(['D5'])
    expect(s.shares).toHaveLength(1)
    expect([...s.shares[0].members].sort()).toEqual(['module:led-5mm#1:anode', 'module:led-5mm#2:anode'])
    expect(issues(s).some((i) => i.code === 'pin-conflict')).toBe(false)
    const info = issues(s).find((i) => i.code === 'pin-shared')!
    expect(info.severity).toBe('info')
    expect(info.message).toContain('D5')
    expect(info.message).toContain('같이 켜지고')
    expect(s.statusMessage).toContain('D5')
  })

  it('둘 다 연결 전이면 맞는 보드 핀을 골라 둘을 함께 잇는다', () => {
    const s = run([add('led-5mm'), add('led-5mm'), link(mod('led-5mm#2', 'anode'), mod('led-5mm#1', 'anode'))])
    const [pin] = boardPinOf(s, 'led-5mm#1', 'anode')
    expect(pin).toBeTruthy()
    expect(boardPinOf(s, 'led-5mm#2', 'anode')).toEqual([pin])
  })

  it('세 번째 LED 도 같은 그룹에 들어간다', () => {
    const s = run([add('led-5mm'), add('led-5mm'), add('led-5mm'), link(mod('led-5mm#1', 'anode'), bp('D5')), link(mod('led-5mm#2', 'anode'), mod('led-5mm#1', 'anode')), link(mod('led-5mm#3', 'anode'), mod('led-5mm#2', 'anode'))])
    expect(s.shares).toHaveLength(1)
    expect(s.shares[0].members).toHaveLength(3)
    expect(boardPinOf(s, 'led-5mm#3', 'anode')).toEqual(['D5'])
  })

  it('버튼끼리 디지털 핀: 입력 공유 — 어느 버튼인지 구분할 수 없다고 알린다', () => {
    const s = run([add('push-button'), add('push-button'), link(mod('push-button#1', 'pin2a'), bp('D4')), link(mod('push-button#2', 'pin2a'), mod('push-button#1', 'pin2a'))])
    const info = issues(s).find((i) => i.code === 'pin-shared')!
    expect(info.message).toContain('구분할 수 없습니다')
    expect(issues(s).some((i) => i.code === 'pin-conflict')).toBe(false)
  })

  it('버튼끼리 Uno 아날로그 핀: 저항 사다리로 버튼을 구분하고, 저항이 부품 목록에 들어간다', () => {
    const s = run([add('push-button'), add('push-button'), add('push-button'), link(mod('push-button#1', 'pin2a'), bp('A0')), link(mod('push-button#2', 'pin2a'), mod('push-button#1', 'pin2a')), link(mod('push-button#3', 'pin2a'), mod('push-button#1', 'pin2a'))])
    const info = issues(s).find((i) => i.code === 'pin-shared')!
    expect(info.message).toContain('저항 사다리')
    expect(info.message).toContain('4.7 kΩ')
    expect(info.message).toContain('22 kΩ')
    const ladder = computeLadderResistors(circuitOf(s))
    expect(ladder.map((r) => r.ohms)).toEqual([0, 4700, 22000])
    const bom = buildBom(circuitOf(s))
    expect(bom.some((r) => r.item === '저항' && r.spec.startsWith('4.7 kΩ') && r.note.includes('사다리'))).toBe(true)
  })

  it('브레드보드를 거치면 사다리 저항도 브레드보드에 꽂힌다', () => {
    const s = run([
      add('push-button'), add('push-button'),
      link(mod('push-button#1', 'pin2a'), bp('A0'), 'breadboard'),
      link(mod('push-button#2', 'pin2a'), mod('push-button#1', 'pin2a'), 'breadboard'),
    ])
    expect(s.connections.every((c) => c.via === 'breadboard')).toBe(true)
    const r = routeBreadboard(circuitOf(s))
    expect(r.resistors.map((x) => x.ohms)).toEqual([4700])
  })

  it('ESP32 아날로그 핀은 내부 풀업이 analogRead 중 꺼지므로 사다리 대신 입력 공유가 된다', () => {
    const s = run([add('push-button'), add('push-button'), link(mod('push-button#1', 'pin2a'), { kind: 'board', boardInstanceId: 'board-1', pinId: 'GPIO32' }), link(mod('push-button#2', 'pin2a'), mod('push-button#1', 'pin2a'))], createInitialState('esp32-devkit-v1'))
    expect(issues(s).find((i) => i.code === 'pin-shared')!.message).toContain('구분할 수 없습니다')
  })

  it('LED 와 버튼처럼 종류가 다르면 묶지 않고 이유를 알린다', () => {
    const s0 = run([add('led-5mm'), add('push-button'), link(mod('led-5mm#1', 'anode'), bp('D5'))])
    const s = circuitReducer(s0, link(mod('push-button#2', 'pin2a'), mod('led-5mm#1', 'anode')))
    expect(s.connections).toEqual(s0.connections)
    expect(s.shares).toEqual([])
    expect(s.statusMessage).toContain('함께 쓸 수 없습니다')
  })

  it('그룹 없이 한 핀에 신호 두 개가 있으면(예: 그룹이 없는 예전 파일) 핀 충돌이고, 묶는 방법을 알려 준다', () => {
    const s0 = run([add('led-5mm'), add('led-5mm'), link(mod('led-5mm#1', 'anode'), bp('D5'))])
    const s = { ...s0, connections: [...s0.connections, { id: 'w99', from: mod('led-5mm#2', 'anode'), to: bp('D5'), auto: false }] }
    const conflict = issues(s).find((i) => i.code === 'pin-conflict')!
    expect(conflict.severity).toBe('error')
    expect(conflict.hint).toContain('끌어')
  })

  it('LED 전류 합계가 핀 권장 한계를 넘으면 경고한다', () => {
    const s = run([
      add('led-5mm'), add('led-5mm'),
      { type: 'setParam', instanceId: 'led-5mm#1', paramId: 'current', value: '15' },
      { type: 'setParam', instanceId: 'led-5mm#2', paramId: 'current', value: '15' },
      link(mod('led-5mm#1', 'anode'), bp('D5')),
      link(mod('led-5mm#2', 'anode'), mod('led-5mm#1', 'anode')),
    ])
    const w = issues(s).find((i) => i.code === 'pin-shared-current')!
    expect(w.severity).toBe('warning')
    expect(w.message).toContain('D5')
  })

  it('자동 배정은 그룹을 유지하고, 끊긴 멤버를 같은 핀에 다시 잇는다', () => {
    const s0 = run([add('led-5mm'), add('led-5mm'), link(mod('led-5mm#1', 'anode'), bp('D5')), link(mod('led-5mm#2', 'anode'), mod('led-5mm#1', 'anode'))])
    const wire = s0.connections.find((c) => c.from.kind === 'module' && c.from.instanceId === 'led-5mm#2' && c.from.pinId === 'anode')!
    const s1 = run([{ type: 'removeConnection', connectionId: wire.id }, { type: 'autoAssign' }], s0)
    expect(boardPinOf(s1, 'led-5mm#1', 'anode')).toEqual(['D5'])
    expect(boardPinOf(s1, 'led-5mm#2', 'anode')).toEqual(['D5'])
    expect(issues(s1).some((i) => i.code === 'pin-conflict')).toBe(false)
  })

  it('공유를 풀면 그 멤버의 공유 핀 전선을 떼고 그룹에서 뺀다', () => {
    const s0 = run([add('led-5mm'), add('led-5mm'), link(mod('led-5mm#1', 'anode'), bp('D5')), link(mod('led-5mm#2', 'anode'), mod('led-5mm#1', 'anode'))])
    const s1 = circuitReducer(s0, { type: 'unsharePin', key: 'module:led-5mm#2:anode' })
    expect(isPinConnected(s1.connections, 'led-5mm#2', 'anode')).toBe(false)
    expect(isPinConnected(s1.connections, 'led-5mm#1', 'anode')).toBe(true)
    expect(s1.shares).toEqual([])
  })

  it('부품을 지우면 그룹에서도 빠진다', () => {
    const s0 = run([add('led-5mm'), add('led-5mm'), link(mod('led-5mm#1', 'anode'), bp('D5')), link(mod('led-5mm#2', 'anode'), mod('led-5mm#1', 'anode'))])
    expect(circuitReducer(s0, { type: 'removeModule', instanceId: 'led-5mm#2' }).shares).toEqual([])
  })

  it('그룹은 프로젝트 파일에 저장된다', () => {
    const s = run([add('led-5mm'), add('led-5mm'), link(mod('led-5mm#1', 'anode'), bp('D5')), link(mod('led-5mm#2', 'anode'), mod('led-5mm#1', 'anode'))])
    const data = parseProjectFile(JSON.stringify(toProjectFile(toProjectData(s))))
    expect(data.shares).toEqual(s.shares)
    expect('shares' in toProjectFile(toProjectData(createInitialState()))).toBe(false)
  })

  it('사다리 경계값: 내부 풀업 20–50 kΩ 범위에서 버튼마다 겹치지 않는 구간', () => {
    expect(ladderThresholds(4)).toEqual([44, 254, 609, 938])
    expect(ladderThresholds(2)).toEqual([44, 609])
  })
})
