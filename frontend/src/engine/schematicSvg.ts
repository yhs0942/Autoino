import { findBoard } from '../data/boards'
import { getModule } from '../data/modules'
import { resolveBoardPin, type Circuit } from './circuit'
import { endpointKey, isInternalPin, isPinConnected, moduleEndpoint, requiredPins } from './connections'
import { buildNetlist } from './netlist'
import { nameNets, type NetInfo } from './netNames'
import { computeSeriesResistors } from './resistor'
import { esc, MONO, svgDocument } from './svgUtil'

// 넷 라벨 방식 회로도 (SVG)
// 보드와 부품을 블록으로 그리고 각 핀에 넷 이름을 붙인다. 같은 이름의 라벨은 서로 연결된 것이다.
// 직렬 저항은 해당 핀의 선 위에 저항 기호로 그린다.

const BLOCK_W = 170
const ROW = 20
const STUB = 46

function labelColor(info: NetInfo | undefined): string {
  if (!info) return '#64748b'
  if (info.kind === 'ground') return '#1f2937'
  if (info.kind === 'power') return '#dc2626'
  return '#1d4ed8'
}

function netLabel(x: number, y: number, info: NetInfo | undefined, anchor: 'start' | 'end'): string {
  const text = info ? (info.kind === 'power' && info.voltage !== undefined ? `${info.name} (${info.voltage} V)` : info.name) : '—'
  const color = labelColor(info)
  const w = text.length * 6.4 + 12
  const rx = anchor === 'start' ? x : x - w
  return (
    `<rect x="${rx}" y="${y - 8}" width="${w}" height="16" rx="3" fill="#ffffff" stroke="${color}" stroke-width="1"/>` +
    `<text x="${rx + w / 2}" y="${y + 4}" font-size="10" text-anchor="middle" fill="${color}" font-weight="600">${esc(text)}</text>`
  )
}

function resistorSymbol(x1: number, x2: number, y: number, value: string): string {
  const mid = (x1 + x2) / 2
  const pts = [-12, -8, -4, 0, 4, 8, 12].map((dx, i) => `${mid + dx},${y + (i % 2 === 0 ? 0 : i % 4 === 1 ? -5 : 5)}`)
  return (
    `<line x1="${x1}" y1="${y}" x2="${mid - 12}" y2="${y}" stroke="#334155" stroke-width="1.4"/>` +
    `<polyline points="${pts.join(' ')}" fill="none" stroke="#92400e" stroke-width="1.6"/>` +
    `<line x1="${mid + 12}" y1="${y}" x2="${x2}" y2="${y}" stroke="#334155" stroke-width="1.4"/>` +
    `<text x="${mid}" y="${y - 8}" font-size="9" text-anchor="middle" fill="#92400e" font-weight="700">${esc(value)}</text>`
  )
}

export function renderSchematicSvg(circuit: Circuit, title: string, date = new Date()): string {
  const netlist = buildNetlist(circuit)
  const names = nameNets(circuit, netlist)
  const infoOf = (key: string) => (netlist.members.has(netlist.netOf(key)) ? names.get(netlist.netOf(key)) : undefined)
  const resistors = computeSeriesResistors(circuit)
  const parts: string[] = []
  const margin = 24

  // ---------- 보드 (왼쪽 열) ----------
  let y = margin + 56
  const boardX = margin
  for (const b of circuit.boards) {
    const def = findBoard(b.boardId)
    const used = (def?.pins ?? []).filter((p) => circuit.connections.some((c) => [c.from, c.to].some((e) => e.kind === 'board' && e.boardInstanceId === b.instanceId && e.pinId === p.id)))
    const h = 36 + Math.max(1, used.length) * ROW
    parts.push(`<rect x="${boardX}" y="${y}" width="${BLOCK_W}" height="${h}" fill="#f0f9ff" stroke="#0c4a6e" stroke-width="1.6"/>`)
    parts.push(`<text x="${boardX + 8}" y="${y + 16}" font-size="11" font-weight="700" fill="#0c4a6e">${esc(circuit.boards.length > 1 ? `${b.label} · ` : '')}${esc(def?.name ?? b.boardId)}</text>`)
    parts.push(`<text x="${boardX + 8}" y="${y + 28}" font-size="8" fill="#64748b">${esc(def?.microcontroller.split(' ')[0] ?? '')} · ${def?.logicVoltage ?? ''} V 로직</text>`)
    used.forEach((p, i) => {
      const py = y + 36 + i * ROW + 6
      const r = resolveBoardPin(circuit, b.instanceId, p.id)
      parts.push(`<text x="${boardX + BLOCK_W - 6}" y="${py + 3}" font-size="9" text-anchor="end" fill="#0f172a" font-family="${esc(MONO)}">${esc(r?.pin?.label === p.id ? p.id : `${p.label} (${p.id})`)}</text>`)
      parts.push(`<line x1="${boardX + BLOCK_W}" y1="${py}" x2="${boardX + BLOCK_W + STUB / 2}" y2="${py}" stroke="#334155" stroke-width="1.4"/>`)
      parts.push(netLabel(boardX + BLOCK_W + STUB / 2, py, infoOf(`board:${b.instanceId}:${p.id}`), 'start'))
    })
    y += h + 30
  }
  const boardsBottom = y

  // ---------- 부품 (오른쪽, 2열) ----------
  const colX0 = boardX + BLOCK_W + 220
  const colW = BLOCK_W + 260
  const colY = [margin + 56, margin + 56]
  circuit.placed.forEach((item) => {
    const module = getModule(item.moduleId)
    const required = requiredPins(circuit.connections, item.instanceId, module)
    const col = colY[0] <= colY[1] ? 0 : 1
    const x = colX0 + col * colW + STUB + 110
    const top = colY[col]
    const h = 36 + module.pins.length * ROW
    parts.push(`<rect x="${x}" y="${top}" width="${BLOCK_W}" height="${h}" fill="#ffffff" stroke="#475569" stroke-width="1.4"/>`)
    parts.push(`<text x="${x + 8}" y="${top + 16}" font-size="11" font-weight="700" fill="#0f172a">${esc(item.label)}</text>`)
    parts.push(`<text x="${x + 8}" y="${top + 28}" font-size="8" fill="#64748b">${esc(module.nameEn)}</text>`)
    module.pins.forEach((pin, pi) => {
      const py = top + 36 + pi * ROW + 6
      parts.push(`<text x="${x + 6}" y="${py + 3}" font-size="9" fill="#0f172a">${esc(pin.name)}</text>`)
      const key = endpointKey(moduleEndpoint(item.instanceId, pin.id))
      if (!isPinConnected(circuit.connections, item.instanceId, pin.id)) {
        parts.push(`<line x1="${x - 14}" y1="${py}" x2="${x}" y2="${py}" stroke="#cbd5e1" stroke-width="1.2"/>`)
        parts.push(`<text x="${x - 18}" y="${py + 3}" font-size="9" text-anchor="end" fill="#94a3b8">${isInternalPin(module, pin.id) ? '(내부 연결)' : required.includes(pin) ? '미연결 ×' : '(연결 안 함)'}</text>`)
        return
      }
      const res = resistors.find((r) => r.status === 'ok' && r.instanceId === item.instanceId && r.pinId === pin.id)
      if (res?.status === 'ok') {
        parts.push(resistorSymbol(x - STUB - 40, x, py, res.choice.standardOhms >= 1000 ? `${res.choice.standardOhms / 1000}k` : `${res.choice.standardOhms}Ω`))
        parts.push(netLabel(x - STUB - 40, py, infoOf(key), 'end'))
      } else {
        parts.push(`<line x1="${x - STUB / 2}" y1="${py}" x2="${x}" y2="${py}" stroke="#334155" stroke-width="1.4"/>`)
        parts.push(netLabel(x - STUB / 2, py, infoOf(key), 'end'))
      }
    })
    colY[col] = top + h + 24
  })

  const height = Math.max(boardsBottom, ...colY) + 60
  const width = colX0 + colW * 2
  // 제목 블록
  parts.push(`<text x="${margin}" y="${margin + 16}" font-size="16" font-weight="700" fill="#0f172a">${esc(title)}</text>`)
  parts.push(
    `<text x="${margin}" y="${margin + 34}" font-size="10" fill="#64748b">회로도 (넷 라벨 방식: 같은 이름의 라벨은 서로 연결됨) · ${esc(date.toISOString().slice(0, 10))} · Autoino</text>`,
  )
  parts.push(`<line x1="${margin}" y1="${height - 30}" x2="${width - margin}" y2="${height - 30}" stroke="#e2e8f0"/>`)
  parts.push(
    `<text x="${margin}" y="${height - 14}" font-size="9" fill="#94a3b8">저항값과 전기적 사양은 부품 데이터의 대표값 기준입니다. 실제 제품의 데이터시트로 확인하세요.</text>`,
  )
  return svgDocument(width, height, parts.join(''), title)
}
