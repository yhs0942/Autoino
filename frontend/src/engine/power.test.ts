import { describe, expect, it } from 'vitest'
import { SUPPLIES } from '../data/supplies'
import { getModule } from '../data/modules'
import { circuitOf, circuitReducer, createInitialState, type CircuitAction, type CircuitState } from '../state/circuitState'
import type { Endpoint } from '../types'
import { analyzePower } from './power'
import { endpointKey } from './connections'
import { validateCircuit } from './validate'

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) => actions.reduce(circuitReducer, state)
const add = (moduleId: string): CircuitAction => ({ type: 'addModule', moduleId })
const mod = (instanceId: string, pinId: string): Endpoint => ({ kind: 'module', instanceId, pinId })
const bp = (pinId: string): Endpoint => ({ kind: 'board', boardInstanceId: 'board-1', pinId })
const connect = (from: Endpoint, to: Endpoint): CircuitAction => ({ type: 'connect', from, to })
const auto: CircuitAction = { type: 'autoAssign' }
const report = (s: CircuitState) => analyzePower(circuitOf(s))

describe('필요한 외부 전원 계산', () => {
  it('L298N + TT 모터 2개: 드라이버 전압 강하를 더한 전압 범위와 전류', () => {
    const r = report(run([add('l298n'), add('dc-gear-tt'), add('dc-gear-tt'), auto]))
    expect(r.needs).toHaveLength(1)
    const [need] = r.needs
    expect(need.minVoltage).toBe(7) // max(드라이버 7 V, 모터 3 V + 강하 2 V)
    expect(need.maxVoltage).toBe(8) // 모터 6 V + 강하 2 V
    expect(need.targetVoltage).toBe(8)
    expect(need.typicalMa).toBe(40 + 160 * 2)
    expect(need.peakMa).toBe(60 + 1500 * 2)
    expect(need.minimumMa).toBe(500) // 360 × 1.25 = 450 → 100 mA 단위 올림
    expect(need.recommendedMa).toBe(3100)
    expect(need.pins).toEqual(['module:l298n#1:vs'])
    expect(need.consumers.map((c) => c.label)).toEqual(['L298N 모터 드라이버 1', 'TT 기어드 모터 1', 'TT 기어드 모터 2'])
  })

  it('예시는 전압 범위 안에서 권장 전류를 만족하는 것부터, 목표 전압에 가까운 순서로 보여 준다', () => {
    const [need] = report(run([add('l298n'), add('dc-gear-tt'), add('dc-gear-tt'), auto])).needs
    expect(need.examples.length).toBeGreaterThan(0)
    expect(need.examples.length).toBeLessThanOrEqual(4)
    for (const e of need.examples) {
      expect(e.voltage).toBeGreaterThanOrEqual(need.minVoltage)
      expect(e.voltage).toBeLessThanOrEqual(need.maxVoltage)
      expect(e.maxCurrentMa).toBeGreaterThanOrEqual(need.minimumMa)
    }
    expect(need.examples[0].level).toBe('recommended')
    // 7.5 V 어댑터는 2 A 라 권장 전류(3.1 A)에 못 미치므로 5 A 리튬이온 7.4 V 가 먼저 나온다
    expect(need.examples[0].id).toBe('liion-2s')
    const levels = need.examples.map((e) => e.level)
    expect(levels.lastIndexOf('recommended')).toBeLessThan(levels.indexOf('minimum') === -1 ? 99 : levels.indexOf('minimum'))
  })

  it('배터리 예시에는 예상 사용 시간을 계산한다', () => {
    const [need] = report(run([add('l298n'), add('dc-gear-tt'), auto])).needs
    const battery = need.examples.find((e) => e.capacityMah)
    expect(battery).toBeDefined()
    expect(battery!.runtimeHours).toBeCloseTo(battery!.capacityMah! / need.typicalMa, 1)
  })

  it('서보 여러 개: 공통 전압과 스톨 전류의 합', () => {
    const [need] = report(run([add('mg996r'), add('mg996r'), add('mg90s')])).needs
    expect(need.minVoltage).toBe(4.8)
    expect(need.maxVoltage).toBe(6)
    expect(need.typicalMa).toBe(700 + 700 + 250)
    expect(need.peakMa).toBe(2500 + 2500 + 1200)
    expect(need.recommendedMa).toBe(6200)
    expect(need.examples[0].maxCurrentMa).toBeGreaterThanOrEqual(6200)
  })

  it('전압 범위가 겹치면 전원 하나로 묶고, 겹치지 않으면 나눈다', () => {
    const shared = report(run([add('sg90'), add('tb6612fng'), add('dc-gear-tt'), auto]))
    expect(shared.needs).toHaveLength(1)
    expect(shared.needs[0].minVoltage).toBe(4.8)
    expect(shared.needs[0].maxVoltage).toBe(6)
    const split = report(run([add('sg90'), add('a4988'), add('stepper-nema17'), auto]))
    expect(split.needs).toHaveLength(2)
    expect(split.needs.map((n) => n.maxVoltage)).toEqual([6, 35])
  })

  it('외부 전원이 필요 없는 회로는 필요 항목이 없다', () => {
    expect(report(run([add('led-5mm'), add('hc-sr04'), auto])).needs).toEqual([])
    expect(report(createInitialState()).needs).toEqual([])
  })

  it('LED 스트립 전류는 개수에 비례한다', () => {
    const s = run([add('neopixel-strip'), { type: 'setParam', instanceId: 'neopixel-strip#1', paramId: 'count', value: '30' }])
    const [need] = report(s).needs
    expect(need.typicalMa).toBe(600)
    expect(need.peakMa).toBe(1800)
  })

  it('드라이버 없는 모터도 모터 자체 사양으로 안내한다', () => {
    const [need] = report(run([add('dc-gear-25ga370')])).needs
    expect(need.minVoltage).toBe(6)
    expect(need.maxVoltage).toBe(12)
    expect(need.pins).toEqual([])
  })

  it('이미 연결된 외부 전원을 표시한다', () => {
    const s = run([add('external-power'), add('l298n'), add('dc-gear-tt'), { type: 'setParam', instanceId: 'external-power#1', paramId: 'voltage', value: '7.4' }, auto])
    expect(report(s).needs[0].servedBy).toBe('외부 전원 1')
  })

  it('벅 컨버터 출력의 서보는 입력 쪽 전원 수요로 넘어간다', () => {
    const s = run([
      add('buck-lm2596'), add('sg90'),
      connect(mod('sg90#2', 'vcc'), mod('buck-lm2596#1', 'vout')),
    ])
    const r = report(s)
    expect(r.needs).toHaveLength(1)
    expect(r.needs[0].pins).toEqual(['module:buck-lm2596#1:vin'])
    expect(r.needs[0].typicalMa).toBe(5 + 250)
    expect(r.needs[0].minVoltage).toBe(4.5)
  })
})

describe('현재 전원 상태', () => {
  it('외부 전원의 부하 합계와 상태', () => {
    const s = run([
      add('external-power'), add('l298n'), add('dc-gear-tt'),
      { type: 'setParam', instanceId: 'external-power#1', paramId: 'voltage', value: '7.4' },
      { type: 'setParam', instanceId: 'external-power#1', paramId: 'current', value: '5000' },
      auto,
    ])
    const source = report(s).sources.find((x) => x.kind === 'external')!
    expect(source.label).toBe('외부 전원 1')
    expect(source.voltage).toBe(7.4)
    expect(source.limitMa).toBe(5000)
    expect(source.typicalMa).toBe(200)
    expect(source.peakMa).toBe(1560)
    expect(source.status).toBe('ok')
  })

  it('보드 5V 는 USB 여유 전류를 기준으로 본다', () => {
    const s = run([add('hc-sr04'), add('i2c-lcd-1602'), auto])
    const source = report(s).sources.find((x) => x.label === '보드 5V')!
    expect(source.kind).toBe('board')
    expect(source.typicalMa).toBe(15 + 25)
    expect(source.limitMa).toBe(400)
  })

  it('소비 전류를 모르는 부품은 따로 적는다', () => {
    const s = run([add('voltage-divider'), add('i2c-lcd-1602'), auto])
    expect(report(s).sources.find((x) => x.label === '보드 5V')!.unknown).toEqual([])
  })

  it('연결되지 않은 외부 전원은 사용 안 함으로 표시한다', () => {
    expect(report(run([add('external-power')])).sources).toMatchObject([{ kind: 'external', status: 'unused', loads: [] }])
  })

  it('레귤레이터도 전원으로 표시하고 출력 부하를 보여 준다', () => {
    const s = run([add('buck-lm2596'), add('sg90'), connect(mod('sg90#2', 'vcc'), mod('buck-lm2596#1', 'vout'))])
    const source = report(s).sources.find((x) => x.kind === 'regulator')!
    expect(source.voltage).toBe(5)
    expect(source.limitMa).toBe(2000)
    expect(source.typicalMa).toBe(250)
  })
})

describe('전원 예시 적용', () => {
  it('예시를 고르면 외부 전원을 놓고 전원·GND 를 연결해 오류가 없어진다', () => {
    const before = run([add('l298n'), add('dc-gear-tt'), auto])
    const [need] = report(before).needs
    const example = need.examples[0]
    const s = circuitReducer(before, { type: 'applySupply', supplyId: example.id, pins: need.pins, route: 'direct' })
    const placed = s.placed.find((p) => p.moduleId === 'external-power')!
    expect(Number(placed.params.voltage)).toBe(example.voltage)
    expect(Number(placed.params.current)).toBe(example.maxCurrentMa)
    expect(placed.label).toBe('외부 전원 1')
    const keys = s.connections.flatMap((c) => [endpointKey(c.from), endpointKey(c.to)])
    expect(keys).toContain(`module:${placed.instanceId}:plus`)
    expect(keys).toContain(`module:${placed.instanceId}:minus`)
    expect(validateCircuit(circuitOf(s)).filter((i) => i.severity === 'error')).toEqual([])
    expect(s.statusMessage).toContain(example.name)
  })

  it('보드 5V 에 물려 있던 서보를 외부 전원으로 옮기고, 실행 취소로 되돌릴 수 있다', () => {
    const before = run([add('sg90'), auto])
    const [need] = report(before).needs
    const adapter = need.examples.find((e) => e.voltage === 5)!
    const s = circuitReducer(before, { type: 'applySupply', supplyId: adapter.id, pins: need.pins, route: 'direct' })
    const placed = s.placed.find((p) => p.moduleId === 'external-power')!
    const vcc = s.connections.filter((c) => [c.from, c.to].some((e) => e.kind === 'module' && e.instanceId === 'sg90#1' && e.pinId === 'vcc'))
    expect(vcc).toHaveLength(1)
    expect(endpointKey(vcc[0].to)).toBe(`module:${placed.instanceId}:plus`)
    const undone = circuitReducer(s, { type: 'undo' })
    expect(undone.placed.some((p) => p.moduleId === 'external-power')).toBe(false)
    expect(undone.connections.length).toBe(before.connections.length)
  })

  it('보드 GND 에 물려 있던 드라이버 GND 도 전원 − 로 옮겨 모터 전류가 보드를 지나지 않게 한다', () => {
    const before = run([add('l298n'), add('dc-gear-tt'), auto])
    expect(before.connections.some((c) => endpointKey(c.from) === 'module:l298n#1:gnd' && endpointKey(c.to) === 'board:board-1:GND')).toBe(true)
    const [need] = report(before).needs
    const s = circuitReducer(before, { type: 'applySupply', supplyId: need.examples[0].id, pins: need.pins, route: 'direct' })
    const placed = s.placed.find((p) => p.moduleId === 'external-power')!
    const ground = s.connections.filter((c) => endpointKey(c.from) === 'module:l298n#1:gnd' || endpointKey(c.to) === 'module:l298n#1:gnd')
    expect(ground.map((c) => endpointKey(c.to))).toEqual([`module:${placed.instanceId}:minus`])
    expect(validateCircuit(circuitOf(s)).filter((i) => i.severity === 'error')).toEqual([])
  })

  it('없는 예시 ID 는 무시한다', () => {
    const before = run([add('sg90')])
    expect(circuitReducer(before, { type: 'applySupply', supplyId: 'nope', pins: [], route: 'direct' }).placed).toHaveLength(1)
  })
})

describe('전원 예시 데이터', () => {
  it('모든 예시의 전압·전류가 외부 전원 부품의 설정 값에 있다', () => {
    const params = getModule('external-power').parameters!
    const voltages = params.find((p) => p.id === 'voltage')!.options.map((o) => o.number)
    const currents = params.find((p) => p.id === 'current')!.options.map((o) => o.number)
    for (const s of SUPPLIES) {
      expect(voltages, s.id).toContain(s.voltage)
      expect(currents, s.id).toContain(s.maxCurrentMa)
    }
  })

  it('ID 가 겹치지 않는다', () => {
    expect(new Set(SUPPLIES.map((s) => s.id)).size).toBe(SUPPLIES.length)
  })
})

describe('핀 쓰임 표시', () => {
  it('보드 버튼을 쓰지 않아도 VIN 은 전원 입력으로 계산된다', () => {
    const s = run([add('external-power'), connect(mod('external-power#1', 'plus'), bp('VIN'))])
    const source = report(s).sources[0]
    expect(source.loads.map((l) => l.label)).toEqual(['보드 VIN'])
    expect(source.typicalMa).toBeGreaterThan(0)
  })
})
