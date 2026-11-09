import { boardDefOf, type Circuit } from './circuit'
import { asModuleBoardLink, describeEndpoint, endpointKey, moduleEndpoint, parseEndpointKey } from './connections'
import type { Board } from '../types'
import { buildNetlist } from './netlist'
import { nameNets, type NetKind } from './netNames'
import { computeSeriesResistors, formatOhms } from './resistor'
import { computeLadderResistors } from './shares'

// 브레드보드 경유 배선
//
// 배선도의 전선에는 "브레드보드 경유" 표시만 저장한다. 어느 구멍에 꽂을지는 연결에서 계산하므로
// 전선을 바꾸면 배치도 함께 바뀐다. 사람이 전선 끝을 다른 구멍으로 옮기면 그때부터는 모든 전선의
// 구멍을 문서(breadboardHoles)에 기록해 두고, 손대지 않은 전선은 그 자리에 둔다.
//
// 브레드보드 모델 (830홀, 63열):
// - 본체: 각 열의 a–e 다섯 구멍이 하나의 스트립, f–j 다섯 구멍이 또 하나의 스트립 (가운데 홈으로 분리)
// - 전원 레일: 위쪽 +/−, 아래쪽 +/− 네 줄. 각 레일은 길이 방향으로 연결되어 있다고 본다
//   (가운데에서 레일이 끊어진 제품은 점퍼로 이어야 한다).
//
// 배치 규칙:
// - 브레드보드를 거치는 끝점을 넷별로 묶는다. 끝점마다 전선 한 가닥이 구멍 하나로 들어온다.
// - 사람이 꽂은 전선은 그 구멍에 그대로 둔다. 그 줄은 그 넷의 것이 되고, 자동 배치는 그 열을 피한다.
// - 가장 많이 쓰는 GND 넷은 위 − 레일, 다음 GND 넷은 아래 − 레일
// - 가장 많이 쓰는 전원 넷은 위 + 레일, 다음 전원 넷은 아래 + 레일 (사람이 이미 고른 레일은 그대로 둔다)
// - 나머지 넷은 빈 열의 스트립 하나를 쓴다. 스트립이 차면 점퍼로 다음 스트립을 잇는다.
// - 한 넷이 여러 줄에 걸치면 점퍼로 잇는다 (레일이 있으면 레일로).
// - LED 직렬 저항은 같은 열에서 가운데 홈을 건너 꽂는다. 부품 핀 쪽 줄에는 그 핀만 둔다.

export const BB_COLUMNS = 63
export type MainRow = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j'
export type RailId = 'top+' | 'top-' | 'bot+' | 'bot-'

export type Hole = { kind: 'main'; col: number; row: MainRow } | { kind: 'rail'; rail: RailId; col: number }

/** 부품·보드 핀에서 구멍으로 들어오는 전선 한 가닥 */
export interface BbLead {
  /** 끝점 키 */
  key: string
  hole: Hole
  /** 넷 이름 (표시용) */
  net: string
  /** 넷 ID */
  netId: string
  kind: NetKind
  /** 이 전선이 담당하는 연결 (보드 핀 하나를 여러 연결이 나눠 쓸 수 있다) */
  connectionIds: string[]
  /** 직렬 저항을 거치는 부품 핀인지 */
  resistor: boolean
  /** 사람이 고른 구멍인지 */
  pinned: boolean
}

/** 브레드보드 위에서 스트립끼리 잇는 점퍼 */
export interface BbJumper {
  from: Hole
  to: Hole
  net: string
}

export interface BbResistor {
  instanceId: string
  pinId: string
  col: number
  ohms: number
  label: string
  /** 다리 두 개: [부품 핀 쪽, 넷 쪽] */
  legs: [Hole, Hole]
}

export interface RailNet {
  net: string
  label: string
  kind: NetKind
}

export interface BreadboardRouting {
  leads: BbLead[]
  jumpers: BbJumper[]
  resistors: BbResistor[]
  rails: Partial<Record<RailId, RailNet>>
  /** 배치하지 못한 연결 등 경고 */
  warnings: string[]
}

export const EMPTY_ROUTING: BreadboardRouting = { leads: [], jumpers: [], resistors: [], rails: {}, warnings: [] }

const TOP_ROWS: MainRow[] = ['a', 'b', 'c', 'd', 'e']
const BOTTOM_ROWS: MainRow[] = ['f', 'g', 'h', 'i', 'j']
/** 가운데 홈에서 가까운 순서 */
const NEAR_GAP: Record<'top' | 'bottom', MainRow[]> = { top: ['e', 'd', 'c', 'b', 'a'], bottom: ['f', 'g', 'h', 'i', 'j'] }
/** 스트립은 3열부터 쓴다 (1–2열은 레일로 가는 전선이 지나갈 자리) */
const FIRST_COLUMN = 3
/** 레일 구멍: 짝수 열부터 띄엄띄엄 쓰고, 다 차면 홀수 열을 쓴다 */
const RAIL_ORDER = [
  ...Array.from({ length: Math.floor(BB_COLUMNS / 2) }, (_, i) => (i + 1) * 2),
  ...Array.from({ length: Math.ceil(BB_COLUMNS / 2) }, (_, i) => i * 2 + 1),
]

const RAIL_NAMES: Record<RailId, string> = { 'top+': '위 + 레일', 'top-': '위 − 레일', 'bot+': '아래 + 레일', 'bot-': '아래 − 레일' }

const halfOf = (row: MainRow): 'top' | 'bottom' => (TOP_ROWS.includes(row) ? 'top' : 'bottom')

/** 내부에서 이어진 구멍 묶음의 식별자 */
export function holeNode(h: Hole): string {
  if (h.kind === 'rail') return `rail:${h.rail}`
  return `${halfOf(h.row)}:${h.col}`
}

/** 사람이 읽는 구멍 이름 (예: 5c, 위 + 레일) */
export function holeName(h: Hole): string {
  return h.kind === 'rail' ? RAIL_NAMES[h.rail] : `${h.col}${h.row}`
}

/** 열까지 밝힌 구멍 이름 (예: 5c, 위 + 레일 12열) */
export function holeLabel(h: Hole): string {
  return h.kind === 'rail' ? `${RAIL_NAMES[h.rail]} ${h.col}열` : `${h.col}${h.row}`
}

/** 구멍이 속한 줄의 이름 (예: 12열 a–e, 위 − 레일) */
export function nodeLabel(h: Hole): string {
  return h.kind === 'rail' ? RAIL_NAMES[h.rail] : `${h.col}열 ${halfOf(h.row) === 'top' ? 'a–e' : 'f–j'}`
}

/** 파일에 저장하는 구멍 ID (예: 12c, top-4) */
export function holeId(h: Hole): string {
  return h.kind === 'rail' ? `${h.rail}${h.col}` : `${h.col}${h.row}`
}

export function parseHoleId(id: string): Hole | null {
  const main = /^([1-9]\d?)([a-j])$/.exec(id)
  if (main) {
    const col = Number(main[1])
    return col <= BB_COLUMNS ? { kind: 'main', col, row: main[2] as MainRow } : null
  }
  const rail = /^(top|bot)([+-])([1-9]\d?)$/.exec(id)
  if (rail) {
    const col = Number(rail[3])
    return col <= BB_COLUMNS ? { kind: 'rail', rail: `${rail[1]}${rail[2]}` as RailId, col } : null
  }
  return null
}

/** 보드 핀의 표시 순서 (헤더가 정의되어 있으면 헤더 순서) */
function pinOrder(board: Board): Map<string, number> {
  const ids = board.headers ? board.headers.flatMap((h) => h.pinIds) : board.pins.map((p) => p.id)
  return new Map(ids.map((id, i) => [id, i]))
}

type Strip = { half: 'top' | 'bottom'; col: number }
type NetNode = { kind: 'strip'; strip: Strip } | { kind: 'rail'; rail: RailId }
const main = (col: number, row: MainRow): Hole => ({ kind: 'main', col, row })

export function routeBreadboard(circuit: Circuit): BreadboardRouting {
  const through = circuit.connections.filter((c) => c.via === 'breadboard')
  if (!through.length) return EMPTY_ROUTING

  const netlist = buildNetlist(circuit)
  const names = nameNets(circuit, netlist)
  const netName = (net: string) => {
    const info = names.get(net)
    return info?.kind === 'power' && info.voltage !== undefined ? `${info.name} (${info.voltage} V)` : (info?.name ?? net)
  }
  const netKind = (net: string): NetKind => names.get(net)?.kind ?? 'signal'
  const warnings: string[] = []

  /** 직렬 저항이 붙는 부품 핀 (LED 저항, 버튼 사다리 저항) */
  const resistorOf = new Map<string, { instanceId: string; pinId: string; ohms: number }>()
  for (const r of computeSeriesResistors(circuit)) if (r.status === 'ok') resistorOf.set(endpointKey(moduleEndpoint(r.instanceId, r.pinId)), { instanceId: r.instanceId, pinId: r.pinId, ohms: r.choice.standardOhms })
  for (const r of computeLadderResistors(circuit)) if (r.ohms > 0) resistorOf.set(endpointKey(moduleEndpoint(r.instanceId, r.pinId)), r)

  // ---------- 넷별로 끝점 묶기 ----------
  const groups = new Map<string, Map<string, string[]>>()
  for (const c of through)
    for (const e of [c.from, c.to]) {
      const key = endpointKey(e)
      const net = netlist.netOf(key)
      const group = groups.get(net) ?? new Map<string, string[]>()
      group.set(key, [...(group.get(key) ?? []), c.id])
      groups.set(net, group)
    }

  const leads: BbLead[] = []
  const jumpers: BbJumper[] = []
  const resistors: BbResistor[] = []
  const used = new Set<string>()
  const isFree = (h: Hole) => !used.has(holeId(h))
  const claim = (h: Hole) => used.add(holeId(h))
  const pushLead = (key: string, ids: string[], hole: Hole, net: string, pinned: boolean) => {
    claim(hole)
    leads.push({ key, hole, net: netName(net), netId: net, kind: netKind(net), connectionIds: ids, resistor: resistorOf.has(key), pinned })
  }
  const pushResistor = (key: string, col: number, legs: [Hole, Hole]) => {
    const r = resistorOf.get(key)!
    for (const h of legs) claim(h)
    resistors.push({ instanceId: r.instanceId, pinId: r.pinId, col, ohms: r.ohms, label: formatOhms(r.ohms), legs })
  }

  // ---------- 사람이 꽂은 전선 ----------
  const pins = circuit.breadboardHoles ?? {}
  const pinnedKeys = new Set<string>()
  const pinnedNodes = new Map<string, NetNode[]>()
  const pinnedColumns = new Set<number>()
  const pinnedRails = new Map<RailId, string>()
  const addNode = (net: string, node: NetNode) => {
    const list = pinnedNodes.get(net) ?? []
    const same = (n: NetNode) => (n.kind === 'rail' ? node.kind === 'rail' && node.rail === n.rail : node.kind === 'strip' && node.strip.half === n.strip.half && node.strip.col === n.strip.col)
    if (!list.some(same)) list.push(node)
    pinnedNodes.set(net, list)
  }
  const wanted: { net: string; key: string; ids: string[]; hole: Hole }[] = []
  for (const [net, group] of groups)
    for (const [key, ids] of group) {
      const hole = pins[key] ? parseHoleId(pins[key]) : null
      // 저항이 붙는 핀은 레일에 꽂을 수 없으므로 자동 배치로 돌린다
      if (!hole || !isFree(hole) || (hole.kind === 'rail' && resistorOf.has(key))) continue
      claim(hole)
      wanted.push({ net, key, ids, hole })
    }
  // 저항 다리는 다른 전선 구멍을 모두 잡은 뒤에 고른다
  const legsFor = (hole: Extract<Hole, { kind: 'main' }>): [Hole, Hole] | null => {
    const half = halfOf(hole.row)
    const pinLeg = NEAR_GAP[half].map((row) => main(hole.col, row)).find(isFree)
    const netLeg = NEAR_GAP[half === 'top' ? 'bottom' : 'top'].map((row) => main(hole.col, row)).find(isFree)
    return pinLeg && netLeg ? [pinLeg, netLeg] : null
  }
  for (const { net, key, ids, hole } of wanted) {
    if (hole.kind === 'main' && resistorOf.has(key)) {
      const legs = legsFor(hole)
      if (!legs) {
        used.delete(holeId(hole))
        continue
      }
      pushLead(key, ids, hole, net, true)
      pushResistor(key, hole.col, legs)
      addNode(net, { kind: 'strip', strip: { half: halfOf((legs[1] as Extract<Hole, { kind: 'main' }>).row), col: hole.col } })
      pinnedColumns.add(hole.col)
    } else {
      pushLead(key, ids, hole, net, true)
      if (hole.kind === 'rail') {
        if (!pinnedRails.has(hole.rail)) pinnedRails.set(hole.rail, net)
        addNode(net, { kind: 'rail', rail: hole.rail })
      } else {
        addNode(net, { kind: 'strip', strip: { half: halfOf(hole.row), col: hole.col } })
        pinnedColumns.add(hole.col)
      }
    }
    pinnedKeys.add(key)
  }

  // ---------- 레일 배정 ----------
  const rails: BreadboardRouting['rails'] = {}
  const railOfNet = new Map<string, RailId>()
  for (const [rail, net] of pinnedRails) {
    rails[rail] = { net, label: netName(net), kind: netKind(net) }
    if (!railOfNet.has(net)) railOfNet.set(net, rail)
  }
  const hasAuto = (net: string) => [...groups.get(net)!.keys()].some((k) => !pinnedKeys.has(k))
  const bySize = (kind: NetKind) =>
    [...groups.keys()].filter((n) => netKind(n) === kind).sort((a, b) => groups.get(b)!.size - groups.get(a)!.size || (a < b ? -1 : 1))
  const assignRails = (kind: 'power' | 'ground', order: RailId[]) => {
    const free = order.filter((r) => !rails[r])
    for (const net of bySize(kind)) {
      if (!free.length) break
      if (railOfNet.has(net) || !hasAuto(net)) continue
      const rail = free.shift()!
      rails[rail] = { net, label: netName(net), kind }
      railOfNet.set(net, rail)
    }
  }
  assignRails('ground', ['top-', 'bot-'])
  assignRails('power', ['top+', 'bot+'])

  // ---------- 구멍 배정 ----------
  let nextCol = FIRST_COLUMN
  const columnFree = (col: number) => !pinnedColumns.has(col) && [...TOP_ROWS, ...BOTTOM_ROWS].every((row) => isFree(main(col, row)))
  const takeColumn = (): number | null => {
    while (nextCol <= BB_COLUMNS && !columnFree(nextCol)) nextCol++
    return nextCol > BB_COLUMNS ? null : nextCol++
  }
  const rowsLeft = (s: Strip): MainRow[] => (s.half === 'top' ? TOP_ROWS : BOTTOM_ROWS).filter((row) => isFree(main(s.col, row)))
  const takeHole = (s: Strip): Hole | null => {
    const row = rowsLeft(s)[0]
    if (!row) return null
    const h = main(s.col, row)
    claim(h)
    return h
  }
  const railHole = (rail: RailId): Hole | null => {
    const col = RAIL_ORDER.find((c) => isFree({ kind: 'rail', rail, col: c }))
    if (col === undefined) return null
    const h: Hole = { kind: 'rail', rail, col }
    claim(h)
    return h
  }
  const nodeHole = (node: NetNode) => (node.kind === 'rail' ? railHole(node.rail) : takeHole(node.strip))

  const addLead = (key: string, ids: string[], hole: Hole | null, net: string) => {
    if (!hole) {
      warnings.push(`${netName(net)}: 브레드보드에 빈 구멍이 없어 ${key} 전선을 놓지 못했습니다.`)
      return
    }
    pushLead(key, ids, hole, net, false)
  }
  const addJumper = (from: Hole | null, to: Hole | null, net: string) => {
    if (!from || !to) warnings.push(`${netName(net)}: 스트립에 빈 구멍이 부족해 점퍼를 놓지 못했습니다.`)
    else jumpers.push({ from, to, net: netName(net) })
  }

  /** 직렬 저항을 꽂고 부품 핀을 저항 위쪽에 놓는다. 저항 아래쪽 스트립을 돌려준다 */
  const placeResistor = (key: string, ids: string[], net: string): Strip | null => {
    const col = takeColumn()
    if (col === null) {
      warnings.push(`${netName(net)}: 브레드보드 열이 부족합니다.`)
      return null
    }
    pushResistor(key, col, [main(col, 'e'), main(col, 'f')])
    addLead(key, ids, takeHole({ half: 'top', col }), net)
    return { half: 'bottom', col }
  }

  const placeGroup = (net: string, members: [string, string[]][]) => {
    const withResistor = members.filter(([key]) => resistorOf.has(key))
    const plain = members.filter(([key]) => !resistorOf.has(key))
    const rail = railOfNet.get(net)
    const nodes = pinnedNodes.get(net) ?? []

    if (rail) {
      for (const [key, ids] of plain) addLead(key, ids, railHole(rail), net)
      for (const [key, ids] of withResistor) {
        const strip = placeResistor(key, ids, net)
        if (strip) addJumper(takeHole(strip), railHole(rail), net)
      }
      // 사람이 꽂은 다른 줄은 레일로 잇는다
      for (const node of nodes) if (!(node.kind === 'rail' && node.rail === rail)) addJumper(nodeHole(node), railHole(rail), net)
      return
    }

    let strip: Strip | null = null
    for (const node of nodes) {
      if (node.kind !== 'strip') continue
      if (strip) addJumper(takeHole(strip), takeHole(node.strip), net)
      strip = node.strip
    }
    for (const [key, ids] of withResistor) {
      const next: Strip | null = placeResistor(key, ids, net)
      if (next && strip) addJumper(takeHole(strip), takeHole(next), net)
      strip = next ?? strip
    }
    plain.forEach(([key, ids], i) => {
      const remaining = plain.length - i
      const left = strip ? rowsLeft(strip).length : 0
      if (!strip || left === 0 || (left === 1 && remaining > 1)) {
        const col = takeColumn()
        if (col === null) {
          warnings.push(`${netName(net)}: 브레드보드 열이 부족합니다.`)
          return
        }
        const next: Strip = { half: 'top', col }
        if (strip) addJumper(takeHole(strip), takeHole(next), net)
        strip = next
      }
      addLead(key, ids, takeHole(strip), net)
    })
  }

  // 보드 핀 순서대로 놓아 전선 교차를 줄인다
  const boardIndex = new Map(circuit.boards.map((b, i) => [b.instanceId, i]))
  const orders = new Map(circuit.boards.map((b) => [b.instanceId, (() => { const d = boardDefOf(circuit, b.instanceId); return d ? pinOrder(d) : new Map<string, number>() })()]))
  const score = (net: string) => {
    const positions: number[] = []
    for (const key of groups.get(net)!.keys()) {
      const e = parseEndpointKey(key)
      if (e?.kind === 'board') positions.push((boardIndex.get(e.boardInstanceId) ?? 0) * 1000 + (orders.get(e.boardInstanceId)?.get(e.pinId) ?? 999))
      else if (e?.kind === 'module') {
        const link = circuit.connections.map(asModuleBoardLink).find((l) => l && l.instanceId === e.instanceId && l.modulePinId === e.pinId)
        if (link) positions.push((boardIndex.get(link.boardInstanceId) ?? 0) * 1000 + (orders.get(link.boardInstanceId)?.get(link.pinId) ?? 999))
      }
    }
    return positions.length ? Math.min(...positions) : Number.POSITIVE_INFINITY
  }
  const ordered = [...groups.keys()].sort((a, b) => score(a) - score(b) || (a < b ? -1 : 1))
  for (const net of ordered) placeGroup(net, [...groups.get(net)!].filter(([key]) => !pinnedKeys.has(key)))

  return { leads, jumpers, resistors, rails, warnings }
}

export type MoveCheck = { ok: true } | { ok: false; reason: string }

const sameHole = (a: Hole, b: Hole) => holeId(a) === holeId(b)
const resistorKey = (r: BbResistor) => endpointKey(moduleEndpoint(r.instanceId, r.pinId))

/**
 * 전선 끝(구멍 쪽)을 다른 구멍으로 옮겨도 되는지 검사한다.
 * 다른 넷이 꽂힌 줄(단락), 직렬 저항을 건너뛰는 자리, 이미 찬 구멍은 막는다.
 */
export function checkLeadMove(routing: BreadboardRouting, key: string, hole: Hole): MoveCheck {
  const fail = (reason: string): MoveCheck => ({ ok: false, reason })
  const lead = routing.leads.find((l) => l.key === key)
  if (!lead) return fail('브레드보드를 거치는 전선이 아닙니다.')
  if (sameHole(lead.hole, hole)) return { ok: true }
  if (lead.resistor && hole.kind === 'rail') return fail('직렬 저항이 붙는 핀은 레일에 꽂을 수 없습니다. 본체 구멍(a–j)에 꽂으세요.')

  const own = lead.resistor ? routing.resistors.find((r) => resistorKey(r) === key) : undefined
  const blocked = [...routing.leads.filter((l) => l !== lead).map((l) => l.hole), ...routing.resistors.filter((r) => r !== own).flatMap((r) => r.legs)]
  if (blocked.some((h) => sameHole(h, hole))) return fail(`${holeLabel(hole)} 에는 이미 다른 전선이 꽂혀 있습니다.`)

  /** 줄에 꽂힌 것들: 넷 ID 또는 저항의 부품 쪽(res:키) */
  const occupants = (node: string): { id: string; label: string }[] => {
    const list: { id: string; label: string }[] = []
    for (const l of routing.leads) if (l !== lead && holeNode(l.hole) === node) list.push(l.resistor ? { id: `res:${l.key}`, label: `${l.net} 의 직렬 저항 쪽` } : { id: l.netId, label: l.net })
    for (const r of routing.resistors) {
      if (r === own) continue
      const pin = routing.leads.find((l) => l.key === resistorKey(r))
      if (holeNode(r.legs[0]) === node) list.push({ id: `res:${resistorKey(r)}`, label: '직렬 저항' })
      if (pin && holeNode(r.legs[1]) === node) list.push({ id: pin.netId, label: pin.net })
    }
    return list
  }
  const shortMessage = (h: Hole, other: { id: string; label: string }) =>
    other.id.startsWith('res:')
      ? `${nodeLabel(h)} 줄은 직렬 저항이 꽂힌 부품 쪽이라, 여기에 꽂으면 저항을 건너뛰게 됩니다.`
      : `${nodeLabel(h)} 줄에는 이미 ${other.label} 이(가) 꽂혀 있어 ${lead.net} 와(과) 단락됩니다.`

  if (!lead.resistor) {
    const node = holeNode(hole)
    const here = occupants(node)
    const clash = here.find((o) => o.id !== lead.netId)
    if (clash) return fail(shortMessage(hole, clash))
    // 같은 넷이 다른 줄에도 있으면 이 줄에 점퍼 자리가 하나 더 필요하다
    const elsewhere = routing.leads.some((l) => l !== lead && l.netId === lead.netId && holeNode(l.hole) !== node)
    if (hole.kind === 'main' && !here.length && elsewhere) {
      const half = halfOf(hole.row) === 'top' ? TOP_ROWS : BOTTOM_ROWS
      const free = half.filter((row) => !blocked.some((h) => sameHole(h, main(hole.col, row)))).length
      if (free < 2) return fail(`${nodeLabel(hole)} 줄에는 다른 줄과 이을 점퍼 자리가 남지 않습니다.`)
    }
    return { ok: true }
  }

  // 저항이 붙는 핀: 부품 쪽 줄은 비어 있어야 하고, 반대쪽 줄은 같은 넷만 있어야 한다
  const h = hole as Extract<Hole, { kind: 'main' }>
  const otherHalf = halfOf(h.row) === 'top' ? BOTTOM_ROWS : TOP_ROWS
  const pinSide = occupants(holeNode(h))
  if (pinSide.length) return fail(pinSide.some((o) => o.id === lead.netId) ? `${nodeLabel(h)} 줄에는 같은 신호의 다른 전선이 있어 직렬 저항을 건너뛰게 됩니다.` : shortMessage(h, pinSide[0]))
  const across = main(h.col, otherHalf[0])
  const netSide = occupants(holeNode(across)).find((o) => o.id !== lead.netId)
  if (netSide) return fail(shortMessage(across, netSide))
  const freeIn = (rows: MainRow[]) => rows.filter((row) => !blocked.some((b) => sameHole(b, main(h.col, row))) && row !== h.row).length
  if (freeIn(halfOf(h.row) === 'top' ? TOP_ROWS : BOTTOM_ROWS) < 1 || freeIn(otherHalf) < 1) return fail(`${h.col}열에는 직렬 저항 다리를 꽂을 빈 구멍이 없습니다.`)
  return { ok: true }
}

export interface BreadboardCheck {
  ok: boolean
  problems: string[]
}

/**
 * 구멍·스트립·레일의 내부 연결과 점퍼를 따라 연결을 다시 만들어 배선도와 비교한다.
 * (저항은 연결로 본다.) 끊어진 전선, 서로 다른 넷의 단락, 직렬 저항을 건너뛰는 배치를 찾아낸다.
 */
export function verifyRouting(routing: BreadboardRouting, circuit: Circuit): BreadboardCheck {
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    if (!parent.has(k)) parent.set(k, k)
    let r = k
    while (parent.get(r) !== r) r = parent.get(r)!
    parent.set(k, r)
    return r
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const l of routing.leads) union(l.key, holeNode(l.hole))
  for (const j of routing.jumpers) union(holeNode(j.from), holeNode(j.to))
  for (const r of routing.resistors) union(holeNode(r.legs[0]), holeNode(r.legs[1]))

  const netlist = buildNetlist(circuit)
  const problems: string[] = []
  const describe = (key: string) => {
    const e = parseEndpointKey(key)
    return e ? describeEndpoint(e, circuit) : key
  }
  for (const c of circuit.connections) {
    if (c.via !== 'breadboard') continue
    const [a, b] = [endpointKey(c.from), endpointKey(c.to)]
    if (find(a) !== find(b)) problems.push(`${describe(a)} ↔ ${describe(b)} 연결이 브레드보드에서 끊어져 있습니다.`)
  }
  const netsAt = new Map<string, Map<string, string>>()
  for (const l of routing.leads) {
    const root = find(l.key)
    const nets = netsAt.get(root) ?? new Map<string, string>()
    nets.set(netlist.netOf(l.key), l.net)
    netsAt.set(root, nets)
  }
  for (const nets of netsAt.values())
    if (nets.size > 1) problems.push(`브레드보드에서 ${[...nets.values()].join(', ')} 이(가) 서로 이어져 단락됩니다.`)
  for (const r of routing.resistors) {
    const node = holeNode(r.legs[0])
    const key = resistorKey(r)
    const crowded = routing.leads.some((l) => l.key !== key && holeNode(l.hole) === node) || routing.jumpers.some((j) => holeNode(j.from) === node || holeNode(j.to) === node)
    if (crowded) problems.push(`직렬 저항 ${r.label} (${describe(key)}) 의 부품 쪽 줄에 다른 전선이 있어 저항을 건너뜁니다.`)
  }
  return { ok: problems.length === 0, problems }
}
