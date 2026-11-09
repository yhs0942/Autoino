import { describe, expect, it } from 'vitest'
import { circuitOf, circuitReducer, createInitialState, toProjectData, type CircuitAction, type CircuitState } from '../state/circuitState'
import {
  checkLeadMove,
  holeId,
  holeNode,
  parseHoleId,
  routeBreadboard,
  verifyRouting,
  type BbLead,
  type BreadboardRouting,
  type Hole,
  type MainRow,
  type RailId,
} from './breadboard'
import { holeAt, holeXY } from './breadboardSvg'
import { parseProjectFile, toProjectFile } from './project'

// 브레드보드 위에서 사람이 전선 끝을 다른 구멍으로 옮기는 기능

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) => actions.reduce(circuitReducer, state)
const add = (moduleId: string): CircuitAction => ({ type: 'addModule', moduleId })
const autoVia: CircuitAction = { type: 'autoAssign', route: 'breadboard' }
const main = (col: number, row: MainRow): Hole => ({ kind: 'main', col, row })
const rail = (r: RailId, col: number): Hole => ({ kind: 'rail', rail: r, col })
const move = (key: string, hole: Hole): CircuitAction => ({ type: 'moveLead', key, hole })
const routingOf = (s: CircuitState) => routeBreadboard(circuitOf(s))
const leadOf = (r: BreadboardRouting, key: string) => r.leads.find((l) => l.key === key)!

/** LED(직렬 저항), 버튼, 초음파 센서를 브레드보드 경유로 자동 배정한 회로 */
const base = () => run([add('led-5mm'), add('push-button'), add('hc-sr04'), autoVia])

/** 레일이 아닌 스트립에 있는 신호 넷 중, 저항 없이 전선 두 가닥으로 이뤄진 넷의 전선들 */
function twoLeadSignalNets(r: BreadboardRouting): BbLead[][] {
  const byNet = new Map<string, BbLead[]>()
  for (const l of r.leads) if (l.kind === 'signal' && l.hole.kind === 'main') byNet.set(l.netId, [...(byNet.get(l.netId) ?? []), l])
  return [...byNet.values()].filter((ls) => ls.length === 2 && ls.every((l) => !l.resistor))
}

/** 모든 전선·점퍼·저항 다리 구멍 */
function usedHoles(r: BreadboardRouting): string[] {
  return [...r.leads.map((l) => holeId(l.hole)), ...r.jumpers.flatMap((j) => [holeId(j.from), holeId(j.to)]), ...r.resistors.flatMap((x) => x.legs.map(holeId))]
}

function expectSound(r: BreadboardRouting, s: CircuitState) {
  expect(r.warnings).toEqual([])
  expect(verifyRouting(r, circuitOf(s)).problems).toEqual([])
  const holes = usedHoles(r)
  expect(new Set(holes).size).toBe(holes.length)
}

describe('구멍 이름', () => {
  it('holeId 와 parseHoleId 는 서로 되돌린다', () => {
    for (const h of [main(12, 'c'), main(1, 'j'), main(63, 'a'), rail('top+', 4), rail('bot-', 63)]) expect(parseHoleId(holeId(h))).toEqual(h)
    expect(holeId(main(12, 'c'))).toBe('12c')
    expect(holeId(rail('top-', 4))).toBe('top-4')
    for (const bad of ['0a', '64c', '12k', 'top*3', 'top+0', 'mid+3', '', 'x']) expect(parseHoleId(bad), bad).toBeNull()
  })

  it('holeAt 은 그림 좌표에서 구멍을 찾고, 브레드보드 밖이면 null', () => {
    for (const h of [main(3, 'a'), main(40, 'e'), main(41, 'f'), main(63, 'j'), rail('top+', 2), rail('bot-', 63)]) {
      const p = holeXY(h)
      expect(holeAt(p.x, p.y)).toEqual(h)
      expect(holeAt(p.x + 3, p.y - 3)).toEqual(h)
    }
    expect(holeAt(-40, -40)).toBeNull()
    expect(holeAt(4000, 40)).toBeNull()
  })
})

describe('전선 끝 옮기기', () => {
  it('옮긴 전선은 고른 구멍에 꽂히고, 손대지 않은 전선은 그 자리에 그대로 있다', () => {
    const s0 = base()
    const r0 = routingOf(s0)
    const [lead] = twoLeadSignalNets(r0)[0]
    const s1 = circuitReducer(s0, move(lead.key, main(50, 'b')))
    const r1 = routingOf(s1)
    expect(leadOf(r1, lead.key).hole).toEqual(main(50, 'b'))
    for (const l of r0.leads) if (l.key !== lead.key) expect(leadOf(r1, l.key).hole, l.key).toEqual(l.hole)
    expectSound(r1, s1)
    expect(s1.statusMessage).toContain('50b')
  })

  it('짝과 다른 줄로 옮기면 점퍼로 이어 연결을 유지하고, 짝도 옮기면 점퍼가 사라진다', () => {
    const s0 = base()
    const r0 = routingOf(s0)
    const [a, b] = twoLeadSignalNets(r0)[0]
    const s1 = circuitReducer(s0, move(a.key, main(50, 'b')))
    const r1 = routingOf(s1)
    expect(r1.jumpers).toHaveLength(r0.jumpers.length + 1)
    expect(r1.jumpers.some((j) => [holeNode(j.from), holeNode(j.to)].sort().join() === [holeNode(b.hole), 'top:50'].sort().join())).toBe(true)
    expectSound(r1, s1)

    const s2 = circuitReducer(s1, move(b.key, main(50, 'c')))
    const r2 = routingOf(s2)
    expect(r2.jumpers).toHaveLength(r0.jumpers.length)
    expectSound(r2, s2)
  })

  it('다른 넷이 꽂힌 줄로는 옮길 수 없고, 상태 표시줄에 이유를 알린다', () => {
    const s0 = base()
    const r0 = routingOf(s0)
    const [[a], [other]] = twoLeadSignalNets(r0)
    const taken = new Set(usedHoles(r0))
    const row = (['a', 'b', 'c', 'd', 'e'] as MainRow[]).find((x) => other.hole.kind === 'main' && !taken.has(holeId(main(other.hole.col, x))))!
    const target = main((other.hole as Extract<Hole, { kind: 'main' }>).col, row)

    const check = checkLeadMove(r0, a.key, target)
    expect(check.ok).toBe(false)
    expect(!check.ok && check.reason).toContain(other.net)
    expect(!check.ok && check.reason).toContain('단락')

    const s1 = circuitReducer(s0, move(a.key, target))
    expect(s1.breadboardHoles).toEqual(s0.breadboardHoles)
    expect(s1.statusMessage).toBe(!check.ok && check.reason)
  })

  it('이미 전선이 꽂힌 구멍으로는 옮길 수 없다', () => {
    const r0 = routingOf(base())
    const [[a], [other]] = twoLeadSignalNets(r0)
    const check = checkLeadMove(r0, a.key, other.hole)
    expect(check.ok).toBe(false)
    expect(!check.ok && check.reason).toContain('이미')
  })

  it('저항이 붙는 LED 핀을 옮기면 저항도 그 열로 따라간다', () => {
    const s0 = base()
    const anode = routingOf(s0).leads.find((l) => l.resistor)!
    const s1 = circuitReducer(s0, move(anode.key, main(45, 'b')))
    const r1 = routingOf(s1)
    expect(r1.resistors).toHaveLength(1)
    expect(r1.resistors[0].col).toBe(45)
    expectSound(r1, s1)
  })

  it('저항이 붙는 핀은 레일로 옮길 수 없다', () => {
    const r0 = routingOf(base())
    const anode = r0.leads.find((l) => l.resistor)!
    const check = checkLeadMove(r0, anode.key, rail('top+', 51))
    expect(check.ok).toBe(false)
    expect(!check.ok && check.reason).toContain('레일')
  })

  it('저항이 꽂힌 쪽 줄에 다른 전선을 꽂으면 저항을 건너뛰므로 막는다', () => {
    const r0 = routingOf(base())
    const anode = r0.leads.find((l) => l.resistor)!
    const [[a]] = twoLeadSignalNets(r0)
    const col = (anode.hole as Extract<Hole, { kind: 'main' }>).col
    const check = checkLeadMove(r0, a.key, main(col, 'd'))
    expect(check.ok).toBe(false)
    expect(!check.ok && check.reason).toContain('저항')
  })

  it('GND 전선을 아래 − 레일로 옮기면 그 레일도 GND 가 되고 위 − 레일과 점퍼로 이어진다', () => {
    const s0 = base()
    const r0 = routingOf(s0)
    const gnd = r0.leads.find((l) => l.kind === 'ground' && l.hole.kind === 'rail')!
    expect(gnd.hole).toMatchObject({ rail: 'top-' })
    const s1 = circuitReducer(s0, move(gnd.key, rail('bot-', 10)))
    const r1 = routingOf(s1)
    expect(leadOf(r1, gnd.key).hole).toEqual(rail('bot-', 10))
    expect(r1.rails['bot-']?.label).toBe('GND')
    expect(r1.jumpers.some((j) => [holeNode(j.from), holeNode(j.to)].sort().join() === 'rail:bot-,rail:top-')).toBe(true)
    expectSound(r1, s1)
  })

  it('자동 배치로 되돌리면 처음 배치와 같아진다', () => {
    const s0 = base()
    const [lead] = twoLeadSignalNets(routingOf(s0))[0]
    const s1 = circuitReducer(s0, move(lead.key, main(50, 'b')))
    const s2 = circuitReducer(s1, { type: 'resetBreadboardLayout' })
    expect(s2.breadboardHoles).toEqual({})
    expect(routingOf(s2)).toEqual(routingOf(s0))
  })

  it('실행 취소하면 옮기기 전으로 돌아간다', () => {
    const s0 = base()
    const [lead] = twoLeadSignalNets(routingOf(s0))[0]
    const s1 = circuitReducer(s0, move(lead.key, main(50, 'b')))
    const undone = circuitReducer(s1, { type: 'undo' })
    expect(undone.breadboardHoles).toEqual(s0.breadboardHoles)
    expect(leadOf(routingOf(undone), lead.key).hole).toEqual(lead.hole)
  })

  it('옮긴 뒤에 새로 만든 전선은 빈 구멍에 놓이고 기존 전선은 움직이지 않는다', () => {
    const s0 = base()
    const [lead] = twoLeadSignalNets(routingOf(s0))[0]
    const s1 = circuitReducer(s0, move(lead.key, main(40, 'a')))
    const r1 = routingOf(s1)
    expect(leadOf(r1, lead.key).hole).toEqual(main(40, 'a'))
    const s2 = run([add('hc-sr04'), autoVia], s1)
    const r2 = routingOf(s2)
    expectSound(r2, s2)
    for (const l of r1.leads) expect(leadOf(r2, l.key).hole, l.key).toEqual(l.hole)
    expect(r2.leads.length).toBeGreaterThan(r1.leads.length)
  })

  it('전선을 지우면 그 끝점의 위치 기록도 지운다', () => {
    const s0 = base()
    const [a, b] = twoLeadSignalNets(routingOf(s0))[0]
    const s1 = circuitReducer(s0, move(a.key, main(50, 'b')))
    const wire = s1.connections.find((c) => a.connectionIds.includes(c.id))!
    const s2 = circuitReducer(s1, { type: 'removeConnection', connectionId: wire.id })
    expect(Object.keys(s2.breadboardHoles)).not.toContain(a.key)
    expect(Object.keys(s2.breadboardHoles)).not.toContain(b.key)
    expect(Object.keys(s2.breadboardHoles).length).toBeGreaterThan(0)
  })
})

describe('저장과 검사', () => {
  it('옮긴 위치는 프로젝트 파일에 저장되고, 잘못된 값은 버린다', () => {
    const s0 = base()
    expect('breadboardHoles' in toProjectFile(toProjectData(s0))).toBe(false)
    const [lead] = twoLeadSignalNets(routingOf(s0))[0]
    const s1 = circuitReducer(s0, move(lead.key, main(50, 'b')))
    const file = toProjectFile(toProjectData(s1))
    expect(file.breadboardHoles?.[lead.key]).toBe('50b')
    const tampered = { ...file, breadboardHoles: { ...file.breadboardHoles, 'module:nothing#9:x': '5a', [Object.keys(file.breadboardHoles!)[1]]: '99z' } }
    const data = parseProjectFile(JSON.stringify(tampered))
    const expected = { ...s1.breadboardHoles }
    delete expected[Object.keys(file.breadboardHoles!)[1]]
    expect(data.breadboardHoles).toEqual(expected)
    const opened = circuitReducer(createInitialState(), { type: 'loadProject', data })
    expect(leadOf(routingOf(opened), lead.key).hole).toEqual(main(50, 'b'))
  })

  it('파일에서 서로 다른 넷이 같은 줄에 꽂혀 있으면 검사가 단락을 이름으로 알린다', () => {
    const s0 = base()
    const r0 = routingOf(s0)
    const [[a], [other]] = twoLeadSignalNets(r0)
    const col = (other.hole as Extract<Hole, { kind: 'main' }>).col
    const free = (['a', 'b', 'c', 'd', 'e'] as MainRow[]).find((x) => !usedHoles(r0).includes(`${col}${x}`))!
    const frozen = Object.fromEntries(r0.leads.map((l) => [l.key, holeId(l.hole)]))
    const data = { ...toProjectData(s0), breadboardHoles: { ...frozen, [a.key]: `${col}${free}` } }
    const opened = circuitReducer(createInitialState(), { type: 'loadProject', data })
    const problems = verifyRouting(routingOf(opened), circuitOf(opened)).problems
    expect(problems.some((p) => p.includes(a.net) && p.includes(other.net) && p.includes('단락'))).toBe(true)
  })
})
