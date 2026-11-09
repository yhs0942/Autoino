import { findModule } from '../data/modules'
import { BREADBOARD_SIZE } from '../utils/placement'
import { BB_COLUMNS, holeName, type BbLead, type BreadboardRouting, type Hole, type MainRow, type RailId } from './breadboard'
import type { Circuit } from './circuit'
import { describeEndpoint, parseEndpointKey } from './connections'
import { esc, SIGNAL_COLORS, svgDocument } from './svgUtil'

// 브레드보드 그림. 배선도 위 표시와 이미지 내보내기가 같은 그림을 쓴다.

const P = 10 // 구멍 간격(px)
const HOLE = 5
const ROW_Y: Record<MainRow, number> = { a: 44, b: 54, c: 64, d: 74, e: 84, f: 100, g: 110, h: 120, i: 130, j: 140 }
const RAIL_Y: Record<RailId, number> = { 'top+': 14, 'top-': 26, 'bot+': 154, 'bot-': 166 }
const { width: BODY_W, height: BODY_H } = BREADBOARD_SIZE
const SCALE = 1.4
const MARGIN = 24

const colX = (col: number) => 12 + col * P

/** 브레드보드 왼쪽 위를 원점으로 한 구멍 위치 */
export function holeXY(h: Hole): { x: number; y: number } {
  return { x: colX(h.col), y: h.kind === 'rail' ? RAIL_Y[h.rail] : ROW_Y[h.row] }
}

/** 전선이 구멍으로 들어오는 방향 (위: -1, 아래: 1) */
export function holeDirection(h: Hole): number {
  return h.kind === 'rail' && h.rail.startsWith('bot') ? 1 : -1
}

const key = (h: Hole) => (h.kind === 'rail' ? `R:${h.rail}:${h.col}` : `M:${h.row}:${h.col}`)

/** 전선 색: 전원 빨강, GND 짙은 회색, 신호는 넷마다 다른 색 */
export function leadColors(routing: BreadboardRouting): Map<string, string> {
  const colors = new Map<string, string>()
  const signal = new Map<string, string>()
  for (const l of routing.leads) {
    if (l.kind === 'power') colors.set(l.key, '#dc2626')
    else if (l.kind === 'ground') colors.set(l.key, '#1f2937')
    else {
      if (!signal.has(l.net)) signal.set(l.net, SIGNAL_COLORS[signal.size % SIGNAL_COLORS.length])
      colors.set(l.key, signal.get(l.net)!)
    }
  }
  return colors
}

/** 브레드보드 본체 (구멍, 레일, 점퍼, 저항). 0,0 부터 BODY_W×BODY_H 크기로 그린다 */
export function renderBreadboardBody(routing: BreadboardRouting): string {
  const parts: string[] = []
  const colors = leadColors(routing)
  const used = new Map<string, string>()
  for (const l of routing.leads) used.set(key(l.hole), colors.get(l.key) ?? '#475569')
  for (const j of routing.jumpers) for (const h of [j.from, j.to]) used.set(key(h), '#475569')

  parts.push(`<rect x="0.5" y="0.5" width="${BODY_W - 1}" height="${BODY_H - 1}" rx="8" fill="#f8fafc" stroke="#cbd5e1"/>`)
  parts.push(`<rect x="6" y="${ROW_Y.e + 6}" width="${BODY_W - 12}" height="${ROW_Y.f - ROW_Y.e - 12}" fill="#e2e8f0"/>`)

  const hole = (x: number, y: number, fill: string) => `<rect x="${x - HOLE / 2}" y="${y - HOLE / 2}" width="${HOLE}" height="${HOLE}" rx="1" fill="${fill}"/>`
  for (const rail of Object.keys(RAIL_Y) as RailId[]) {
    const y = RAIL_Y[rail]
    const color = rail.endsWith('+') ? '#dc2626' : '#2563eb'
    const lineY = y + (rail.endsWith('+') ? -5.5 : 5.5)
    parts.push(`<line x1="8" x2="${BODY_W - 8}" y1="${lineY}" y2="${lineY}" stroke="${color}" stroke-width="1"/>`)
    for (let c = 1; c <= BB_COLUMNS; c++) parts.push(hole(colX(c), y, used.get(key({ kind: 'rail', rail, col: c })) ?? '#cbd5e1'))
    const net = routing.rails[rail]
    parts.push(`<text x="10" y="${y + 3}" font-size="9" font-weight="700" text-anchor="middle" fill="${color}">${rail.endsWith('+') ? '+' : '−'}</text>`)
    if (net) parts.push(`<text x="${BODY_W - 10}" y="${lineY + (rail.endsWith('+') ? -1 : 8)}" font-size="7.5" font-weight="700" text-anchor="end" fill="${color}">${esc(net.label)}</text>`)
  }
  for (const row of Object.keys(ROW_Y) as MainRow[]) {
    const y = ROW_Y[row]
    parts.push(`<text x="8" y="${y + 3}" font-size="7" fill="#94a3b8">${row}</text>`)
    for (let c = 1; c <= BB_COLUMNS; c++) parts.push(hole(colX(c), y, used.get(key({ kind: 'main', row, col: c })) ?? '#d4d4d8'))
  }
  for (let c = 5; c <= BB_COLUMNS; c += 5) parts.push(`<text x="${colX(c)}" y="${ROW_Y.a - 8}" font-size="6.5" text-anchor="middle" fill="#94a3b8">${c}</text>`)

  for (const j of routing.jumpers) {
    const a = holeXY(j.from)
    const b = holeXY(j.to)
    const lift = Math.min(a.y, b.y) - 8 - Math.abs(a.x - b.x) / 12
    parts.push(`<path d="M ${a.x} ${a.y} Q ${(a.x + b.x) / 2} ${lift} ${b.x} ${b.y}" fill="none" stroke="#64748b" stroke-width="1.8" stroke-linecap="round"><title>${esc(j.net)}</title></path>`)
  }
  for (const r of routing.resistors) {
    const a = holeXY({ kind: 'main', col: r.col, row: 'e' })
    const b = holeXY({ kind: 'main', col: r.col, row: 'f' })
    parts.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#78716c" stroke-width="1.8"/>`)
    parts.push(`<rect x="${a.x - 4}" y="${a.y + 2.5}" width="8" height="${b.y - a.y - 5}" rx="2" fill="#e7c98f" stroke="#92400e" stroke-width="0.7"><title>${esc(`직렬 저항 ${r.label}`)}</title></rect>`)
    parts.push(`<text x="${a.x + 6}" y="${(a.y + b.y) / 2 + 2.5}" font-size="6.5" font-weight="700" fill="#78350f">${esc(r.label.replace(' ', ''))}</text>`)
  }
  return parts.join('')
}

/** 끝점 이름 (배선표용) */
export function leadLabel(lead: BbLead, circuit: Circuit): string {
  const e = parseEndpointKey(lead.key)
  return e ? describeEndpoint(e, circuit) : lead.key
}

/** 내보내기용 문서: 브레드보드 그림과 구멍별 배선표 */
export function renderBreadboardSvg(routing: BreadboardRouting, circuit: Circuit, title: string): string {
  const parts: string[] = []
  const bodyW = BODY_W * SCALE
  const bodyH = BODY_H * SCALE
  const width = bodyW + MARGIN * 2
  const tableTop = MARGIN + 44 + bodyH + 26
  const ROW = 16
  const perColumn = 26
  const columns = 2
  const colW = bodyW / columns

  parts.push(`<text x="${MARGIN}" y="${MARGIN + 14}" font-size="15" font-weight="700" fill="#0f172a">${esc(title)} · 브레드보드 배치</text>`)
  parts.push(
    `<text x="${MARGIN}" y="${MARGIN + 30}" font-size="10" fill="#64748b">830홀 브레드보드 기준 · 각 열의 a–e, f–j 는 내부 연결 · 레일이 가운데에서 끊어진 제품은 점퍼로 이으세요 · Autoino 자동 배치</text>`,
  )
  parts.push(`<g transform="translate(${MARGIN} ${MARGIN + 44}) scale(${SCALE})">${renderBreadboardBody(routing)}</g>`)

  parts.push(`<text x="${MARGIN}" y="${tableTop}" font-size="12" font-weight="700" fill="#0f172a">구멍별 배선표</text>`)
  const colors = leadColors(routing)
  const rows = routing.leads.map((l) => ({ hole: holeName(l.hole), label: leadLabel(l, circuit), color: colors.get(l.key) ?? '#475569' }))
  rows.push(...routing.jumpers.map((j) => ({ hole: `${holeName(j.from)} ↔ ${holeName(j.to)}`, label: `점퍼 (${j.net})`, color: '#64748b' })))
  rows.push(...routing.resistors.map((r) => ({ hole: `${r.col}e ↔ ${r.col}f`, label: `직렬 저항 ${r.label}`, color: '#92400e' })))
  rows.forEach((row, i) => {
    const col = Math.floor(i / perColumn)
    const x = MARGIN + (col % columns) * colW
    const y = tableTop + 18 + (i % perColumn) * ROW
    parts.push(`<circle cx="${x + 5}" cy="${y - 4}" r="4" fill="${row.color}"/>`)
    parts.push(`<text x="${x + 15}" y="${y}" font-size="10" font-weight="700" fill="#0f172a">${esc(row.hole)}</text>`)
    parts.push(`<text x="${x + 100}" y="${y}" font-size="10" fill="#334155">${esc(row.label)}</text>`)
  })
  const unplugged = circuit.placed.filter((p) => findModule(p.moduleId) && !routing.leads.some((l) => l.key.startsWith(`module:${p.instanceId}:`))).map((p) => p.label)
  const rowCount = Math.min(rows.length, perColumn)
  let bottom = tableTop + 18 + rowCount * ROW + 8
  if (unplugged.length) {
    parts.push(`<text x="${MARGIN}" y="${bottom + 6}" font-size="10" fill="#64748b">브레드보드를 거치지 않는 부품: ${esc(unplugged.join(', '))}</text>`)
    bottom += 20
  }
  return svgDocument(width, bottom + MARGIN, parts.join(''), `${title} 브레드보드`)
}
