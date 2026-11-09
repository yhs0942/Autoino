import { describe, expect, it } from 'vitest'
import { getModule } from '../data/modules'
import { holeId, routeBreadboard, type Hole } from '../engine/breadboard'
import { endpointKey, isPinConnected, moduleEndpoint } from '../engine/connections'
import { focusOf } from '../engine/focus'
import { analyzePower, primaryGrounds } from '../engine/power'
import { validateCircuit } from '../engine/validate'
import type { Endpoint } from '../types'
import { circuitOf, circuitReducer, createInitialState, type CircuitAction, type CircuitState } from './circuitState'

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) => actions.reduce(circuitReducer, state)
const add = (moduleId: string): CircuitAction => ({ type: 'addModule', moduleId })
const mod = (instanceId: string, pinId: string): Endpoint => ({ kind: 'module', instanceId, pinId })
const bp = (pinId: string): Endpoint => ({ kind: 'board', boardInstanceId: 'board-1', pinId })
const main = (col: number, row: Extract<Hole, { kind: 'main' }>['row']): Hole => ({ kind: 'main', col, row })
const leadHole = (s: CircuitState, key: string) => {
  const l = routeBreadboard(circuitOf(s)).leads.find((x) => x.key === key)
  return l ? holeId(l.hole) : null
}

describe('부품을 고르면 그 부품의 배선과 보드까지의 경로를 강조', () => {
  it('직접 연결된 부품: 그 부품의 전선과 보드 핀', () => {
    const s = run([add('led-5mm'), add('push-button'), { type: 'autoAssign' }])
    const f = focusOf(circuitOf(s), 'led-5mm#1')
    expect([...f.wires].sort()).toEqual(s.connections.filter((c) => c.from.kind === 'module' && c.from.instanceId === 'led-5mm#1').map((c) => c.id).sort())
    expect(f.path.size).toBe(0)
    expect([...f.boardPins].length).toBe(2)
  })

  it('드라이버를 거치는 모터: 모터 전선 + 드라이버에서 보드로 가는 그 채널의 제어선', () => {
    const s = run([add('l298n'), add('dc-gear-tt'), add('dc-gear-tt'), { type: 'attachMotor', motorId: 'dc-gear-tt#2', driverId: 'l298n#1', route: 'direct' }, { type: 'attachMotor', motorId: 'dc-gear-tt#3', driverId: 'l298n#1', route: 'direct' }])
    const f = focusOf(circuitOf(s), 'dc-gear-tt#2')
    expect(f.wires.size).toBe(2)
    const pathPins = s.connections.filter((c) => f.path.has(c.id)).flatMap((c) => [c.from, c.to]).filter((e) => e.kind === 'module').map((e) => (e as { pinId: string }).pinId)
    expect(pathPins).toEqual(expect.arrayContaining(['ena', 'in1', 'in2']))
    expect(pathPins).not.toContain('in3')
    expect(f.boardPins.size).toBeGreaterThanOrEqual(3)
  })
})

describe('한 부품의 배선 초기화', () => {
  it('그 부품의 전선만 지우고, 다른 부품 전선은 그대로 두며, 실행 취소된다', () => {
    const s = run([add('led-5mm'), add('push-button'), { type: 'autoAssign' }])
    const r = circuitReducer(s, { type: 'resetModuleWiring', instanceId: 'led-5mm#1' })
    expect(isPinConnected(r.connections, 'led-5mm#1', 'anode')).toBe(false)
    expect(isPinConnected(r.connections, 'push-button#2', 'pin2a')).toBe(true)
    expect(r.statusMessage).toContain('LED 1')
    expect(circuitReducer(r, { type: 'undo' }).connections).toEqual(s.connections)
  })

  it('그 부품만 다시 자동 배정할 수 있다', () => {
    const s = run([add('led-5mm'), add('push-button')])
    const r = circuitReducer(s, { type: 'autoAssignModule', instanceId: 'led-5mm#1', route: 'direct' })
    expect(isPinConnected(r.connections, 'led-5mm#1', 'anode')).toBe(true)
    expect(isPinConnected(r.connections, 'push-button#2', 'pin2a')).toBe(false)
  })
})

describe('사람이 브레드보드에서 직접 전선 만들기 (핀을 끌어 구멍에 놓기)', () => {
  it('빈 줄에 놓으면 맞는 보드 핀을 골라 잇고, 전선은 놓은 구멍에 꽂힌다', () => {
    const s = run([add('hc-sr04'), { type: 'connectToHole', endpoint: mod('hc-sr04#1', 'trig'), hole: main(30, 'c'), route: 'breadboard' }])
    expect(isPinConnected(s.connections, 'hc-sr04#1', 'trig')).toBe(true)
    expect(s.connections[0].via).toBe('breadboard')
    expect(leadHole(s, 'module:hc-sr04#1:trig')).toBe('30c')
  })

  it('다른 전선이 꽂힌 줄에 놓으면 그 전선의 핀과 이어진다', () => {
    const s0 = run([add('hc-sr04'), add('hc-sr04'), { type: 'connect', from: mod('hc-sr04#1', 'vcc'), to: bp('5V'), via: 'breadboard' }])
    const fiveV = routeBreadboard(circuitOf(s0)).leads.find((l) => l.key === 'board:board-1:5V')!
    const s = circuitReducer(s0, { type: 'connectToHole', endpoint: mod('hc-sr04#2', 'vcc'), hole: { ...fiveV.hole, col: 30 } as Hole, route: 'breadboard' })
    const c = s.connections.find((x) => endpointKey(x.from) === 'module:hc-sr04#2:vcc' || endpointKey(x.to) === 'module:hc-sr04#2:vcc')!
    expect([endpointKey(c.from), endpointKey(c.to)]).toContain('board:board-1:5V')
    expect(leadHole(s, 'module:hc-sr04#2:vcc')).toBe(holeId({ ...fiveV.hole, col: 30 } as Hole))
  })

  it('맞지 않는 줄에 놓으면 막고 이유를 알린다', () => {
    const s0 = run([add('hc-sr04'), add('hc-sr04'), { type: 'connect', from: mod('hc-sr04#1', 'trig'), to: bp('D7'), via: 'breadboard' }])
    const d7 = routeBreadboard(circuitOf(s0)).leads.find((l) => l.key === 'board:board-1:D7')!
    const s = circuitReducer(s0, { type: 'connectToHole', endpoint: mod('hc-sr04#2', 'gnd'), hole: { ...d7.hole, row: 'e' } as Hole, route: 'breadboard' })
    expect(s.connections).toEqual(s0.connections)
    expect(s.statusMessage).toContain('GND')
  })
})

describe('외부 전원 자동 연결이 정확한지 (외부 전원이 필요한 모든 부품)', () => {
  const needsPower = ['l298n', 'tb6612fng', 'l9110s', 'drv8833', 'uln2003', 'a4988', 'drv8825', 'esc-30a', 'mg996r', 'buck-lm2596', 'mb102-power']
  it.each(needsPower.flatMap((m) => [[m, 'direct'], [m, 'breadboard']] as const))('%s (%s): + 는 그 부품의 전원 핀에만, − 는 그 부품 GND 와 보드 GND 에', (moduleId, route) => {
    const s0 = run([add(moduleId), { type: 'autoAssign', route }])
    const need = analyzePower(circuitOf(s0)).needs.find((n) => n.pins.some((k) => k.startsWith(`module:${moduleId}#1:`)))
    expect(need, '전원 필요 항목').toBeDefined()
    const s = circuitReducer(s0, { type: 'addModule', moduleId: 'external-power', autoConnect: true, near: `${moduleId}#1`, route })
    const supply = s.placed.at(-1)!
    const plus = endpointKey(moduleEndpoint(supply.instanceId, 'plus'))
    const minus = endpointKey(moduleEndpoint(supply.instanceId, 'minus'))
    const peers = (key: string) => s.connections.flatMap((c) => (endpointKey(c.from) === key ? [endpointKey(c.to)] : endpointKey(c.to) === key ? [endpointKey(c.from)] : []))
    expect(peers(plus).sort()).toEqual([...need!.pins].sort())
    const grounds = primaryGrounds(need!.pins, s.placed)
    for (const g of grounds) expect(peers(minus), g).toContain(g)
    expect(peers(minus).some((k) => k.startsWith('board:') && getModule('external-power') && k.endsWith(':GND'))).toBe(true)
    // 보드 전원 핀에 외부 전원 + 가 물리지 않는다
    expect(peers(plus).some((k) => k.startsWith('board:'))).toBe(false)
    const bad = validateCircuit(circuitOf(s)).filter((i) => i.severity === 'error' && /supply|source|ground/.test(i.code))
    expect(bad.map((i) => i.message)).toEqual([])
    expect(analyzePower(circuitOf(s)).needs.find((n) => n.pins.some((k) => need!.pins.includes(k)))?.servedBy).toBe(supply.label)
  })
})
