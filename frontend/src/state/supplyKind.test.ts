import { describe, expect, it } from 'vitest'
import { findSupply, SUPPLIES } from '../data/supplies'
import { getModule } from '../data/modules'
import { analyzePower } from '../engine/power'
import { placedSupplies } from '../engine/supplyInfo'
import { circuitOf, circuitReducer, createInitialState, type CircuitAction, type CircuitState } from './circuitState'

// 외부 전원의 정확한 종류(어떤 어댑터·배터리인지)를 기록하고 전원 탭에서 보여 준다

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) => actions.reduce(circuitReducer, state)
const add = (moduleId: string): CircuitAction => ({ type: 'addModule', moduleId })
const motorRig = () => run([add('l298n'), add('dc-gear-tt'), { type: 'attachMotor', motorId: 'dc-gear-tt#2', driverId: 'l298n#1', route: 'direct' }])
const apply = (s: CircuitState, supplyId: string) => circuitReducer(s, { type: 'applySupply', supplyId, pins: analyzePower(circuitOf(s)).needs[0].pins, route: 'direct' })
const setParam = (instanceId: string, paramId: string, value: string): CircuitAction => ({ type: 'setParam', instanceId, paramId, value })

describe('외부 전원 종류 데이터', () => {
  it('외부 전원 부품의 [전원 종류] 선택지는 전원 예시 목록과 같고, 각 예시의 전압·전류를 고를 수 있다', () => {
    const module = getModule('external-power')
    const kind = module.parameters!.find((p) => p.id === 'supply')!
    expect(kind.defaultValue).toBe('custom')
    expect(kind.options.map((o) => o.value)).toEqual(['custom', ...SUPPLIES.map((s) => s.id)])
    const volts = module.parameters!.find((p) => p.id === 'voltage')!.options.map((o) => o.number)
    const amps = module.parameters!.find((p) => p.id === 'current')!.options.map((o) => o.number)
    for (const s of SUPPLIES) {
      expect(kind.options.find((o) => o.value === s.id)!.label).toBe(s.name)
      expect(volts, s.id).toContain(s.voltage)
      expect(amps, s.id).toContain(s.maxCurrentMa)
    }
  })
})

describe('외부 전원 종류 기록', () => {
  it('전원 예시를 적용하면 그 종류를 기록한다', () => {
    const s = apply(motorRig(), 'liion-2s')
    const supply = s.placed.at(-1)!
    expect(supply.params).toMatchObject({ supply: 'liion-2s', voltage: '7.4', current: '5000' })
  })

  it('놓아서 자동 연결하면 고른 예시를 종류로 기록한다', () => {
    const s0 = motorRig()
    const example = analyzePower(circuitOf(s0)).needs[0].examples[0]
    const s1 = circuitReducer(s0, { type: 'addModule', moduleId: 'external-power', autoConnect: true, route: 'direct' })
    expect(s1.placed.at(-1)!.params.supply).toBe(example.id)
  })

  it('라이브러리에서 그냥 놓은 외부 전원은 직접 설정이다', () => {
    const s = run([add('external-power')])
    expect(s.placed[0].params.supply).toBe('custom')
  })

  it('종류를 고르면 전압·전류가 그 제품에 맞춰진다', () => {
    const s = run([add('external-power'), setParam('external-power#1', 'supply', 'adapter-12v5a')])
    expect(s.placed[0].params).toMatchObject({ supply: 'adapter-12v5a', voltage: '12', current: '5000' })
  })

  it('전압이나 전류를 따로 바꾸면 그 제품과 달라지므로 직접 설정으로 바뀐다', () => {
    const s0 = run([add('external-power'), setParam('external-power#1', 'supply', 'adapter-12v5a')])
    expect(circuitReducer(s0, setParam('external-power#1', 'voltage', '9')).placed[0].params.supply).toBe('custom')
    expect(circuitReducer(s0, setParam('external-power#1', 'current', '2000')).placed[0].params.supply).toBe('custom')
    // 같은 값으로 다시 고르면 그대로 둔다
    expect(circuitReducer(s0, setParam('external-power#1', 'voltage', '12')).placed[0].params.supply).toBe('adapter-12v5a')
  })

  it('전원을 합쳐 전류가 바뀌면 원래 제품과 맞지 않으므로 직접 설정으로 바뀐다', () => {
    const s0 = apply(apply(motorRig(), 'adapter-6v3a'), 'adapter-6v3a')
    const [a, b] = s0.placed.filter((p) => p.moduleId === 'external-power')
    const s1 = circuitReducer(s0, { type: 'mergeSupplies', keepId: a.instanceId, otherIds: [b.instanceId] })
    expect(s1.placed.find((p) => p.instanceId === a.instanceId)!.params.supply).toBe('custom')
  })
})

describe('전원 탭에 보일 외부 전원 정보', () => {
  it('기록된 제품의 이름·종류·용량과, 지금 쓰는 전류로 계산한 배터리 사용 시간을 알려 준다', () => {
    const s = apply(motorRig(), 'liion-2s')
    const circuit = circuitOf(s)
    const [info] = placedSupplies(circuit, analyzePower(circuit))
    expect(info.supply?.name).toBe('18650 리튬이온 2개 (7.4 V)')
    expect(info.supply?.kind).toBe('battery')
    expect(info.voltage).toBe(7.4)
    expect(info.limitMa).toBe(5000)
    expect(info.source?.typicalMa).toBeGreaterThan(0)
    expect(info.runtimeHours).toBeCloseTo(2600 / info.source!.typicalMa, 1)
    expect(info.loads.map((l) => l.label)).toContain('L298N 모터 드라이버 1')
  })

  it('직접 설정한 전원은 같은 전압에 전류가 충분한 제품 예를 알려 준다', () => {
    const s = run([add('external-power'), setParam('external-power#1', 'voltage', '12'), setParam('external-power#1', 'current', '2000')])
    const circuit = circuitOf(s)
    const [info] = placedSupplies(circuit, analyzePower(circuit))
    expect(info.supply).toBeNull()
    expect(info.matches.map((m) => m.id)).toEqual(['adapter-12v2a', 'adapter-12v5a', 'smps-12v10a', 'sla-12v7ah'])
    expect(info.matches.every((m) => m.voltage === 12 && m.maxCurrentMa >= 2000)).toBe(true)
    expect(findSupply(info.matches[0].id)).toBeTruthy()
  })
})
