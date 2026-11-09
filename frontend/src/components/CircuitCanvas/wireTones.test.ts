import { describe, expect, it } from 'vitest'
import { routeBreadboard } from '../../engine/breadboard'
import { endpointKey } from '../../engine/connections'
import { circuitOf, circuitReducer, createInitialState, type CircuitAction } from '../../state/circuitState'
import { wireTones } from './wireTones'

const run = (actions: CircuitAction[]) => actions.reduce(circuitReducer, createInitialState())

describe('전선 색', () => {
  it('부품 핀 칩에 그 핀 전선과 같은 색을 알려 준다 (직결)', () => {
    const s = run([
      { type: 'addModule', moduleId: 'led-5mm' },
      { type: 'connect', from: { kind: 'module', instanceId: 'led-5mm#1', pinId: 'anode' }, to: { kind: 'board', boardInstanceId: 'board-1', pinId: 'D5' } },
      { type: 'connect', from: { kind: 'module', instanceId: 'led-5mm#1', pinId: 'cathode' }, to: { kind: 'board', boardInstanceId: 'board-1', pinId: 'GND' } },
    ])
    const tones = wireTones(s.connections, s.placed, routeBreadboard(circuitOf(s)))
    for (const c of s.connections) {
      const key = [c.from, c.to].map(endpointKey).find((k) => k.startsWith('module:'))!
      expect(tones.ends.get(key)).toBe(tones.wires.get(c.id)!.color)
    }
    expect(tones.ends.get('module:led-5mm#1:cathode')).toBe('var(--wire-ground)')
  })

  it('브레드보드를 거치는 전선도 칩에 같은 색을 알려 준다', () => {
    const s = run([
      { type: 'addModule', moduleId: 'led-5mm' },
      { type: 'connect', from: { kind: 'module', instanceId: 'led-5mm#1', pinId: 'anode' }, to: { kind: 'board', boardInstanceId: 'board-1', pinId: 'D5' }, via: 'breadboard' },
    ])
    const routing = routeBreadboard(circuitOf(s))
    const tones = wireTones(s.connections, s.placed, routing)
    const lead = routing.leads.find((l) => l.key === 'module:led-5mm#1:anode')!
    expect(lead).toBeTruthy()
    expect(tones.ends.get(lead.key)).toBe(tones.leads.get(lead.key)!.color)
  })
})
