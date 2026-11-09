import { describe, expect, it } from 'vitest'
import { holeId, routeBreadboard } from '../engine/breadboard'
import type { Endpoint } from '../types'
import { circuitOf, circuitReducer, createInitialState, type CircuitAction, type CircuitState } from './circuitState'

// 배선도(보드·부품 핀)에서 전선 끝을 다른 핀으로 옮기기

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) => actions.reduce(circuitReducer, state)
const add = (moduleId: string): CircuitAction => ({ type: 'addModule', moduleId })
const mod = (instanceId: string, pinId: string): Endpoint => ({ kind: 'module', instanceId, pinId })
const bp = (pinId: string): Endpoint => ({ kind: 'board', boardInstanceId: 'board-1', pinId })
const retarget = (connectionIds: string[], from: Endpoint, to: Endpoint): CircuitAction => ({ type: 'retargetWire', connectionIds, from, to })

describe('전선 끝 옮기기 (보드·부품 핀)', () => {
  it('보드 쪽 끝을 다른 보드 핀으로 옮기면 같은 전선이 새 핀에 이어지고, 실행 취소된다', () => {
    const s0 = run([add('led-5mm'), { type: 'connect', from: mod('led-5mm#1', 'anode'), to: bp('D5') }])
    const id = s0.connections[0].id
    const s1 = circuitReducer(s0, retarget([id], bp('D5'), bp('D6')))
    expect(s1.connections).toHaveLength(1)
    expect(s1.connections[0]).toMatchObject({ id, from: mod('led-5mm#1', 'anode'), to: bp('D6') })
    expect(s1.selection).toEqual({ kind: 'connection', connectionId: id })
    expect(s1.statusMessage).toContain('D6')
    expect(circuitReducer(s1, { type: 'undo' }).connections[0].to).toEqual(bp('D5'))
  })

  it('부품 쪽 끝을 다른 부품의 핀으로 옮길 수 있다', () => {
    const s0 = run([add('led-5mm'), add('led-5mm'), { type: 'connect', from: mod('led-5mm#1', 'anode'), to: bp('D5') }])
    const s1 = circuitReducer(s0, retarget([s0.connections[0].id], mod('led-5mm#1', 'anode'), mod('led-5mm#2', 'anode')))
    expect(s1.connections[0]).toMatchObject({ from: mod('led-5mm#2', 'anode'), to: bp('D5') })
  })

  it('같은 부품의 다른 핀으로는 옮기지 않고 이유를 알린다', () => {
    const s0 = run([add('l298n'), add('dc-gear-tt'), { type: 'connect', from: mod('dc-gear-tt#2', 'm1'), to: mod('l298n#1', 'out1') }])
    const s1 = circuitReducer(s0, retarget([s0.connections[0].id], mod('l298n#1', 'out1'), mod('dc-gear-tt#2', 'm2')))
    expect(s1.connections).toEqual(s0.connections)
    expect(s1.statusMessage).toContain('같은 부품')
  })

  it('맞지 않는 핀으로 옮기면 전선은 옮기되 경고를 함께 알린다', () => {
    const s0 = run([add('led-5mm'), { type: 'connect', from: mod('led-5mm#1', 'cathode'), to: bp('GND') }])
    const s1 = circuitReducer(s0, retarget([s0.connections[0].id], bp('GND'), bp('5V')))
    expect(s1.connections[0].to).toEqual(bp('5V'))
    expect(s1.statusMessage).toContain('⚠')
  })

  it('보드 핀 하나를 여러 전선이 나눠 쓰면 함께 옮긴다', () => {
    const s0 = run([
      add('hc-sr04'), add('hc-sr04'),
      { type: 'connect', from: mod('hc-sr04#1', 'vcc'), to: bp('5V'), via: 'breadboard' },
      { type: 'connect', from: mod('hc-sr04#2', 'vcc'), to: bp('5V'), via: 'breadboard' },
    ])
    const ids = s0.connections.map((c) => c.id)
    const s1 = circuitReducer(s0, retarget(ids, bp('5V'), bp('3.3V')))
    expect(s1.connections.map((c) => c.to)).toEqual([bp('3.3V'), bp('3.3V')])
    expect(s1.connections.every((c) => c.via === 'breadboard')).toBe(true)
  })

  it('브레드보드를 거치는 전선의 보드 끝을 옮기면 꽂혀 있던 구멍은 새 핀의 전선이 이어받는다', () => {
    const s0 = run([add('led-5mm'), { type: 'connect', from: mod('led-5mm#1', 'anode'), to: bp('D5'), via: 'breadboard' }])
    const s1 = circuitReducer(s0, { type: 'moveLead', key: 'board:board-1:D5', hole: { kind: 'main', col: 30, row: 'h' } })
    expect(s1.breadboardHoles['board:board-1:D5']).toBe('30h')
    const s2 = circuitReducer(s1, retarget([s1.connections[0].id], bp('D5'), bp('D6')))
    expect(s2.breadboardHoles['board:board-1:D6']).toBe('30h')
    expect(s2.breadboardHoles['board:board-1:D5']).toBeUndefined()
    const lead = routeBreadboard(circuitOf(s2)).leads.find((l) => l.key === 'board:board-1:D6')!
    expect(holeId(lead.hole)).toBe('30h')
  })
})
