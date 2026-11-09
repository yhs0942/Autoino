import { boardDefOf, type Circuit } from './circuit'
import { asModuleBoardLink, endpointKey, moduleEndpoint, parseEndpointKey } from './connections'
import type { Board } from '../types'
import { buildNetlist } from './netlist'
import { nameNets, type NetKind } from './netNames'
import { computeSeriesResistors, formatOhms, type SeriesResistorResult } from './resistor'

// 브레드보드 경유 배선
//
// 배선도의 전선에는 "브레드보드 경유" 표시만 저장한다. 어느 구멍에 꽂을지는 연결에서 계산하므로
// 전선을 바꾸면 배치도 함께 바뀐다.
//
// 브레드보드 모델 (830홀, 63열):
// - 본체: 각 열의 a–e 다섯 구멍이 하나의 스트립, f–j 다섯 구멍이 또 하나의 스트립 (가운데 홈으로 분리)
// - 전원 레일: 위쪽 +/−, 아래쪽 +/− 네 줄. 각 레일은 길이 방향으로 연결되어 있다고 본다
//   (가운데에서 레일이 끊어진 제품은 점퍼로 이어야 한다).
//
// 배치 규칙:
// - 브레드보드를 거치는 끝점을 넷별로 묶는다. 끝점마다 전선 한 가닥이 구멍 하나로 들어온다.
// - 가장 많이 쓰는 GND 넷은 위 − 레일, 다음 GND 넷은 아래 − 레일
// - 가장 많이 쓰는 전원 넷은 위 + 레일, 다음 전원 넷은 아래 + 레일
// - 나머지 넷은 빈 열의 스트립 하나를 쓴다. 스트립이 차면 점퍼로 다음 스트립을 잇는다.
// - LED 직렬 저항은 같은 열의 e–f 에 가운데 홈을 건너 꽂고, 부품 핀은 위, 나머지는 아래 스트립에 놓는다.

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
  kind: NetKind
  /** 이 전선이 담당하는 연결 (보드 핀 하나를 여러 연결이 나눠 쓸 수 있다) */
  connectionIds: string[]
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
}

export interface RailNet {
  net: string
  label: string
  kind: 'power' | 'ground'
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
/** 스트립은 3열부터 쓴다 (1–2열은 레일로 가는 전선이 지나갈 자리) */
const FIRST_COLUMN = 3

const RAIL_NAMES: Record<RailId, string> = { 'top+': '위 + 레일', 'top-': '위 − 레일', 'bot+': '아래 + 레일', 'bot-': '아래 − 레일' }

/** 내부에서 이어진 구멍 묶음의 식별자 */
export function holeNode(h: Hole): string {
  if (h.kind === 'rail') return `rail:${h.rail}`
  return `${TOP_ROWS.includes(h.row) ? 'top' : 'bottom'}:${h.col}`
}

/** 사람이 읽는 구멍 이름 (예: 5c, 위 + 레일) */
export function holeName(h: Hole): string {
  return h.kind === 'rail' ? RAIL_NAMES[h.rail] : `${h.col}${h.row}`
}

/** 보드 핀의 표시 순서 (헤더가 정의되어 있으면 헤더 순서) */
function pinOrder(board: Board): Map<string, number> {
  const ids = board.headers ? board.headers.flatMap((h) => h.pinIds) : board.pins.map((p) => p.id)
  return new Map(ids.map((id, i) => [id, i]))
}

type Strip = { half: 'top' | 'bottom'; col: number }
const stripKey = (s: Strip) => `${s.half}:${s.col}`

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

  /** 직렬 저항이 붙는 부품 핀 */
  const resistorOf = new Map<string, Extract<SeriesResistorResult, { status: 'ok' }>>()
  for (const r of computeSeriesResistors(circuit)) if (r.status === 'ok') resistorOf.set(endpointKey(moduleEndpoint(r.instanceId, r.pinId)), r)

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

  // ---------- 레일 배정 ----------
  const bySize = (kind: NetKind) =>
    [...groups.keys()].filter((n) => netKind(n) === kind).sort((a, b) => groups.get(b)!.size - groups.get(a)!.size || (a < b ? -1 : 1))
  const rails: BreadboardRouting['rails'] = {}
  const assignRail = (rail: RailId, net: string | undefined, kind: 'power' | 'ground') => {
    if (net) rails[rail] = { net, label: netName(net), kind }
  }
  const [ground1, ground2] = bySize('ground')
  const [power1, power2] = bySize('power')
  assignRail('top-', ground1, 'ground')
  assignRail('bot-', ground2, 'ground')
  assignRail('top+', power1, 'power')
  assignRail('bot+', power2, 'power')
  const railOfNet = new Map(Object.entries(rails).map(([rail, r]) => [r.net, rail as RailId]))

  // ---------- 구멍 배정 ----------
  const leads: BbLead[] = []
  const jumpers: BbJumper[] = []
  const resistors: BbResistor[] = []
  const resistorCols = new Set<number>()
  const freeRows = new Map<string, MainRow[]>()
  let nextCol = FIRST_COLUMN
  const takeColumn = (): number | null => (nextCol > BB_COLUMNS ? null : nextCol++)
  const rowsLeft = (s: Strip): MainRow[] => {
    const key = stripKey(s)
    if (!freeRows.has(key)) {
      const rows = s.half === 'top' ? TOP_ROWS : BOTTOM_ROWS
      // 저항이 꽂힌 열은 e, f 가 저항 다리 자리다
      freeRows.set(key, rows.filter((r) => !(resistorCols.has(s.col) && (r === 'e' || r === 'f'))))
    }
    return freeRows.get(key)!
  }
  const takeHole = (s: Strip): Hole | null => {
    const row = rowsLeft(s).shift()
    return row ? { kind: 'main', col: s.col, row } : null
  }
  /** 레일 구멍: 짝수 열부터 띄엄띄엄 쓰고, 다 차면 홀수 열을 쓴다 */
  const railUsed = new Map<RailId, number>()
  const railHole = (rail: RailId): Hole | null => {
    const n = railUsed.get(rail) ?? 0
    railUsed.set(rail, n + 1)
    const half = Math.floor(BB_COLUMNS / 2)
    if (n < half) return { kind: 'rail', rail, col: (n + 1) * 2 }
    const odd = (n - half) * 2 + 1
    return odd <= BB_COLUMNS ? { kind: 'rail', rail, col: odd } : null
  }

  const addLead = (key: string, ids: string[], hole: Hole | null, net: string) => {
    if (!hole) {
      warnings.push(`${netName(net)}: 브레드보드에 빈 구멍이 없어 ${key} 전선을 놓지 못했습니다.`)
      return
    }
    leads.push({ key, hole, net: netName(net), kind: netKind(net), connectionIds: ids })
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
    const r = resistorOf.get(key)!
    resistorCols.add(col)
    resistors.push({ instanceId: r.instanceId, pinId: r.pinId, col, ohms: r.choice.standardOhms, label: formatOhms(r.choice.standardOhms) })
    addLead(key, ids, takeHole({ half: 'top', col }), net)
    return { half: 'bottom', col }
  }

  const placeGroup = (net: string, members: [string, string[]][]) => {
    const withResistor = members.filter(([key]) => resistorOf.has(key))
    const plain = members.filter(([key]) => !resistorOf.has(key))
    const rail = railOfNet.get(net)

    if (rail) {
      for (const [key, ids] of plain) addLead(key, ids, railHole(rail), net)
      for (const [key, ids] of withResistor) {
        const strip = placeResistor(key, ids, net)
        if (strip) addJumper(takeHole(strip), railHole(rail), net)
      }
      return
    }

    let strip: Strip | null = null
    for (const [key, ids] of withResistor) {
      const next: Strip | null = placeResistor(key, ids, net)
      if (next && strip) addJumper(takeHole(strip), takeHole(next), net)
      strip = next ?? strip
    }
    plain.forEach(([key, ids], i) => {
      const remaining = plain.length - i
      if (!strip || (rowsLeft(strip).length === 1 && remaining > 1)) {
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
  for (const net of ordered) placeGroup(net, [...groups.get(net)!])

  return { leads, jumpers, resistors, rails, warnings }
}

export interface BreadboardCheck {
  ok: boolean
  problems: string[]
}

/**
 * 구멍·스트립·레일의 내부 연결과 점퍼를 따라 연결을 다시 만들어 배선도와 비교한다.
 * (저항은 연결로 본다.) 끊어진 전선과 서로 다른 넷의 단락을 찾아낸다.
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
  for (const r of routing.resistors) union(`top:${r.col}`, `bottom:${r.col}`)

  const netlist = buildNetlist(circuit)
  const problems: string[] = []
  for (const c of circuit.connections) {
    if (c.via !== 'breadboard') continue
    const [a, b] = [endpointKey(c.from), endpointKey(c.to)]
    if (find(a) !== find(b)) problems.push(`연결 ${c.id} 이(가) 브레드보드에서 끊어져 있습니다 (${a} ↔ ${b}).`)
  }
  const rootToNet = new Map<string, string>()
  for (const l of routing.leads) {
    const root = find(l.key)
    const net = netlist.netOf(l.key)
    const other = rootToNet.get(root)
    if (other && other !== net) problems.push(`서로 다른 넷이 브레드보드에서 연결되었습니다 (${net} ↔ ${other}).`)
    rootToNet.set(root, net)
  }
  return { ok: problems.length === 0, problems }
}
