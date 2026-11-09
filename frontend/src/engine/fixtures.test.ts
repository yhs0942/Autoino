/// <reference types="node" />
// 이 테스트만 픽스처 파일을 쓰기 위해 Node API(fs, process)를 쓴다.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { circuitOf, circuitReducer, createInitialState, toProjectData, type CircuitAction, type CircuitState } from '../state/circuitState'
import type { Endpoint, RouteMode } from '../types'
import { autoAssign } from './autoAssign'
import { SOFTWARE_SERIAL } from './boardLinks'
import { buildBom, buildPinTable } from './exporters'
import { analyzePower } from './power'
import { toProjectFile } from './project'
import { computeSeriesResistors } from './resistor'
import { validateCircuit } from './validate'

// TypeScript 엔진과 Python 백엔드 엔진(backend/autoino/engine)이 같은 결과를 내는지 확인하기 위한 공유 픽스처.
// 이 테스트는 shared/fixtures/engine-cases.json 이 현재 TS 엔진 결과와 같은지 검사한다.
// 엔진을 바꾼 뒤에는 `UPDATE_FIXTURES=1 npm test` 로 파일을 다시 만들고, backend 의 pytest 로 Python 쪽을 확인한다.

const FIXTURE = new URL('../../../shared/fixtures/engine-cases.json', import.meta.url)
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z')

const add = (moduleId: string, hostBoardId?: string): CircuitAction => ({ type: 'addModule', moduleId, hostBoardId })
const mod = (instanceId: string, pinId: string): Endpoint => ({ kind: 'module', instanceId, pinId })
const bp = (pinId: string, boardInstanceId = 'board-1'): Endpoint => ({ kind: 'board', boardInstanceId, pinId })
const connect = (from: Endpoint, to: Endpoint): CircuitAction => ({ type: 'connect', from, to })
const esp = () => createInitialState('esp32-devkit-v1')
const mega = () => createInitialState('arduino-mega-2560')
const param = (instanceId: string, paramId: string, value: string): CircuitAction => ({ type: 'setParam', instanceId, paramId, value })
const supply = (instanceId: string, volts: string, milliamps: string) => [param(instanceId, 'voltage', volts), param(instanceId, 'current', milliamps)]

interface Scenario {
  name: string
  start?: () => CircuitState
  /** 자동 핀 배정 전까지의 동작 */
  setup: CircuitAction[]
  /** 자동 핀 배정 뒤의 동작 */
  after?: CircuitAction[]
  /** true 면 최종 상태에 자동 핀 배정을 적용하지 않는다 (수동 배선 오류 검사용) */
  manualOnly?: boolean
  /** 자동 핀 배정이 쓰는 전선 경로 */
  route?: RouteMode
}

const ALL = [add('led-5mm'), add('led-5mm'), add('push-button'), add('hc-sr04'), add('sg90'), add('i2c-lcd-1602')]
const uartLink: CircuitAction = { type: 'addBoardLink', request: { protocol: 'UART', a: 'board-1', b: 'board-2', aBus: SOFTWARE_SERIAL, bBus: 'Serial2 (UART2)', baud: 115200 } }

const SCENARIOS: Scenario[] = [
  { name: 'uno-all', setup: ALL },
  {
    name: 'uno-manual-errors',
    manualOnly: true,
    setup: [
      add('i2c-lcd-1602'), add('hc-sr04'), add('led-5mm'), add('led-5mm'),
      connect(mod('i2c-lcd-1602#1', 'sda'), bp('D7')),
      connect(mod('i2c-lcd-1602#1', 'vcc'), bp('GND')),
      connect(mod('hc-sr04#2', 'gnd'), bp('5V')),
      connect(mod('hc-sr04#2', 'trig'), bp('5V')),
      connect(mod('led-5mm#3', 'anode'), bp('D0')),
      connect(mod('led-5mm#4', 'anode'), bp('D0')),
    ],
  },
  { name: 'esp32-all', start: esp, setup: ALL },
  { name: 'esp32-level-fixed', start: esp, setup: [add('hc-sr04'), add('i2c-lcd-1602'), add('led-5mm')], after: [{ type: 'insertLevelShifters' }] },
  {
    name: 'multi-uart-shifter',
    setup: [add('led-5mm'), { type: 'addBoard', boardId: 'esp32-devkit-v1' }, add('led-5mm', 'board-2'), add('push-button', 'board-2')],
    after: [uartLink, { type: 'insertLevelShifters' }],
  },
  {
    name: 'multi-uart-unshifted',
    setup: [{ type: 'addBoard', boardId: 'esp32-devkit-v1' }, add('hc-sr04', 'board-2')],
    after: [uartLink],
  },
  {
    name: 'i2c-link-shared',
    setup: [add('i2c-lcd-1602'), { type: 'addBoard', boardId: 'arduino-nano' }, add('i2c-lcd-1602', 'board-2')],
    after: [{ type: 'addBoardLink', request: { protocol: 'I2C', a: 'board-1', b: 'board-2', aBus: 'Wire', bBus: 'Wire', i2cAddress: '0x27' } }],
  },
  {
    name: 'spi-link-mega',
    start: () => createInitialState('arduino-mega-2560'),
    setup: [{ type: 'addBoard', boardId: 'arduino-uno-r3' }, add('sg90'), add('led-5mm')],
    after: [{ type: 'addBoardLink', request: { protocol: 'SPI', a: 'board-1', b: 'board-2', aBus: 'SPI', bBus: 'SPI' } }],
  },
  { name: 'nano-pins-run-out', start: () => createInitialState('arduino-nano'), setup: Array.from({ length: 12 }, () => add('hc-sr04')) },
  {
    name: 'led-variants',
    setup: [add('led-5mm'), add('led-5mm'), add('led-5mm'), add('sg90')],
    after: [
      connect(mod('led-5mm#1', 'anode'), bp('3.3V')),
      { type: 'setParam', instanceId: 'led-5mm#1', paramId: 'color', value: 'white' },
      connect(mod('led-5mm#2', 'anode'), bp('5V')),
      connect(mod('led-5mm#3', 'anode'), bp('D9')),
      { type: 'setParam', instanceId: 'led-5mm#3', paramId: 'current', value: '20' },
    ],
  },
  {
    name: 'board-board-errors',
    setup: [{ type: 'addBoard', boardId: 'esp32-devkit-v1' }],
    after: [
      connect(bp('D7'), bp('GPIO23', 'board-2')),
      connect(bp('5V'), bp('GND', 'board-2')),
      connect(bp('3.3V'), bp('VIN', 'board-2')),
      connect(bp('AREF'), bp('GPIO4', 'board-2')),
    ],
  },
  { name: 'motor-l298n-external', setup: [add('external-power'), add('l298n'), add('dc-gear-tt'), add('dc-gear-tt'), ...supply('external-power#1', '7.4', '5000')] },
  { name: 'motor-too-many', setup: [add('external-power'), add('l298n'), add('dc-gear-tt'), add('dc-gear-tt'), add('dc-gear-tt')] },
  { name: 'motor-no-supply', setup: [add('l298n'), add('dc-gear-tt'), add('sg90')] },
  { name: 'motor-no-driver', setup: [add('dc-gear-25ga370'), add('vibration-motor')] },
  { name: 'motor-overvoltage', setup: [add('external-power'), add('tb6612fng'), add('dc-gear-n20'), ...supply('external-power#1', '12', '2000')] },
  { name: 'motor-undervoltage-overcurrent', setup: [add('external-power'), add('l9110s'), add('dc-gear-25ga370'), ...supply('external-power#1', '5', '10000')] },
  { name: 'servo-overload', setup: [add('external-power'), add('mg996r'), add('mg996r'), add('mg996r'), ...supply('external-power#1', '6', '2000')] },
  { name: 'servo-peak', setup: [add('external-power'), add('mg996r'), add('mg90s'), add('fs90r'), ...supply('external-power#1', '6', '3000')] },
  {
    name: 'stepper-bldc',
    setup: [add('external-power'), add('a4988'), add('stepper-nema17'), add('uln2003'), add('stepper-28byj48'), add('drv8825'), add('stepper-nema17'), add('esc-30a'), add('bldc-a2212'), ...supply('external-power#1', '11.1', '30000')],
  },
  {
    name: 'regulator-buck',
    setup: [add('external-power'), add('buck-lm2596'), add('sg90'), add('l298n'), add('dc-gear-25ga370'), ...supply('external-power#1', '12', '5000')],
    after: [connect(mod('sg90#3', 'vcc'), mod('buck-lm2596#2', 'vout')), connect(mod('sg90#3', 'gnd'), mod('buck-lm2596#2', 'gnd2'))],
  },
  {
    name: 'regulator-headroom',
    manualOnly: true,
    setup: [add('external-power'), add('mb102-power'), add('hc-sr04'), ...supply('external-power#1', '5', '1000'), connect(mod('mb102-power#2', 'vin'), mod('external-power#1', 'plus')), connect(mod('hc-sr04#3', 'vcc'), mod('mb102-power#2', 'v5'))],
  },
  {
    name: 'catalog-mega',
    start: mega,
    setup: [
      add('active-buzzer'), add('neopixel-strip'), add('potentiometer'), add('joystick-ky023'), add('rotary-encoder'), add('dht-sensor'), add('pir-hc-sr501'), add('ldr-module'),
      add('soil-moisture'), add('mq2-gas'), add('mpu6050'), add('line-tracker'), add('oled-ssd1306'), add('tm1637-display'), add('hc-05'), add('rc522-rfid'), add('relay-1ch'),
      param('neopixel-strip#2', 'count', '30'),
    ],
  },
  { name: 'catalog-esp32', start: esp, setup: [add('potentiometer'), add('dht-sensor'), add('mq2-gas'), add('mpu6050'), add('oled-ssd1306'), add('hc-05'), add('rc522-rfid'), add('tb6612fng'), add('dc-gear-tt')] },
  {
    name: 'route-breadboard',
    route: 'breadboard',
    setup: [add('external-power'), add('tb6612fng'), add('dc-gear-tt'), add('led-5mm'), add('hc-sr04'), add('sg90'), ...supply('external-power#1', '6', '5000')],
  },
  {
    name: 'power-wiring-errors',
    manualOnly: true,
    setup: [
      add('external-power'), add('external-power'), add('hc-sr04'), add('dc-gear-tt'), add('l298n'), add('sg90'), add('rc522-rfid'), add('hc-05'),
      ...supply('external-power#2', '24', '5000'),
      connect(mod('external-power#1', 'plus'), bp('GND')),
      connect(mod('external-power#1', 'plus'), bp('D5')),
      connect(mod('external-power#2', 'plus'), bp('VIN')),
      connect(mod('external-power#2', 'plus'), bp('5V')),
      connect(mod('hc-sr04#3', 'vcc'), mod('external-power#1', 'plus')),
      connect(mod('dc-gear-tt#4', 'm1'), bp('D6')),
      connect(mod('l298n#5', 'out1'), bp('D7')),
      connect(mod('l298n#5', 'out2'), mod('hc-sr04#3', 'trig')),
      connect(mod('l298n#5', 'vs'), bp('5V')),
      connect(mod('sg90#6', 'signal'), mod('external-power#2', 'plus')),
      connect(mod('rc522-rfid#7', 'vcc'), bp('5V')),
      connect(mod('hc-05#8', 'rxd'), bp('D8')),
      connect(mod('external-power#1', 'minus'), mod('external-power#2', 'plus')),
      { type: 'connect', from: mod('dc-gear-tt#4', 'm2'), to: mod('l298n#5', 'out3'), via: 'breadboard' },
    ],
  },
  {
    name: 'ground-not-common',
    manualOnly: true,
    setup: [
      add('external-power'), add('sg90'), add('external-power'), ...supply('external-power#1', '5', '3000'),
      connect(mod('sg90#2', 'vcc'), mod('external-power#1', 'plus')),
      connect(mod('sg90#2', 'gnd'), mod('external-power#1', 'minus')),
      connect(mod('sg90#2', 'signal'), bp('D5')),
      connect(mod('external-power#3', 'plus'), bp('VIN')),
      param('external-power#3', 'voltage', '5'),
    ],
  },
]

function stripIds<T extends { id: string }>(issues: T[]): Omit<T, 'id'>[] {
  return issues.map(({ id: _id, ...rest }) => rest)
}

function buildCases() {
  return SCENARIOS.map((sc) => {
    const before = sc.setup.reduce(circuitReducer, sc.start ? sc.start() : createInitialState())
    const assigned = autoAssign(circuitOf(before), before.nextConnSeq, { route: sc.route })
    const final = [...(sc.manualOnly ? [] : [{ type: 'autoAssign', route: sc.route } as CircuitAction]), ...(sc.after ?? [])].reduce(circuitReducer, before)
    const c = circuitOf(final)
    return {
      name: sc.name,
      ...(sc.route ? { route: sc.route } : {}),
      before: toProjectFile(toProjectData(before), FIXED_DATE),
      autoAssign: {
        connections: assigned.connections,
        added: assigned.added.map((x) => x.id),
        removed: assigned.removed.map((x) => x.id),
        failed: assigned.failed,
        nextConnSeq: assigned.nextConnSeq,
      },
      after: toProjectFile(toProjectData(final), FIXED_DATE),
      issues: stripIds(validateCircuit(c)),
      resistors: computeSeriesResistors(c),
      pinTable: buildPinTable(c),
      bom: buildBom(c),
      power: analyzePower(c),
    }
  })
}

describe('TS ↔ Python 엔진 공유 픽스처', () => {
  it('shared/fixtures/engine-cases.json 이 현재 TS 엔진 결과와 같다', () => {
    const cases = buildCases()
    const text = JSON.stringify({ generatedBy: 'frontend/src/engine/fixtures.test.ts', cases }, null, 1) + '\n'
    if (process.env.UPDATE_FIXTURES === '1' || !existsSync(FIXTURE)) writeFileSync(FIXTURE, text)
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(JSON.parse(text))
  })
})
