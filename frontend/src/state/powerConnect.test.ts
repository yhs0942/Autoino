import { describe, expect, it } from 'vitest'
import { analyzePower, findMergeableSupplies } from '../engine/power'
import type { Endpoint } from '../types'
import { circuitOf, circuitReducer, createInitialState, type CircuitAction, type CircuitState } from './circuitState'

// 외부 전원을 더 쉽게 연결하기: 놓으면 자동 연결, 같은 전압 전원 합치기

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) => actions.reduce(circuitReducer, state)
const add = (moduleId: string): CircuitAction => ({ type: 'addModule', moduleId })
const drop = (moduleId: string, near?: string): CircuitAction => ({ type: 'addModule', moduleId, autoConnect: true, near, route: 'direct' })
const mod = (instanceId: string, pinId: string): Endpoint => ({ kind: 'module', instanceId, pinId })
const wired = (s: CircuitState, a: Endpoint, b: Endpoint) =>
  s.connections.some((c) => (JSON.stringify(c.from) === JSON.stringify(a) && JSON.stringify(c.to) === JSON.stringify(b)) || (JSON.stringify(c.from) === JSON.stringify(b) && JSON.stringify(c.to) === JSON.stringify(a)))
const motorRig = () => run([add('l298n'), add('dc-gear-tt'), { type: 'attachMotor', motorId: 'dc-gear-tt#2', driverId: 'l298n#1', route: 'direct' }])

describe('외부 전원을 놓으면 자동 연결', () => {
  it('전원이 필요한 부품에 맞춰 전압·전류를 고르고 + 와 − 를 잇는다', () => {
    const s0 = motorRig()
    const need = analyzePower(circuitOf(s0)).needs[0]
    expect(need.servedBy).toBeNull()
    const s1 = circuitReducer(s0, drop('external-power'))
    const supply = s1.placed.at(-1)!
    expect(supply.moduleId).toBe('external-power')
    expect(Number(supply.params.voltage)).toBe(need.examples[0].voltage)
    expect(Number(supply.params.current)).toBeGreaterThanOrEqual(need.recommendedMa)
    expect(wired(s1, mod(supply.instanceId, 'plus'), mod('l298n#1', 'vs'))).toBe(true)
    expect(analyzePower(circuitOf(s1)).needs[0].servedBy).toBe(supply.label)
    expect(s1.statusMessage).toContain(`${need.examples[0].voltage} V`)
  })

  it('카드 위에 놓으면 그 부품의 전원에 연결한다', () => {
    // 12 V 모터 드라이버 전원과 5–6 V 서보 전원은 전압 범위가 겹치지 않아 따로 필요하다
    const s0 = run([add('l298n'), add('dc-gear-25ga370'), add('mg996r'), { type: 'attachMotor', motorId: 'dc-gear-25ga370#2', driverId: 'l298n#1', route: 'direct' }])
    const needs = analyzePower(circuitOf(s0)).needs
    expect(needs.length).toBe(2)
    const s1 = circuitReducer(s0, drop('external-power', 'mg996r#3'))
    const supply = s1.placed.at(-1)!
    expect(wired(s1, mod(supply.instanceId, 'plus'), mod('mg996r#3', 'vcc'))).toBe(true)
    expect(wired(s1, mod(supply.instanceId, 'plus'), mod('l298n#1', 'vs'))).toBe(false)
  })

  it('전원이 필요한 부품이 없으면 그냥 놓고 안내한다', () => {
    const s1 = run([drop('external-power')])
    expect(s1.connections).toEqual([])
    expect(s1.statusMessage).toContain('외부 전원')
  })

  it('다른 부품은 자동 연결 옵션이 있어도 그냥 놓인다', () => {
    const s1 = run([drop('led-5mm')])
    expect(s1.placed).toHaveLength(1)
    expect(s1.connections).toEqual([])
  })
})

describe('같은 전압 전원 합치기', () => {
  /** 서보 두 개에 같은 6 V 외부 전원을 하나씩 따로 연결한 회로 */
  const twoSupplies = () =>
    run([
      add('mg996r'), add('mg996r'), add('external-power'), add('external-power'),
      { type: 'setParam', instanceId: 'external-power#3', paramId: 'voltage', value: '6' },
      { type: 'setParam', instanceId: 'external-power#4', paramId: 'voltage', value: '6' },
      { type: 'setParam', instanceId: 'external-power#3', paramId: 'current', value: '2000' },
      { type: 'setParam', instanceId: 'external-power#4', paramId: 'current', value: '2000' },
      { type: 'connect', from: mod('external-power#3', 'plus'), to: mod('mg996r#1', 'vcc') },
      { type: 'connect', from: mod('external-power#3', 'minus'), to: mod('mg996r#1', 'gnd') },
      { type: 'connect', from: mod('external-power#4', 'plus'), to: mod('mg996r#2', 'vcc') },
      { type: 'connect', from: mod('external-power#4', 'minus'), to: mod('mg996r#2', 'gnd') },
    ])

  it('전압이 같은 외부 전원끼리 묶어 찾는다', () => {
    const s = twoSupplies()
    const supplies = s.placed.filter((p) => p.moduleId === 'external-power')
    expect(supplies).toHaveLength(2)
    expect(supplies[0].params.voltage).toBe(supplies[1].params.voltage)
    const groups = findMergeableSupplies(circuitOf(s))
    expect(groups).toHaveLength(1)
    expect(groups[0].items.map((p) => p.instanceId)).toEqual(supplies.map((p) => p.instanceId))
  })

  it('합치면 전원 하나만 남고, 모든 부품이 그 전원에 이어지며, 전류는 둘을 더한 만큼 이상이다', () => {
    const s = twoSupplies()
    const [keep, other] = s.placed.filter((p) => p.moduleId === 'external-power')
    const merged = circuitReducer(s, { type: 'mergeSupplies', keepId: keep.instanceId, otherIds: [other.instanceId] })
    expect(merged.placed.some((p) => p.instanceId === other.instanceId)).toBe(false)
    expect(wired(merged, mod(keep.instanceId, 'plus'), mod('mg996r#1', 'vcc'))).toBe(true)
    expect(wired(merged, mod(keep.instanceId, 'plus'), mod('mg996r#2', 'vcc'))).toBe(true)
    expect(merged.connections.some((c) => [c.from, c.to].some((e) => e.kind === 'module' && e.instanceId === other.instanceId))).toBe(false)
    const total = Number(keep.params.current) + Number(other.params.current)
    expect(Number(merged.placed.find((p) => p.instanceId === keep.instanceId)!.params.current)).toBeGreaterThanOrEqual(total)
    expect(analyzePower(circuitOf(merged)).needs.every((n) => n.servedBy === keep.label)).toBe(true)
    expect(merged.statusMessage).toContain('합쳤습니다')
    expect(circuitReducer(merged, { type: 'undo' }).placed).toHaveLength(s.placed.length)
  })

  it('전압이 다르면 합치지 않는다', () => {
    const s = twoSupplies()
    const [keep, other] = s.placed.filter((p) => p.moduleId === 'external-power')
    const changed = circuitReducer(s, { type: 'setParam', instanceId: other.instanceId, paramId: 'voltage', value: '12' })
    expect(findMergeableSupplies(circuitOf(changed))).toEqual([])
    const merged = circuitReducer(changed, { type: 'mergeSupplies', keepId: keep.instanceId, otherIds: [other.instanceId] })
    expect(merged.placed).toHaveLength(changed.placed.length)
    expect(merged.statusMessage).toContain('전압')
  })
})
