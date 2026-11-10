import { describe, expect, it } from 'vitest'
import { circuitOf, circuitReducer, createInitialState, type CircuitAction, type CircuitState } from '../state/circuitState'
import type { Endpoint } from '../types'
import { isPinConnected } from './connections'
import { muxChannelOf } from './mux'
import { validateCircuit } from './validate'

// 핀 공유 확장: 출력 신호 전반, 한 부품 안의 여러 핀, 아날로그 센서(멀티플렉서), 보드 핀에 놓아 묶기

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) => actions.reduce(circuitReducer, state)
const add = (moduleId: string): CircuitAction => ({ type: 'addModule', moduleId })
const mod = (instanceId: string, pinId: string): Endpoint => ({ kind: 'module', instanceId, pinId })
const bp = (pinId: string): Endpoint => ({ kind: 'board', boardInstanceId: 'board-1', pinId })
const link = (a: Endpoint, b: Endpoint): CircuitAction => ({ type: 'connect', from: a, to: b })
const boardPinOf = (s: CircuitState, instanceId: string, pinId: string) =>
  s.connections
    .filter((c) => [c.from, c.to].some((e) => e.kind === 'module' && e.instanceId === instanceId && e.pinId === pinId))
    .flatMap((c) => [c.from, c.to])
    .filter((e) => e.kind === 'board')
    .map((e) => (e as { pinId: string }).pinId)
const issues = (s: CircuitState) => validateCircuit(circuitOf(s))
const errors = (s: CircuitState) => issues(s).filter((i) => i.severity === 'error')

describe('더 많은 부품끼리 핀 공유', () => {
  it('서보 두 개의 신호선을 한 핀에 묶으면 같이 움직이는 그룹이 된다', () => {
    const s = run([add('sg90'), add('sg90'), { type: 'autoAssign' }, link(mod('sg90#2', 'signal'), mod('sg90#1', 'signal'))])
    expect(s.shares).toHaveLength(1)
    expect(boardPinOf(s, 'sg90#2', 'signal')).toEqual(boardPinOf(s, 'sg90#1', 'signal'))
    expect(issues(s).some((i) => i.code === 'pin-conflict')).toBe(false)
    expect(issues(s).find((i) => i.code === 'pin-shared')!.message).toContain('같은 신호')
  })

  it('초음파 센서 두 개의 TRIG 를 함께 쓰고 ECHO 는 따로 쓴다', () => {
    const s = run([add('hc-sr04'), add('hc-sr04'), { type: 'autoAssign' }, link(mod('hc-sr04#2', 'trig'), mod('hc-sr04#1', 'trig'))])
    expect(boardPinOf(s, 'hc-sr04#2', 'trig')).toEqual(boardPinOf(s, 'hc-sr04#1', 'trig'))
    expect(boardPinOf(s, 'hc-sr04#2', 'echo')).not.toEqual(boardPinOf(s, 'hc-sr04#1', 'echo'))
    expect(errors(s)).toEqual([])
  })

  it('스테퍼 드라이버 두 개의 STEP 을 함께 쓸 수 있다', () => {
    const s = run([add('a4988'), add('a4988'), link(mod('a4988#2', 'step'), mod('a4988#1', 'step'))])
    expect(s.shares).toHaveLength(1)
    expect(boardPinOf(s, 'a4988#2', 'step')).toEqual(boardPinOf(s, 'a4988#1', 'step'))
  })

  it('서보 신호와 LED 처럼 신호 종류가 다르면 묶지 않고 종류를 알려 준다', () => {
    const s0 = run([add('sg90'), add('led-5mm'), link(mod('sg90#1', 'signal'), bp('D9'))])
    const s = circuitReducer(s0, link(mod('led-5mm#2', 'anode'), mod('sg90#1', 'signal')))
    expect(s.shares).toEqual([])
    expect(s.statusMessage).toContain('서보 신호')
    expect(s.statusMessage).toContain('함께 쓸 수 없습니다')
  })
})

describe('한 부품 안의 여러 핀 공유', () => {
  it('L298N 의 ENA·ENB 를 PWM 핀 하나에 묶어 두 모터 속도를 같이 정한다', () => {
    const s = run([add('l298n'), link(mod('l298n#1', 'enb'), mod('l298n#1', 'ena'))])
    expect(s.shares).toHaveLength(1)
    const pin = boardPinOf(s, 'l298n#1', 'ena')
    expect(pin).toHaveLength(1)
    expect(boardPinOf(s, 'l298n#1', 'enb')).toEqual(pin)
    expect(issues(s).some((i) => i.code === 'pin-conflict')).toBe(false)
  })

  it('IN1·IN3 처럼 다른 채널의 방향 입력은 묶을 수 있다', () => {
    const s = run([add('l298n'), link(mod('l298n#1', 'in3'), mod('l298n#1', 'in1'))])
    expect(s.shares).toHaveLength(1)
    expect(boardPinOf(s, 'l298n#1', 'in3')).toEqual(boardPinOf(s, 'l298n#1', 'in1'))
  })

  it('같은 채널의 IN1·IN2 를 묶으면 모터가 돌 수 없으므로 막고 이유를 알린다', () => {
    const s0 = run([add('l298n')])
    const s = circuitReducer(s0, link(mod('l298n#1', 'in2'), mod('l298n#1', 'in1')))
    expect(s.shares).toEqual([])
    expect(s.connections).toEqual(s0.connections)
    expect(s.statusMessage).toContain('같은 채널')
  })

  it('EN 과 IN 처럼 역할이 다른 핀은 묶지 않는다', () => {
    const s = run([add('l298n'), link(mod('l298n#1', 'in1'), mod('l298n#1', 'ena'))])
    expect(s.shares).toEqual([])
    expect(s.statusMessage).toContain('함께 쓸 수 없습니다')
  })
})

describe('보드 핀에 놓아 묶기', () => {
  it('같은 종류 신호가 이미 쓰는 보드 핀에 놓으면 그 자리에서 핀 공유 그룹이 된다', () => {
    const s = run([add('led-5mm'), add('led-5mm'), link(mod('led-5mm#1', 'anode'), bp('D5')), link(mod('led-5mm#2', 'anode'), bp('D5'))])
    expect(s.shares).toHaveLength(1)
    expect(issues(s).some((i) => i.code === 'pin-conflict')).toBe(false)
    expect(s.statusMessage).toContain('핀 공유')
  })

  it('종류가 다른 신호가 쓰는 핀에 놓으면 묶지 않고 핀 충돌로 알린다', () => {
    const s = run([add('led-5mm'), add('sg90'), link(mod('led-5mm#1', 'anode'), bp('D5')), link(mod('sg90#2', 'signal'), bp('D5'))])
    expect(s.shares).toEqual([])
    expect(issues(s).some((i) => i.code === 'pin-conflict')).toBe(true)
  })
})

describe('아날로그 센서 여러 개 (멀티플렉서)', () => {
  const twoSensors = () => run([add('potentiometer'), add('ldr-module'), { type: 'autoAssign' }, link(mod('ldr-module#2', 'ao'), mod('potentiometer#1', 'wiper'))])

  it('아날로그 센서 핀끼리 묶으면 16채널 멀티플렉서를 넣어 아날로그 핀 하나로 읽는다', () => {
    const s = twoSensors()
    const mux = s.placed.find((p) => p.moduleId === 'cd74hc4067')!
    expect(mux).toBeTruthy()
    const c = circuitOf(s)
    expect(muxChannelOf(c, 'module:potentiometer#1:wiper')).toMatchObject({ muxId: mux.instanceId, channel: 0 })
    expect(muxChannelOf(c, 'module:ldr-module#2:ao')).toMatchObject({ muxId: mux.instanceId, channel: 1 })
    // 센서는 더 이상 보드 아날로그 핀에 직접 물리지 않는다
    expect(boardPinOf(s, 'potentiometer#1', 'wiper')).toEqual([])
    expect(boardPinOf(s, 'ldr-module#2', 'ao')).toEqual([])
    // SIG 는 아날로그 핀, 채널 2개면 S0 만 디지털 핀, S1–S3·EN 은 GND
    expect(boardPinOf(s, mux.instanceId, 'sig')[0]).toMatch(/^A\d/)
    expect(boardPinOf(s, mux.instanceId, 's0')[0]).toMatch(/^D\d/)
    for (const sel of ['s1', 's2', 's3', 'en']) expect(boardPinOf(s, mux.instanceId, sel)).toEqual(['GND'])
    expect(isPinConnected(s.connections, mux.instanceId, 'vcc')).toBe(true)
    expect(s.shares).toEqual([])
    expect(errors(s)).toEqual([])
    expect(s.statusMessage).toContain('멀티플렉서')
  })

  it('세 번째 센서를 묶으면 다음 채널에 잇고 선택선 S1 을 디지털 핀으로 옮긴다', () => {
    const s0 = twoSensors()
    const s = run([add('soil-moisture'), link(mod('soil-moisture#4', 'ao'), mod('ldr-module#2', 'ao'))], s0)
    const mux = s.placed.find((p) => p.moduleId === 'cd74hc4067')!
    expect(muxChannelOf(circuitOf(s), 'module:soil-moisture#4:ao')).toMatchObject({ muxId: mux.instanceId, channel: 2 })
    expect(boardPinOf(s, mux.instanceId, 's1')[0]).toMatch(/^D\d/)
    expect(boardPinOf(s, mux.instanceId, 's2')).toEqual(['GND'])
    expect(errors(s)).toEqual([])
  })

  it('조이스틱의 X·Y 처럼 한 부품의 아날로그 핀도 멀티플렉서로 묶는다', () => {
    const s = run([add('joystick-ky023'), link(mod('joystick-ky023#1', 'vry'), mod('joystick-ky023#1', 'vrx'))])
    const mux = s.placed.find((p) => p.moduleId === 'cd74hc4067')!
    const c = circuitOf(s)
    expect(muxChannelOf(c, 'module:joystick-ky023#1:vrx')?.muxId).toBe(mux.instanceId)
    expect(muxChannelOf(c, 'module:joystick-ky023#1:vry')?.muxId).toBe(mux.instanceId)
  })

  it('센서 핀을 멀티플렉서 채널에 직접 이어도 선택선을 맞춘다', () => {
    const s = run([add('cd74hc4067'), add('potentiometer'), add('potentiometer'), add('potentiometer'), { type: 'autoAssign' }])
    const s1 = run([link(mod('potentiometer#2', 'wiper'), mod('cd74hc4067#1', 'c0')), link(mod('potentiometer#3', 'wiper'), mod('cd74hc4067#1', 'c1')), link(mod('potentiometer#4', 'wiper'), mod('cd74hc4067#1', 'c2'))], s)
    expect(boardPinOf(s1, 'potentiometer#4', 'wiper')).toEqual([])
    expect(boardPinOf(s1, 'cd74hc4067#1', 's1')[0]).toMatch(/^D\d/)
    expect(errors(s1)).toEqual([])
  })
})

describe('공유 핀이 아닌 핀과는 그냥 잇는다', () => {
  it('서보 신호를 서보 드라이버 채널에 직접 이으면 핀 공유가 아니라 연결이 된다', () => {
    const s = run([add('pca9685'), add('sg90'), link(mod('sg90#2', 'signal'), mod('pca9685#1', 'pwm0'))])
    expect(s.shares).toEqual([])
    expect(s.connections.some((c) => [c.from, c.to].some((e) => e.kind === 'module' && e.pinId === 'pwm0'))).toBe(true)
  })
})
