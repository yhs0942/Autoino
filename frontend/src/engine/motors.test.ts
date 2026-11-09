import { describe, expect, it } from 'vitest'
import { getBoard } from '../data/boards'
import { circuitOf, circuitReducer, createInitialState, type CircuitAction, type CircuitState } from '../state/circuitState'
import type { Endpoint } from '../types'
import { endpointKey } from './connections'
import { buildPinTable } from './exporters'
import { analyzePower } from './power'
import { validateCircuit } from './validate'

// 모터·드라이버·외부 전원의 연결 규칙 (자동 핀 배정과 전기적 검증)

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) => actions.reduce(circuitReducer, state)
const add = (moduleId: string): CircuitAction => ({ type: 'addModule', moduleId })
const mod = (instanceId: string, pinId: string): Endpoint => ({ kind: 'module', instanceId, pinId })
const bp = (pinId: string, boardInstanceId = 'board-1'): Endpoint => ({ kind: 'board', boardInstanceId, pinId })
const connect = (from: Endpoint, to: Endpoint): CircuitAction => ({ type: 'connect', from, to })
const auto: CircuitAction = { type: 'autoAssign' }
const param = (instanceId: string, paramId: string, value: string): CircuitAction => ({ type: 'setParam', instanceId, paramId, value })
const volts = (instanceId: string, value: string) => param(instanceId, 'voltage', value)

/** 이 부품 핀에 전선으로 이어진 상대 끝점 키 */
const peers = (s: CircuitState, instanceId: string, pinId: string) => {
  const k = endpointKey(mod(instanceId, pinId))
  return s.connections.flatMap((c) => (endpointKey(c.from) === k ? [endpointKey(c.to)] : endpointKey(c.to) === k ? [endpointKey(c.from)] : []))
}
const issues = (s: CircuitState) => validateCircuit(circuitOf(s))
const codes = (s: CircuitState, severity?: string) => issues(s).filter((i) => !severity || i.severity === severity).map((i) => i.code)
const boardPinOf = (s: CircuitState, instanceId: string, pinId: string) => peers(s, instanceId, pinId).map((k) => k.split(':')[2])[0]

describe('모터 ↔ 드라이버 자동 연결', () => {
  const base = [add('external-power'), add('l298n'), add('dc-gear-tt'), volts('external-power#1', '7.4'), param('external-power#1', 'current', '5000')]

  it('모터 단자를 드라이버 채널 출력에 잇고, 쓰는 채널의 제어 핀만 보드에 연결한다', () => {
    const s = run([...base, auto])
    expect(peers(s, 'dc-gear-tt#3', 'm1')).toEqual(['module:l298n#2:out1'])
    expect(peers(s, 'dc-gear-tt#3', 'm2')).toEqual(['module:l298n#2:out2'])
    expect(getBoard('arduino-uno-r3').pwmPins).toContain(boardPinOf(s, 'l298n#2', 'ena'))
    expect(boardPinOf(s, 'l298n#2', 'in1')).toMatch(/^[DA]\d+$/)
    expect(boardPinOf(s, 'l298n#2', 'in2')).toMatch(/^[DA]\d+$/)
    for (const unused of ['enb', 'in3', 'in4', 'out3', 'out4']) expect(peers(s, 'l298n#2', unused)).toEqual([])
  })

  it('모터가 둘이면 채널 A, B 로 나누고, 드라이버 하나의 채널이 차면 실패로 알린다', () => {
    const two = run([...base, add('dc-gear-tt'), auto])
    expect(peers(two, 'dc-gear-tt#4', 'm1')).toEqual(['module:l298n#2:out3'])
    const three = run([...base, add('dc-gear-tt'), add('dc-gear-tt'), auto])
    expect(three.statusMessage).toContain('TT 기어드 모터 3')
    expect(peers(three, 'dc-gear-tt#5', 'm1')).toEqual([])
  })

  it('쓰지 않는 채널은 미연결 경고를 내지 않고, 전체가 맞으면 오류가 없다', () => {
    const s = run([...base, auto])
    expect(codes(s, 'error')).toEqual([])
    expect(codes(s)).not.toContain('unconnected')
  })

  it('드라이버가 없으면 모터를 보드에 연결하지 않고 실패로 알린다', () => {
    const s = run([add('dc-gear-tt'), auto])
    expect(s.connections).toEqual([])
    expect(s.statusMessage).toContain('TT 기어드 모터 1')
    const warning = issues(s).find((i) => i.code === 'unconnected')!
    expect(warning.hint).toContain('모터 드라이버')
  })

  it('종류가 맞는 드라이버에만 연결한다 (스테퍼 → A4988, 28BYJ-48 → ULN2003)', () => {
    const s = run([add('external-power'), add('l298n'), add('a4988'), add('uln2003'), add('stepper-nema17'), add('stepper-28byj48'), auto])
    expect(peers(s, 'stepper-nema17#5', 'a1')).toEqual(['module:a4988#3:o1a'])
    expect(peers(s, 'stepper-nema17#5', 'b2')).toEqual(['module:a4988#3:o2b'])
    expect(peers(s, 'stepper-28byj48#6', 'com')).toEqual(['module:uln2003#4:ocom'])
    expect(boardPinOf(s, 'a4988#3', 'step')).toBeTruthy()
    expect(peers(s, 'a4988#3', 'ms1')).toEqual([])
  })

  it('BLDC 는 ESC 에 연결하고 Servo 라이브러리 핀 충돌 규칙을 따른다', () => {
    const s = run([add('external-power'), add('esc-30a'), add('bldc-a2212'), volts('external-power#1', '11.1'), param('external-power#1', 'current', '30000'), auto])
    expect(peers(s, 'bldc-a2212#3', 'c')).toEqual(['module:esc-30a#2:pc'])
    expect(codes(s, 'error')).toEqual([])
  })
})

describe('외부 전원 자동 연결', () => {
  it('드라이버 전원은 외부 전원으로, GND 는 전원 − 로, 전원 − 는 보드 GND 로 잇는다', () => {
    const s = run([add('external-power'), add('l298n'), add('dc-gear-tt'), volts('external-power#1', '7.4'), auto])
    expect(peers(s, 'l298n#2', 'vs')).toEqual(['module:external-power#1:plus'])
    expect(peers(s, 'l298n#2', 'gnd')).toEqual(['module:external-power#1:minus'])
    expect(peers(s, 'external-power#1', 'minus')).toContain('board:board-1:GND')
  })

  it('외부 전원이 없으면 드라이버 전원 핀을 보드 5V 에 연결하지 않고 실패로 알린다', () => {
    const s = run([add('l298n'), add('dc-gear-tt'), auto])
    expect(peers(s, 'l298n#1', 'vs')).toEqual([])
    expect(s.statusMessage).toContain('L298N 모터 드라이버 1')
  })

  it('서보는 전압이 맞는 외부 전원이 있으면 그쪽을, 없으면 보드 5V 를 쓴다', () => {
    const none = run([add('sg90'), auto])
    expect(peers(none, 'sg90#1', 'vcc')).toEqual(['board:board-1:5V'])
    const wrong = run([add('external-power'), add('sg90'), auto])
    expect(peers(wrong, 'sg90#2', 'vcc')).toEqual(['board:board-1:5V'])
    const right = run([add('external-power'), add('sg90'), volts('external-power#1', '5'), auto])
    expect(peers(right, 'sg90#2', 'vcc')).toEqual(['module:external-power#1:plus'])
    expect(peers(right, 'sg90#2', 'gnd')).toEqual(['module:external-power#1:minus'])
    expect(codes(right)).not.toContain('board-power-warning')
  })

  it('외부 전원 + 와 − 는 여러 전선을 받는다 (기존 전선을 대체하지 않는다)', () => {
    const s = run([add('external-power'), add('sg90'), add('sg90'), volts('external-power#1', '5'), auto])
    expect(peers(s, 'external-power#1', 'plus').sort()).toEqual(['module:sg90#2:vcc', 'module:sg90#3:vcc'])
  })

  it('3.3 V 보드에서 로직 전원 부품은 3.3 V 핀을 쓴다', () => {
    const s = run([add('potentiometer'), add('hc-05'), auto], createInitialState('esp32-devkit-v1'))
    expect(peers(s, 'potentiometer#1', 'vcc')).toEqual(['board:board-1:3V3'])
    expect(peers(s, 'hc-05#2', 'vcc')).toEqual(['board:board-1:VIN'])
  })
})

describe('연결 오류 검사', () => {
  it('모터를 보드 핀에 직접 연결하면 오류이고, 자동 핀 배정이 그 연결을 해제한다', () => {
    const s = run([add('dc-gear-tt'), connect(mod('dc-gear-tt#1', 'm1'), bp('D5'))])
    const error = issues(s).find((i) => i.severity === 'error')!
    expect(error.code).toBe('link-error')
    expect(error.message).toContain('모터 드라이버')
    expect(run([auto], s).connections).toEqual([])
  })

  it('드라이버 출력을 보드 핀에 연결하면 오류', () => {
    const s = run([add('l298n'), connect(mod('l298n#1', 'out1'), bp('D5'))])
    expect(codes(s, 'error')).toContain('link-error')
  })

  it('외부 전원 + 를 GND·GPIO 에 연결하면 오류', () => {
    const gnd = run([add('external-power'), connect(mod('external-power#1', 'plus'), bp('GND'))])
    expect(issues(gnd).find((i) => i.severity === 'error')!.message).toContain('단락')
    const gpio = run([add('external-power'), connect(mod('external-power#1', 'plus'), bp('D5'))])
    expect(codes(gpio, 'error')).toContain('link-error')
  })

  it('외부 전원 + 와 − 를 같은 부품 핀 쌍으로 단락하면 오류', () => {
    const s = run([add('external-power'), add('external-power'), connect(mod('external-power#1', 'plus'), mod('external-power#2', 'minus'))])
    expect(codes(s, 'error')).toContain('module-short')
  })

  it('VIN: 7–12 V 는 허용, 범위를 넘으면 오류, 낮으면 경고', () => {
    const connectVin = (v: string) => run([add('external-power'), volts('external-power#1', v), connect(mod('external-power#1', 'plus'), bp('VIN'))])
    expect(codes(connectVin('12'), 'error')).toEqual([])
    expect(codes(connectVin('24'), 'error')).toContain('link-error')
    expect(codes(connectVin('5'), 'warning')).toContain('vin-undervoltage')
  })

  it('5V 핀에 5 V 를 넣으면 경고, 12 V 를 넣으면 오류', () => {
    const connect5 = (v: string) => run([add('external-power'), volts('external-power#1', v), connect(mod('external-power#1', 'plus'), bp('5V'))])
    expect(codes(connect5('5'), 'warning')).toContain('source-on-supply')
    expect(codes(connect5('12'), 'error')).toContain('link-error')
  })

  it('12 V 외부 전원을 5 V 부품에 바로 연결하면 과전압 오류', () => {
    const s = run([add('external-power'), add('hc-sr04'), connect(mod('hc-sr04#2', 'vcc'), mod('external-power#1', 'plus'))])
    const e = issues(s).find((i) => i.code === 'supply-overvoltage')!
    expect(e.severity).toBe('error')
    expect(e.message).toContain('12 V')
    expect(e.instanceId).toBe('hc-sr04#2')
  })

  it('3.3 V 전용 부품을 5V 핀에 연결하면 과전압 오류', () => {
    const s = run([add('rc522-rfid'), connect(mod('rc522-rfid#1', 'vcc'), bp('5V'))])
    expect(codes(s, 'error')).toContain('supply-overvoltage')
  })

  it('전압이 낮은 외부 전원은 경고', () => {
    const s = run([add('external-power'), add('hc-sr04'), volts('external-power#1', '3.7'), connect(mod('hc-sr04#2', 'vcc'), mod('external-power#1', 'plus'))])
    expect(codes(s, 'warning')).toContain('supply-undervoltage')
  })

  it('모터에 걸리는 전압이 허용 범위를 넘으면 오류, 낮으면 경고 (드라이버 전압 강하 반영)', () => {
    const on = (v: string) => run([add('external-power'), add('l298n'), add('dc-gear-tt'), volts('external-power#1', v), param('external-power#1', 'current', '5000'), auto])
    const high = issues(on('12')).find((i) => i.code === 'motor-overvoltage')!
    expect(high.severity).toBe('error')
    expect(high.message).toContain('10 V')
    expect(codes(on('7.4'))).not.toContain('motor-overvoltage')
    const low = run([add('external-power'), add('l298n'), add('dc-gear-25ga370'), volts('external-power#1', '7.4'), param('external-power#1', 'current', '5000'), auto])
    expect(codes(low, 'warning')).toContain('motor-undervoltage')
  })

  it('모터 전류가 드라이버 채널 한계를 넘으면 오류·경고', () => {
    const s = run([add('external-power'), add('l9110s'), add('dc-gear-25ga370'), volts('external-power#1', '9'), param('external-power#1', 'current', '5000'), auto])
    expect(codes(s, 'warning')).toContain('driver-peak')
    const parallel = run([
      add('external-power'), add('l9110s'), add('dc-gear-25ga370'), add('dc-gear-25ga370'), add('dc-gear-25ga370'), volts('external-power#1', '9'), param('external-power#1', 'current', '10000'),
      connect(mod('dc-gear-25ga370#3', 'm1'), mod('l9110s#2', 'oa1')),
      connect(mod('dc-gear-25ga370#3', 'm2'), mod('l9110s#2', 'oa2')),
      connect(mod('dc-gear-25ga370#4', 'm1'), mod('l9110s#2', 'oa1')),
      connect(mod('dc-gear-25ga370#4', 'm2'), mod('l9110s#2', 'oa2')),
      connect(mod('dc-gear-25ga370#5', 'm1'), mod('l9110s#2', 'oa1')),
      connect(mod('dc-gear-25ga370#5', 'm2'), mod('l9110s#2', 'oa2')),
    ])
    expect(codes(parallel, 'error')).toContain('driver-overcurrent')
  })

  it('외부 전원 용량을 넘으면 오류(동작 전류)·경고(스톨 전류)', () => {
    const three = [add('mg996r'), add('mg996r'), add('mg996r')]
    const small = run([add('external-power'), ...three, volts('external-power#1', '6'), param('external-power#1', 'current', '2000'), auto])
    expect(codes(small, 'error')).toContain('supply-overload')
    const medium = run([add('external-power'), ...three, volts('external-power#1', '6'), param('external-power#1', 'current', '5000'), auto])
    expect(codes(medium, 'error')).not.toContain('supply-overload')
    expect(codes(medium, 'warning')).toContain('supply-peak')
    const large = run([add('external-power'), ...three, volts('external-power#1', '6'), param('external-power#1', 'current', '10000'), auto])
    expect(codes(large)).not.toContain('supply-peak')
  })

  it('외부 전원 GND 가 보드와 이어지지 않은 채 신호가 연결되면 오류', () => {
    const s = run([
      add('external-power'), add('sg90'), volts('external-power#1', '5'),
      connect(mod('sg90#2', 'vcc'), mod('external-power#1', 'plus')),
      connect(mod('sg90#2', 'gnd'), mod('external-power#1', 'minus')),
      connect(mod('sg90#2', 'signal'), bp('D5')),
    ])
    const e = issues(s).find((i) => i.code === 'module-ground-not-common')!
    expect(e.severity).toBe('error')
    expect(e.instanceId).toBe('sg90#2')
    const fixed = run([connect(mod('external-power#1', 'minus'), bp('GND'))], s)
    expect(codes(fixed)).not.toContain('module-ground-not-common')
  })

  it('전원 두 개를 바로 이으면 경고', () => {
    const s = run([add('external-power'), add('external-power'), connect(mod('external-power#1', 'plus'), mod('external-power#2', 'plus'))])
    expect(codes(s, 'warning')).toContain('supply-parallel')
  })

  it('레귤레이터 입력이 출력보다 충분히 높지 않으면 경고', () => {
    const s = run([add('external-power'), add('buck-lm2596'), volts('external-power#1', '5'), connect(mod('buck-lm2596#2', 'vin'), mod('external-power#1', 'plus'))])
    expect(codes(s, 'warning')).toContain('regulator-headroom')
  })

  it('3.3 V 입력 신호를 5 V 보드 출력에 연결하면 경고', () => {
    const s = run([add('hc-05'), auto])
    const w = issues(s).find((i) => i.code === 'module-input-overvoltage')!
    expect(w.severity).toBe('warning')
    expect(w.message).toContain('RXD')
    const esp = run([add('hc-05'), auto], createInitialState('esp32-devkit-v1'))
    expect(codes(esp)).not.toContain('module-input-overvoltage')
  })

  it('외부 전원의 5 V 신호도 3.3 V GPIO 과전압으로 검사한다', () => {
    const s = run(
      [
        add('external-power'), add('hc-sr04'), volts('external-power#1', '5'),
        connect(mod('hc-sr04#2', 'vcc'), mod('external-power#1', 'plus')),
        connect(mod('hc-sr04#2', 'gnd'), bp('GND')),
        connect(mod('external-power#1', 'minus'), bp('GND')),
        connect(mod('hc-sr04#2', 'echo'), bp('GPIO4')),
      ],
      createInitialState('esp32-devkit-v1'),
    )
    expect(codes(s, 'error')).toContain('level-overvoltage')
  })
})

describe('핀 배정표와 설치 안내', () => {
  it('쓰지 않는 드라이버 채널과 선택 핀은 연결 불필요로 표시한다', () => {
    const s = run([add('external-power'), add('l298n'), add('dc-gear-tt'), volts('external-power#1', '7.4'), auto])
    const rows = buildPinTable(circuitOf(s))
    const row = (pinName: string) => rows.find((r) => r.moduleLabel === 'L298N 모터 드라이버 1' && r.pinName === pinName)!
    expect(row('IN3')).toMatchObject({ optional: true, note: '연결 불필요' })
    expect(row('OUT3')).toMatchObject({ optional: true, note: '연결 불필요' })
    expect(row('IN1')).toMatchObject({ optional: false })
    const button = run([add('push-button')])
    expect(buildPinTable(circuitOf(button)).find((r) => r.pinName === '1B')).toMatchObject({ optional: true, note: '연결 불필요 (내부 연결)' })
  })

  it('보드 핀으로 해결할 수 없는 설치 작업은 정보로 알린다', () => {
    const notes = (moduleId: string) => issues(run([add(moduleId)])).filter((i) => i.code === 'setup-note')
    expect(notes('a4988')[0].severity).toBe('info')
    expect(notes('a4988')[0].message).toContain('RST')
    expect(notes('drv8825')[0].message).toContain('RST')
    expect(notes('l298n')[0].message).toContain('ENA')
    expect(notes('hc-sr04')).toEqual([])
  })
})

describe('보드 전원 입력', () => {
  it('ESP32 VIN 에 5 V 외부 전원을 넣는 것은 정상 입력이다', () => {
    const s = run(
      [add('external-power'), volts('external-power#1', '5'), connect(mod('external-power#1', 'plus'), bp('VIN')), connect(mod('external-power#1', 'minus'), bp('GND'))],
      createInitialState('esp32-devkit-v1'),
    )
    expect(codes(s)).not.toContain('supply-parallel')
    expect(codes(s)).not.toContain('source-on-supply')
    const [source] = analyzePower(circuitOf(s)).sources
    expect(source.label).toBe('외부 전원 1')
    expect(source.loads.map((l) => l.label)).toEqual(['보드 VIN'])
  })

  it('USB 로 켠 ESP32 의 VIN 은 부품에 전원을 주는 핀이다', () => {
    const s = run([add('hc-05'), auto], createInitialState('esp32-devkit-v1'))
    const source = analyzePower(circuitOf(s)).sources.find((x) => x.label === '보드 VIN')!
    expect(source.kind).toBe('board')
    expect(source.loads.map((l) => l.label)).toEqual(['HC-05 블루투스 1'])
  })
})
