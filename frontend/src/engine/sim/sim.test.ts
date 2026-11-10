import { describe, expect, it } from 'vitest'
import { circuitOf, circuitReducer, createInitialState, type CircuitAction, type CircuitState } from '../../state/circuitState'
import type { Endpoint } from '../../types'
import { analyzePower } from '../power'
import { validateCircuit } from '../validate'
import { SimRuntime, type ModuleView } from './runtime'

// 시뮬레이션: 생성 코드와 같은 동작을 시간에 따라 돌리고, 배선·전원 상태에 따라 부품이 실제로 움직이는지 보여 준다

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) => actions.reduce(circuitReducer, state)
const add = (moduleId: string): CircuitAction => ({ type: 'addModule', moduleId })
const mod = (instanceId: string, pinId: string): Endpoint => ({ kind: 'module', instanceId, pinId })
const bp = (pinId: string): Endpoint => ({ kind: 'board', boardInstanceId: 'board-1', pinId })
const link = (a: Endpoint, b: Endpoint): CircuitAction => ({ type: 'connect', from: a, to: b })
const sim = (s: CircuitState) => {
  const circuit = circuitOf(s)
  return new SimRuntime(circuit, { issues: validateCircuit(circuit), power: analyzePower(circuit) })
}
const at = (r: SimRuntime, ms: number) => {
  r.step(ms - r.t)
  return r
}
const view = <K extends ModuleView['kind']>(r: SimRuntime, id: string, kind: K) => {
  const v = r.view().modules.get(id)!
  expect(v.kind).toBe(kind)
  return v as Extract<ModuleView, { kind: K }>
}

describe('LED · 출력', () => {
  it('생성 코드처럼 0.5초마다 깜박인다', () => {
    const r = sim(run([add('led-5mm'), { type: 'autoAssign' }]))
    expect(view(at(r, 250), 'led-5mm#1', 'led').on).toBe(false)
    expect(view(at(r, 750), 'led-5mm#1', 'led').on).toBe(true)
    expect(view(r, 'led-5mm#1', 'led').ok).toBe(true)
  })

  it('GND 가 연결되지 않으면 켜지지 않고 이유를 알린다', () => {
    const r = sim(run([add('led-5mm'), link(mod('led-5mm#1', 'anode'), bp('D5'))]))
    const v = view(at(r, 750), 'led-5mm#1', 'led')
    expect(v.on).toBe(false)
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('GND')
  })

  it('핀을 함께 쓰는 LED 는 같이 켜진다', () => {
    const r = sim(run([add('led-5mm'), add('led-5mm'), { type: 'autoAssign' }, link(mod('led-5mm#2', 'anode'), mod('led-5mm#1', 'anode'))]))
    at(r, 750)
    expect(view(r, 'led-5mm#1', 'led').on).toBe(true)
    expect(view(r, 'led-5mm#2', 'led').on).toBe(true)
  })

  it('릴레이는 1초마다 붙었다 떨어지고(LOW 에서 켜짐), 부저는 1초마다 울린다', () => {
    const r = sim(run([add('relay-1ch'), add('active-buzzer'), { type: 'autoAssign' }]))
    expect(view(at(r, 500), 'relay-1ch#1', 'relay').on).toBe(false)
    expect(view(at(r, 1500), 'relay-1ch#1', 'relay').on).toBe(true)
    expect(view(r, 'active-buzzer#2', 'buzzer').on).toBe(true)
  })
})

describe('모터', () => {
  const rig = (withPower: boolean) =>
    run([
      add('l298n'), add('dc-gear-tt'),
      { type: 'attachMotor', motorId: 'dc-gear-tt#2', driverId: 'l298n#1', route: 'direct' },
      ...(withPower ? [{ type: 'addModule', moduleId: 'external-power', autoConnect: true, near: 'l298n#1', route: 'direct' } as CircuitAction] : []),
      { type: 'autoAssign' },
    ])

  it('드라이버를 거쳐 정방향 → 정지 → 역방향 → 정지로 돈다', () => {
    const r = sim(rig(true))
    expect(view(at(r, 2500), 'dc-gear-tt#2', 'motor').speed).toBeGreaterThan(0.5)
    expect(view(at(r, 4500), 'dc-gear-tt#2', 'motor').speed).toBe(0)
    expect(view(at(r, 6500), 'dc-gear-tt#2', 'motor').speed).toBeLessThan(-0.5)
    expect(view(at(r, 6500), 'dc-gear-tt#2', 'motor').rpm).toBeGreaterThan(50)
  })

  it('모터 전원이 없으면 돌지 않고 이유를 알린다', () => {
    const r = sim(rig(false))
    const v = view(at(r, 2500), 'dc-gear-tt#2', 'motor')
    expect(v.speed).toBe(0)
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/전원/)
  })

  it('서보는 20 ms 마다 2° 씩 0°–180° 를 왕복한다', () => {
    const r = sim(run([add('sg90'), { type: 'autoAssign' }]))
    expect(view(at(r, 200), 'sg90#1', 'servo').angle).toBe(20)
    expect(view(at(r, 2000), 'sg90#1', 'servo').angle).toBe(160) // 90틱에 180° 에서 돌아와 100틱이면 160°
  })

  it('스테퍼(28BYJ-48 + ULN2003)는 코일 LED 가 차례로 켜지며 돈다', () => {
    const r = sim(run([add('uln2003'), add('stepper-28byj48'), { type: 'attachMotor', motorId: 'stepper-28byj48#2', driverId: 'uln2003#1', route: 'direct' }, { type: 'autoAssign' }]))
    const d = view(at(r, 4), 'uln2003#1', 'driver')
    expect(d.leds?.filter(Boolean)).toHaveLength(2)
    const a1 = view(at(r, 1000), 'stepper-28byj48#2', 'stepper').angle
    const a2 = view(at(r, 2000), 'stepper-28byj48#2', 'stepper').angle
    expect(a2).toBeGreaterThan(a1)
  })

  it('서보 드라이버(PCA9685)의 서보도 움직인다', () => {
    const s = run([
      add('pca9685'), add('sg90'),
      { type: 'attachMotor', motorId: 'sg90#2', driverId: 'pca9685#1', route: 'direct' },
      { type: 'addModule', moduleId: 'external-power', autoConnect: true, near: 'pca9685#1', route: 'direct' },
      { type: 'autoAssign' },
    ])
    expect(view(at(sim(s), 400), 'sg90#2', 'servo').angle).toBe(40)
  })
})

describe('입력 · 시리얼 모니터', () => {
  it('버튼을 누르면 생성 코드처럼 pressed 를 출력한다', () => {
    const r = sim(run([add('push-button'), { type: 'autoAssign' }]))
    at(r, 100)
    r.setInput('push-button#1', { pressed: true })
    at(r, 200)
    expect(r.serial.map((l) => l.text)).toContain('button1: pressed')
    expect(view(r, 'push-button#1', 'button').pressed).toBe(true)
  })

  it('멀티플렉서로 읽는 가변저항 값도 출력한다', () => {
    const r = sim(run([add('potentiometer'), add('ldr-module'), { type: 'autoAssign' }, link(mod('ldr-module#2', 'ao'), mod('potentiometer#1', 'wiper'))]))
    r.setInput('potentiometer#1', { value: 0.5 })
    at(r, 600)
    expect(r.serial.map((l) => l.text)).toContain('pot1: 512')
  })

  it('초음파 센서는 0.2초마다 거리를 재고 LCD 는 그 거리를 보여 준다', () => {
    const r = sim(run([add('hc-sr04'), add('i2c-lcd-1602'), { type: 'autoAssign' }]))
    r.setInput('hc-sr04#1', { distance: 25 })
    at(r, 600)
    expect(r.serial.map((l) => l.text)).toContain('sonar1 cm: 25.00')
    expect(view(r, 'i2c-lcd-1602#2', 'lcd').lines).toEqual(['Autoino', 'dist 25.0 cm'])
  })

  it('NeoPixel 은 파란 점 하나가 0.1초마다 흐른다', () => {
    const r = sim(run([add('neopixel-strip'), { type: 'autoAssign' }]))
    const colors = view(at(r, 350), 'neopixel-strip#1', 'pixels').colors
    expect(colors.filter((c) => c !== 'off')).toHaveLength(1)
    expect(colors[2]).not.toBe('off')
  })

  it('모든 부품이 시뮬레이션 화면을 가진다', () => {
    const ids = ['led-5mm', 'push-button', 'hc-sr04', 'sg90', 'i2c-lcd-1602', 'voltage-divider', 'level-shifter-4ch', 'cd74hc4067', 'external-power', 'buck-lm2596', 'mb102-power', 'dc-motor-130', 'dc-gear-tt', 'dc-gear-n20', 'dc-gear-25ga370', 'vibration-motor', 'dc-pump-mini', 'mg90s', 'mg996r', 'fs90r', 'stepper-28byj48', 'stepper-nema17', 'bldc-a2212', 'l298n', 'tb6612fng', 'l9110s', 'drv8833', 'uln2003', 'a4988', 'drv8825', 'esc-30a', 'pca9685', 'relay-1ch', 'active-buzzer', 'neopixel-strip', 'potentiometer', 'joystick-ky023', 'rotary-encoder', 'dht-sensor', 'pir-hc-sr501', 'ldr-module', 'soil-moisture', 'mq2-gas', 'mpu6050', 'line-tracker', 'oled-ssd1306', 'tm1637-display', 'hc-05', 'rc522-rfid']
    const s = run([...ids.map(add), { type: 'autoAssign' }], createInitialState('arduino-mega-2560'))
    const r = sim(s)
    at(r, 1500)
    const views = r.view().modules
    for (const item of s.placed) {
      const v = views.get(item.instanceId)
      expect(v, item.moduleId).toBeTruthy()
      expect(v!.status, item.moduleId).toBeTruthy()
    }
  })
})

describe('생성 코드와 같은 출력 · 실물에 가까운 동작', () => {
  it('버튼은 누르기 전에는 아무것도 출력하지 않는다 (코드의 처음 상태는 HIGH)', () => {
    const r = sim(run([add('push-button'), add('pir-hc-sr501'), { type: 'autoAssign' }]))
    at(r, 500)
    expect(r.serial.map((l) => l.text).filter((t) => /button1|pir1/.test(t))).toEqual([])
  })

  it('모터에 허용 전압보다 높은 전압이 걸리면 실제처럼 돌지만 경고한다', () => {
    const s = run([
      add('external-power'), add('l298n'), add('dc-gear-tt'),
      { type: 'setParam', instanceId: 'external-power#1', paramId: 'voltage', value: '12' },
      { type: 'attachMotor', motorId: 'dc-gear-tt#3', driverId: 'l298n#2', route: 'direct' },
      { type: 'autoAssign' },
    ])
    const v = view(at(sim(s), 2500), 'dc-gear-tt#3', 'motor')
    expect(v.speed).toBeGreaterThan(0)
    expect(v.ok).toBe(true)
    expect(v.warn).toContain('허용 전압')
  })
})
