import { describe, expect, it } from 'vitest'
import { getModule } from '../data/modules'
import { circuitOf, circuitReducer, createInitialState, type CircuitAction, type CircuitState } from '../state/circuitState'
import { isPinConnected } from './connections'
import { driverCapacity, planMotorAttach, recommendDriver } from './motorAttach'
import { analyzePower } from './power'
import { validateCircuit } from './validate'

// 모터 카드를 끌어 모터 드라이버 카드에 놓아 연결하기

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) => actions.reduce(circuitReducer, state)
const add = (moduleId: string): CircuitAction => ({ type: 'addModule', moduleId })
const attach = (motorId: string, driverId: string): CircuitAction => ({ type: 'attachMotor', motorId, driverId, route: 'direct' })
const wiredTo = (s: CircuitState, instanceId: string, pinId: string) =>
  s.connections.filter((c) => [c.from, c.to].some((e) => e.kind === 'module' && e.instanceId === instanceId && e.pinId === pinId)).map((c) => (c.from.kind === 'module' && c.from.instanceId === instanceId && c.from.pinId === pinId ? c.to : c.from))

describe('모터를 드라이버에 끌어 놓아 연결', () => {
  it('DC 모터를 L298N 에 놓으면 빈 채널 출력에 모터 단자가 이어지고, 그 채널의 제어 핀도 보드에 배정된다', () => {
    const s = run([add('l298n'), add('dc-gear-tt'), attach('dc-gear-tt#2', 'l298n#1')])
    expect(wiredTo(s, 'dc-gear-tt#2', 'm1')).toEqual([{ kind: 'module', instanceId: 'l298n#1', pinId: 'out1' }])
    expect(wiredTo(s, 'dc-gear-tt#2', 'm2')).toEqual([{ kind: 'module', instanceId: 'l298n#1', pinId: 'out2' }])
    for (const pin of ['ena', 'in1', 'in2']) expect(isPinConnected(s.connections, 'l298n#1', pin), pin).toBe(true)
    expect(isPinConnected(s.connections, 'l298n#1', 'in3')).toBe(false)
    expect(s.statusMessage).toContain('모터 A')
    expect(s.statusMessage).toContain('1/2')
  })

  it('두 번째 모터는 다음 채널로 가고, 최대 개수를 넘으면 막는다', () => {
    const s = run([add('l298n'), add('dc-gear-tt'), add('dc-gear-tt'), add('dc-gear-tt'), attach('dc-gear-tt#2', 'l298n#1'), attach('dc-gear-tt#3', 'l298n#1')])
    expect(wiredTo(s, 'dc-gear-tt#3', 'm1')).toEqual([{ kind: 'module', instanceId: 'l298n#1', pinId: 'out3' }])
    expect(s.statusMessage).toContain('2/2')
    const full = circuitReducer(s, attach('dc-gear-tt#4', 'l298n#1'))
    expect(full.connections).toEqual(s.connections)
    expect(full.statusMessage).toContain('최대 2개')
  })

  it('드라이버가 다루지 않는 종류의 모터는 막고 맞는 드라이버를 알려 준다', () => {
    const s = run([add('l298n'), add('stepper-nema17')])
    const plan = planMotorAttach(circuitOf(s), 'stepper-nema17#2', 'l298n#1')
    expect(plan.ok).toBe(false)
    expect(!plan.ok && plan.reason).toContain('DC 모터')
    expect(!plan.ok && plan.reason).toContain('A4988')
    expect(circuitReducer(s, attach('stepper-nema17#2', 'l298n#1')).connections).toEqual([])
  })

  it('서보 모터를 DC 모터 드라이버에 놓으면 보드 PWM 핀에 바로 연결하라고 알린다', () => {
    const s = run([add('l298n'), add('sg90')])
    const plan = planMotorAttach(circuitOf(s), 'sg90#2', 'l298n#1')
    expect(plan.ok).toBe(false)
    expect(!plan.ok && plan.reason).toContain('서보')
    expect(!plan.ok && plan.reason).toContain('PWM')
  })

  it('유니폴라 스테퍼는 ULN2003 의 다섯 출력에 모두 이어진다', () => {
    const s = run([add('uln2003'), add('stepper-28byj48'), attach('stepper-28byj48#2', 'uln2003#1')])
    for (const [m, d] of [['a', 'oa'], ['b', 'ob'], ['c', 'oc'], ['d', 'od'], ['com', 'ocom']])
      expect(wiredTo(s, 'stepper-28byj48#2', m)).toEqual([{ kind: 'module', instanceId: 'uln2003#1', pinId: d }])
  })

  it('다른 드라이버에 물려 있던 모터를 옮기면 예전 전선은 떼고 새 드라이버에 잇는다', () => {
    const s = run([add('l298n'), add('tb6612fng'), add('dc-gear-tt'), attach('dc-gear-tt#3', 'l298n#1'), attach('dc-gear-tt#3', 'tb6612fng#2')])
    expect(wiredTo(s, 'dc-gear-tt#3', 'm1')).toEqual([{ kind: 'module', instanceId: 'tb6612fng#2', pinId: 'ao1' }])
    expect(isPinConnected(s.connections, 'l298n#1', 'out1')).toBe(false)
  })

  it('연결한 모터 카드는 드라이버 옆으로 옮겨 배선을 정리하고, 실행 취소된다', () => {
    const before = run([add('l298n'), add('dc-gear-tt'), { type: 'moveModule', instanceId: 'dc-gear-tt#2', position: { x: 1500, y: 1000 } }])
    const driver = before.placed[0]
    const s = circuitReducer(before, attach('dc-gear-tt#2', 'l298n#1'))
    const motor = s.placed.find((p) => p.instanceId === 'dc-gear-tt#2')!
    expect(Math.abs(motor.x - driver.x)).toBeLessThan(400)
    expect(Math.abs(motor.y - driver.y)).toBeLessThan(300)
    expect(circuitReducer(s, { type: 'undo' }).connections).toEqual(before.connections)
  })

  it('드라이버 용량: 종류별 최대 모터 수', () => {
    expect(driverCapacity(getModule('l298n'))).toEqual([{ kind: 'dc', max: 2 }])
    expect(driverCapacity(getModule('a4988'))).toEqual([{ kind: 'stepper-bipolar', max: 1 }])
  })

  it('맞는 드라이버 추천: 모터 종류·전압·전류에 맞는 드라이버', () => {
    expect(recommendDriver(getModule('dc-gear-tt'))?.driver?.channels[0].accepts).toContain('dc')
    expect(recommendDriver(getModule('stepper-nema17'))?.id).toMatch(/a4988|drv8825/)
    expect(recommendDriver(getModule('stepper-28byj48'))?.id).toBe('uln2003')
    expect(recommendDriver(getModule('bldc-a2212'))?.id).toBe('esc-30a')
    expect(recommendDriver(getModule('led-5mm'))).toBeNull()
  })

  it('[맞는 드라이버 추가] 는 드라이버를 놓고 모터를 연결한다', () => {
    const s = run([add('dc-gear-tt'), { type: 'addDriverFor', motorId: 'dc-gear-tt#1', route: 'direct' }])
    const driver = s.placed.find((p) => getModule(p.moduleId).driver)!
    expect(driver).toBeDefined()
    expect(wiredTo(s, 'dc-gear-tt#1', 'm1')[0]).toMatchObject({ instanceId: driver.instanceId })
  })
})

describe('서보 드라이버 (PCA9685)', () => {
  const pca = () => run([add('pca9685'), add('sg90'), add('mg996r')])

  it('서보를 PCA9685 에 놓으면 신호는 채널에, 전원은 V+ 에, GND 는 GND 에 이어지고 I²C·로직 전원이 배정된다', () => {
    const s = run([attach('sg90#2', 'pca9685#1')], pca())
    expect(wiredTo(s, 'sg90#2', 'signal')).toEqual([{ kind: 'module', instanceId: 'pca9685#1', pinId: 'pwm0' }])
    expect(wiredTo(s, 'sg90#2', 'vcc')).toEqual([{ kind: 'module', instanceId: 'pca9685#1', pinId: 'vplus' }])
    expect(wiredTo(s, 'sg90#2', 'gnd')).toEqual([{ kind: 'module', instanceId: 'pca9685#1', pinId: 'gnd' }])
    for (const pin of ['sda', 'scl', 'vcc']) expect(isPinConnected(s.connections, 'pca9685#1', pin), pin).toBe(true)
    expect(wiredTo(s, 'pca9685#1', 'gnd').some((e) => e.kind === 'board')).toBe(true)
    expect(s.statusMessage).toContain('서보 0')
    expect(s.statusMessage).toContain('1/16')
  })

  it('보드에 직접 물려 있던 서보를 옮기면 예전 전선을 뗀다', () => {
    const s0 = run([{ type: 'autoAssign' }], pca())
    expect(wiredTo(s0, 'sg90#2', 'signal')[0].kind).toBe('board')
    const s = circuitReducer(s0, attach('sg90#2', 'pca9685#1'))
    expect(wiredTo(s, 'sg90#2', 'signal')).toEqual([{ kind: 'module', instanceId: 'pca9685#1', pinId: 'pwm0' }])
    expect(wiredTo(s, 'sg90#2', 'vcc').every((e) => e.kind === 'module')).toBe(true)
  })

  it('16개까지 받고, 17번째는 막는다', () => {
    let s = run([add('pca9685'), ...Array.from({ length: 17 }, () => add('sg90'))])
    for (let i = 2; i <= 17; i++) s = circuitReducer(s, attach(`sg90#${i}`, 'pca9685#1'))
    expect(s.statusMessage).toContain('16/16')
    const full = circuitReducer(s, attach('sg90#18', 'pca9685#1'))
    expect(full.connections).toEqual(s.connections)
    expect(full.statusMessage).toContain('최대 16개')
  })

  it('DC 모터는 서보 드라이버에 연결하지 않고, 서보는 DC 드라이버 대신 PCA9685 를 알려 준다', () => {
    const s = run([add('pca9685'), add('dc-gear-tt'), add('l298n'), add('sg90')])
    const dc = planMotorAttach(circuitOf(s), 'dc-gear-tt#2', 'pca9685#1')
    expect(!dc.ok && dc.reason).toContain('서보 모터용')
    const servo = planMotorAttach(circuitOf(s), 'sg90#4', 'l298n#3')
    expect(!servo.ok && servo.reason).toContain('PCA9685')
  })

  it('외부 전원 수요에 서보 전류가 들어가고, 외부 전원을 놓으면 V+ 에 연결되어 오류가 없다', () => {
    const s0 = run([attach('sg90#2', 'pca9685#1'), attach('mg996r#3', 'pca9685#1')], pca())
    const need = analyzePower(circuitOf(s0)).needs.find((n) => n.pins.includes('module:pca9685#1:vplus'))!
    expect(need.consumers.map((c) => c.instanceId)).toEqual(expect.arrayContaining(['sg90#2', 'mg996r#3']))
    expect(need.peakMa).toBeGreaterThanOrEqual(2500)
    expect(analyzePower(circuitOf(s0)).needs).toHaveLength(1)
    const s1 = circuitReducer(s0, { type: 'addModule', moduleId: 'external-power', autoConnect: true, near: 'pca9685#1', route: 'direct' })
    const errors = validateCircuit(circuitOf(s1)).filter((i) => i.severity === 'error')
    expect(errors.map((e) => `${e.code}: ${e.message}`)).toEqual([])
  })

  it('[전원] 탭·카드의 연결 단추로 전원을 붙여도 서보 전원선은 V+ 에 그대로 남는다', () => {
    const s0 = run([attach('sg90#2', 'pca9685#1'), attach('mg996r#3', 'pca9685#1')], pca())
    const need = analyzePower(circuitOf(s0)).needs[0]
    const s1 = circuitReducer(s0, { type: 'applySupply', supplyId: need.examples[0].id, pins: need.pins, route: 'direct' })
    expect(wiredTo(s1, 'sg90#2', 'vcc')).toEqual([{ kind: 'module', instanceId: 'pca9685#1', pinId: 'vplus' }])
    expect(wiredTo(s1, 'mg996r#3', 'vcc')).toEqual([{ kind: 'module', instanceId: 'pca9685#1', pinId: 'vplus' }])
    expect(validateCircuit(circuitOf(s1)).filter((i) => i.severity !== 'info').map((i) => i.message)).toEqual([])
    const supply = s1.placed.at(-1)!
    expect(analyzePower(circuitOf(s1)).needs[0].servedBy).toBe(supply.label)
    expect(wiredTo(s1, 'pca9685#1', 'vplus')).toContainEqual({ kind: 'module', instanceId: supply.instanceId, pinId: 'plus' })
  })

  it('외부 전원이 꼭 필요한 V+ 에 서보만 물리고 전원이 없으면 오류로 알린다', () => {
    const s = run([attach('sg90#2', 'pca9685#1')], pca())
    const issue = validateCircuit(circuitOf(s)).find((i) => i.code === 'supply-missing')!
    expect(issue.severity).toBe('error')
    expect(issue.message).toContain('V+')
  })

  it('외부 전원을 놓아 자동 연결해도 V+ 에 + 가 이어진다', () => {
    const s0 = run([attach('sg90#2', 'pca9685#1')], pca())
    const s1 = circuitReducer(s0, { type: 'addModule', moduleId: 'external-power', autoConnect: true, near: 'pca9685#1', route: 'direct' })
    expect(analyzePower(circuitOf(s1)).needs[0].servedBy).toBe(s1.placed.at(-1)!.label)
    expect(validateCircuit(circuitOf(s1)).some((i) => i.code === 'supply-missing')).toBe(false)
  })

  it('용량: 서보 최대 16개', () => {
    expect(driverCapacity(getModule('pca9685'))).toEqual([{ kind: 'servo', max: 16 }])
  })
})
