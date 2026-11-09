import { describe, expect, it } from 'vitest'
import { circuitOf, circuitReducer, createInitialState, toProjectData, type CircuitAction, type CircuitState } from '../state/circuitState'
import type { Endpoint } from '../types'
import { BB_COLUMNS, holeName, holeNode, routeBreadboard, verifyRouting, type BreadboardRouting, type Hole } from './breadboard'
import { renderBreadboardSvg } from './breadboardSvg'
import { endpointKey } from './connections'
import { buildBom } from './exporters'
import { parseProjectFile, toProjectFile } from './project'
import { renderSchematicSvg } from './schematicSvg'
import { validateCircuit } from './validate'

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) => actions.reduce(circuitReducer, state)
const add = (moduleId: string, hostBoardId?: string): CircuitAction => ({ type: 'addModule', moduleId, hostBoardId })
const mod = (instanceId: string, pinId: string): Endpoint => ({ kind: 'module', instanceId, pinId })
const bp = (pinId: string): Endpoint => ({ kind: 'board', boardInstanceId: 'board-1', pinId })
const viaBoard = (from: Endpoint, to: Endpoint): CircuitAction => ({ type: 'connect', from, to, via: 'breadboard' })
const autoVia: CircuitAction = { type: 'autoAssign', route: 'breadboard' }

const hk = (h: Hole) => JSON.stringify(h)
const allHoles = (r: BreadboardRouting): string[] => [
  ...r.leads.map((l) => hk(l.hole)),
  ...r.jumpers.flatMap((j) => [hk(j.from), hk(j.to)]),
  ...r.resistors.flatMap((x) => (['e', 'f'] as const).map((row) => hk({ kind: 'main', col: x.col, row }))),
]

const scenarios: [string, () => CircuitState][] = [
  ['Uno 여러 부품', () => run([add('led-5mm'), add('led-5mm'), add('push-button'), add('hc-sr04'), add('sg90'), add('i2c-lcd-1602'), autoVia])],
  ['ESP32 + 레벨 변환', () => run([add('hc-sr04'), add('i2c-lcd-1602'), add('led-5mm'), autoVia, { type: 'insertLevelShifters' }], createInitialState('esp32-devkit-v1'))],
  ['LCD 두 개 (I²C 공유)', () => run([add('i2c-lcd-1602'), add('i2c-lcd-1602'), autoVia])],
  ['I²C 장치 여섯 개 (스트립 하나로 부족)', () => run([...Array.from({ length: 6 }, () => add('i2c-lcd-1602')), autoVia], createInitialState('arduino-mega-2560'))],
  ['초음파 센서 열두 개', () => run([...Array.from({ length: 12 }, () => add('hc-sr04')), autoVia], createInitialState('arduino-mega-2560'))],
  [
    '외부 전원과 모터',
    () =>
      run([
        add('external-power'), add('l298n'), add('dc-gear-tt'), add('hc-sr04'),
        { type: 'setParam', instanceId: 'external-power#1', paramId: 'voltage', value: '7.4' },
        autoVia,
      ]),
  ],
]

describe('브레드보드 경유 배선', () => {
  it.each(scenarios)('%s: 구멍을 겹쳐 쓰지 않고 배선도의 연결을 그대로 만든다', (_name, make) => {
    const s = make()
    const r = routeBreadboard(circuitOf(s))
    expect(r.warnings).toEqual([])
    expect(verifyRouting(r, circuitOf(s)).problems).toEqual([])
    const holes = allHoles(r)
    expect(new Set(holes).size).toBe(holes.length)
    for (const l of r.leads) expect(l.hole.col).toBeLessThanOrEqual(BB_COLUMNS)
  })

  it('직결 전선은 브레드보드를 쓰지 않는다', () => {
    const s = run([add('led-5mm'), { type: 'autoAssign' }])
    expect(s.connections.every((c) => c.via === undefined)).toBe(true)
    const r = routeBreadboard(circuitOf(s))
    expect(r.leads).toEqual([])
    expect(r.jumpers).toEqual([])
    expect(r.resistors).toEqual([])
  })

  it('끌어서 연결할 때 고른 경로가 전선에 저장된다', () => {
    const s = run([add('led-5mm'), viaBoard(mod('led-5mm#1', 'anode'), bp('D5')), { type: 'connect', from: mod('led-5mm#1', 'cathode'), to: bp('GND') }])
    expect(s.connections.map((c) => c.via)).toEqual(['breadboard', undefined])
  })

  it('GND 는 − 레일, 전원은 + 레일로 가고 보드 핀은 레일에 한 번만 연결한다', () => {
    const s = scenarios[0][1]()
    const r = routeBreadboard(circuitOf(s))
    expect(r.rails['top-']?.label).toBe('GND')
    expect(r.rails['top+']?.label).toBe('5V (5 V)')
    const board5v = r.leads.filter((l) => l.key === 'board:board-1:5V')
    expect(board5v).toHaveLength(1)
    expect(board5v[0].hole).toMatchObject({ kind: 'rail', rail: 'top+' })
    expect(board5v[0].connectionIds.length).toBeGreaterThan(1)
    const gnd = r.leads.find((l) => l.key === endpointKey(mod('hc-sr04#4', 'gnd')))!
    expect(gnd.hole).toMatchObject({ kind: 'rail', rail: 'top-' })
  })

  it('두 번째 전원은 아래 + 레일을 쓴다', () => {
    const s = run([
      add('external-power'), add('sg90'), add('hc-sr04'),
      { type: 'setParam', instanceId: 'external-power#1', paramId: 'voltage', value: '6' },
      autoVia,
    ])
    const r = routeBreadboard(circuitOf(s))
    expect(Object.values(r.rails).map((x) => x.label).sort()).toEqual(['5V (5 V)', 'GND', '외부 전원 1 (6 V)'].sort())
    expect(r.rails['bot+']).toBeDefined()
  })

  it('LED 직렬 저항은 가운데 홈을 건너 꽂고, 부품과 보드 핀은 저항 양쪽에 놓인다', () => {
    const s = run([add('led-5mm'), viaBoard(mod('led-5mm#1', 'anode'), bp('D5')), viaBoard(mod('led-5mm#1', 'cathode'), bp('GND'))])
    const r = routeBreadboard(circuitOf(s))
    expect(r.resistors).toHaveLength(1)
    const { col } = r.resistors[0]
    expect(r.resistors[0].label).toBe('330 Ω')
    const pin = r.leads.find((l) => l.key === endpointKey(mod('led-5mm#1', 'anode')))!
    const board = r.leads.find((l) => l.key === 'board:board-1:D5')!
    expect(pin.hole).toMatchObject({ kind: 'main', col })
    expect(board.hole).toMatchObject({ kind: 'main', col })
    expect(holeNode(pin.hole)).not.toBe(holeNode(board.hole))
    expect(verifyRouting(r, circuitOf(s)).ok).toBe(true)
  })

  it('같은 버스 신호는 한 스트립을 나눠 쓴다', () => {
    const s = scenarios[2][1]()
    const r = routeBreadboard(circuitOf(s))
    const nodes = (pin: string) => r.leads.filter((l) => l.key === endpointKey(mod(pin, 'sda')) || l.key === 'board:board-1:A4').map((l) => holeNode(l.hole))
    expect(new Set([...nodes('i2c-lcd-1602#1'), ...nodes('i2c-lcd-1602#2')]).size).toBe(1)
  })

  it('한 스트립을 넘으면 점퍼로 다음 스트립을 잇는다', () => {
    const r = routeBreadboard(circuitOf(scenarios[3][1]()))
    expect(r.jumpers.length).toBeGreaterThan(0)
  })

  it('큰 전류가 흐르는 배선은 자동 배정이 브레드보드로 보내지 않는다', () => {
    const s = scenarios[5][1]()
    const wire = (instanceId: string, pinId: string) => s.connections.find((c) => endpointKey(c.from) === endpointKey(mod(instanceId, pinId)) || endpointKey(c.to) === endpointKey(mod(instanceId, pinId)))!
    expect(wire('dc-gear-tt#3', 'm1').via).toBeUndefined()
    expect(wire('l298n#2', 'vs').via).toBeUndefined()
    expect(wire('l298n#2', 'ena').via).toBe('breadboard')
    expect(wire('hc-sr04#4', 'vcc').via).toBe('breadboard')
  })

  it('사용자가 큰 전류 배선을 브레드보드로 보내면 경고한다', () => {
    const s = run([
      add('external-power'), add('l298n'), add('dc-gear-tt'),
      { type: 'connect', from: mod('dc-gear-tt#3', 'm1'), to: mod('l298n#2', 'out1'), via: 'breadboard' },
    ])
    const w = validateCircuit(circuitOf(s)).find((i) => i.code === 'breadboard-current')!
    expect(w.severity).toBe('warning')
    expect(w.message).toContain('브레드보드')
  })

  it('전선의 경로를 나중에 바꿀 수 있고 실행 취소된다', () => {
    const s = run([add('led-5mm'), { type: 'connect', from: mod('led-5mm#1', 'anode'), to: bp('D5') }])
    const id = s.connections[0].id
    const via = circuitReducer(s, { type: 'setConnectionRoute', connectionId: id, via: 'breadboard' })
    expect(via.connections[0].via).toBe('breadboard')
    const direct = circuitReducer(via, { type: 'setConnectionRoute', connectionId: id, via: 'direct' })
    expect(direct.connections[0].via).toBeUndefined()
    expect(circuitReducer(via, { type: 'undo' }).connections[0].via).toBeUndefined()
  })

  it('배치를 고의로 망가뜨리면 검사가 잡아낸다', () => {
    const s = scenarios[0][1]()
    const r = routeBreadboard(circuitOf(s))
    expect(verifyRouting({ ...r, leads: r.leads.slice(1) }, circuitOf(s)).ok).toBe(false)
    const shorted = { ...r, jumpers: [...r.jumpers, { from: { kind: 'rail' as const, rail: 'top-' as const, col: 60 }, to: { kind: 'rail' as const, rail: 'top+' as const, col: 60 }, net: 'x' }] }
    expect(verifyRouting(shorted, circuitOf(s)).ok).toBe(false)
  })

  it('holeNode 와 holeName: a–e / f–j / 레일', () => {
    expect(holeNode({ kind: 'main', col: 5, row: 'c' })).toBe('top:5')
    expect(holeNode({ kind: 'main', col: 5, row: 'h' })).toBe('bottom:5')
    expect(holeNode({ kind: 'rail', rail: 'top-', col: 9 })).toBe('rail:top-')
    expect(holeName({ kind: 'main', col: 5, row: 'c' })).toBe('5c')
    expect(holeName({ kind: 'rail', rail: 'bot+', col: 9 })).toBe('아래 + 레일')
  })

  it('브레드보드 위치는 프로젝트에 저장되고 부품 자동 배치가 피해 간다', () => {
    const s = run([{ type: 'moveBreadboard', position: { x: 500, y: 600 } }])
    expect(s.breadboard).toEqual({ x: 500, y: 600 })
    const many = run(Array.from({ length: 16 }, () => add('sg90')))
    const { breadboard } = many
    for (const p of many.placed) {
      const clear = p.x + 160 <= breadboard.x || p.x >= breadboard.x + 664 || p.y + 104 <= breadboard.y || p.y >= breadboard.y + 180
      expect(clear, p.instanceId).toBe(true)
    }
  })
})

describe('브레드보드 출력', () => {
  it('SVG: 배치도와 구멍별 배선표', () => {
    const s = scenarios[1][1]()
    const c = circuitOf(s)
    const bb = renderBreadboardSvg(routeBreadboard(c), c, '테스트 <회로>')
    expect(bb.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(bb).toContain('테스트 &lt;회로&gt;')
    expect(bb).toContain('HC-SR04 초음파 센서 1')
    const sch = renderSchematicSvg(c, '테스트', new Date('2026-01-02T00:00:00Z'))
    expect(sch).toContain('2026-01-02')
    expect(sch).toContain('GPIO21')
    expect(sch).toContain('레벨 시프터 (4채널) 1')
    expect(sch).toContain('150Ω') // LED 직렬 저항 (3.3 V)
  })

  it('BOM: 브레드보드를 쓰면 1장과 실제 점퍼 수를 넣고, 안 쓰면 넣지 않는다', () => {
    const via = scenarios[0][1]()
    const r = routeBreadboard(circuitOf(via))
    const bom = buildBom(circuitOf(via), r)
    expect(bom.find((x) => x.item === '브레드보드')?.quantity).toBe(1)
    const direct = via.connections.filter((c) => c.via === undefined).length
    expect(bom.find((x) => x.item === '점퍼 와이어')?.quantity).toBe(direct + r.leads.length + r.jumpers.length)
    const plain = run([add('led-5mm'), { type: 'autoAssign' }])
    expect(buildBom(circuitOf(plain), routeBreadboard(circuitOf(plain))).find((x) => x.item === '브레드보드')).toBeUndefined()
  })
})

describe('예전 프로젝트 파일', () => {
  it('브레드보드 위치가 없으면 기존 배치를 피해 놓고 전선은 직결로 연다', () => {
    const s = run([add('led-5mm'), { type: 'moveModule', instanceId: 'led-5mm#1', position: { x: 300, y: 400 } }, { type: 'connect', from: mod('led-5mm#1', 'anode'), to: bp('D5') }])
    const { breadboard: _position, ...old } = toProjectData(s)
    const opened = circuitReducer(createInitialState(), { type: 'loadProject', data: old })
    const [led] = opened.placed
    expect(opened.breadboard.y).toBeGreaterThanOrEqual(led.y + 104)
    expect(opened.connections[0].via).toBeUndefined()
  })

  it('브레드보드 위치와 경로는 파일로 저장했다 다시 열어도 그대로다', () => {
    const s = run([add('led-5mm'), viaBoard(mod('led-5mm#1', 'anode'), bp('D5')), { type: 'moveBreadboard', position: { x: 200, y: 700 } }])
    const data = parseProjectFile(JSON.stringify(toProjectFile(toProjectData(s))))
    expect(data.breadboard).toEqual({ x: 200, y: 700 })
    expect(data.connections[0].via).toBe('breadboard')
  })
})
