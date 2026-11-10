import { findBoard } from '../data/boards'
import { CAPABILITY_LABELS, ROLE_LABELS } from '../data/labels'
import { getModule } from '../data/modules'
import type { BreadboardRouting } from './breadboard'
import { boardLabel, resolveBoardPin, type Circuit } from './circuit'
import { isInternalPin, isPinConnected, requiredPins } from './connections'
import { buildNetlist } from './netlist'
import { routeToBoard } from './paths'
import { computeSeriesResistors, formatOhms } from './resistor'
import { computeLadderResistors, shareBoardPin, shareOf } from './shares'
import { muxChannelOf } from './mux'

// 부품 목록(BOM)과 핀 배정표 생성. 화면 표시와 CSV 내보내기가 같은 데이터를 사용한다.

export interface PinTableRow {
  instanceId: string
  moduleLabel: string
  pinName: string
  role: string
  /** 연결하지 않아도 되는 핀 (내부 연결된 수동 핀) */
  optional: boolean
  /** 보드 이름 (보드가 여러 개일 때만 값이 있음) */
  boardName: string
  boardPin: string
  boardPinFeatures: string
  note: string
}

export function buildPinTable(circuit: Circuit): PinTableRow[] {
  const resistors = computeSeriesResistors(circuit)
  const ladder = computeLadderResistors(circuit)
  const traced = buildNetlist(circuit, { passThrough: true })
  const rows: PinTableRow[] = []
  for (const item of circuit.placed) {
    const module = getModule(item.moduleId)
    const required = requiredPins(circuit.connections, item.instanceId, module)
    for (const pin of module.pins) {
      // 핀 배정표는 "사용자가 연결해야 하는 배선"을 보여 주므로, 자기 전선이 있는 핀만 경로를 추적한다
      // (택트 스위치 1B 처럼 내부에서만 연결된 핀은 '연결 불필요'로 표시)
      const connected = isPinConnected(circuit.connections, item.instanceId, pin.id)
      const route = connected ? routeToBoard(circuit, item.instanceId, pin.id, traced) : null
      const target = route ? resolveBoardPin(circuit, route.boardInstanceId, route.pinId) : null
      const res = resistors.find((r) => r.instanceId === item.instanceId && r.pinId === pin.id)
      const notes: string[] = []
      if (res?.status === 'ok') notes.push(`직렬 저항 ${formatOhms(res.choice.standardOhms)}`)
      const rung = ladder.find((r) => r.instanceId === item.instanceId && r.pinId === pin.id)
      if (rung) notes.push(rung.ohms ? `사다리 저항 ${formatOhms(rung.ohms)}` : '사다리 (저항 없이)')
      const share = shareOf(circuit, `module:${item.instanceId}:${pin.id}`)
      const shared = share && route && shareBoardPin(circuit, share)?.pinId === route.pinId
      if (shared) notes.push(`핀 공유 (${share.members.length}개)`)
      if (route?.via.length) notes.push(`${route.via.join(', ')} 경유`)
      const optional = !required.includes(pin)
      if (!connected && optional) notes.push(isInternalPin(module, pin.id) ? '연결 불필요 (내부 연결)' : '연결 불필요')
      else if (connected && !route) {
        const ch = muxChannelOf(circuit, `module:${item.instanceId}:${pin.id}`)
        const mux = ch && circuit.placed.find((p) => p.instanceId === ch.muxId)
        const sig = mux && routeToBoard(circuit, mux.instanceId, getModule(mux.moduleId).mux!.common, traced)
        notes.push(mux ? `${mux.label} C${ch.channel} (SIG → ${sig?.pinId ?? '미연결'})` : '다른 부품에 연결')
      }
      rows.push({
        instanceId: item.instanceId,
        moduleLabel: item.label,
        pinName: pin.name,
        role: ROLE_LABELS[pin.role],
        optional,
        boardName: route && circuit.boards.length > 1 ? boardLabel(circuit, route.boardInstanceId) : '',
        boardPin: route?.pinId ?? '',
        boardPinFeatures: target?.pin ? target.pin.capabilities.map((c) => CAPABILITY_LABELS[c]).join(', ') : '',
        note: notes.join(' · '),
      })
    }
  }
  return rows
}

export interface BomRow {
  item: string
  spec: string
  quantity: number
  note: string
}

export function buildBom(circuit: Circuit, breadboard?: BreadboardRouting): BomRow[] {
  const rows: BomRow[] = []
  const byBoard = new Map<string, string[]>()
  for (const b of circuit.boards) byBoard.set(b.boardId, [...(byBoard.get(b.boardId) ?? []), b.label])
  for (const [boardId, labels] of byBoard) {
    const board = findBoard(boardId)
    if (board) rows.push({ item: board.name, spec: board.microcontroller, quantity: labels.length, note: `메인 보드 (${labels.join(', ')})` })
  }
  const byModule = new Map<string, { spec: string; labels: string[] }>()
  for (const p of circuit.placed) {
    const module = getModule(p.moduleId)
    // 파라미터가 사양을 바꾸는 부품(분배기 저항 조합, 외부 전원 전압 등)은 사양별로 나눈다
    const paramSpec = (module.parameters ?? [])
      .filter((param) => param.bom)
      .map((param) => param.options.find((o) => o.value === (p.params[param.id] ?? param.defaultValue))?.label ?? '')
      .join(' ')
    const key = `${p.moduleId}|${paramSpec}`
    const entry = byModule.get(key) ?? { spec: paramSpec ? `${module.nameEn} · ${paramSpec}` : module.nameEn, labels: [] }
    entry.labels.push(p.label)
    byModule.set(key, entry)
  }
  for (const [key, entry] of byModule) {
    const module = getModule(key.split('|')[0])
    rows.push({ item: module.name, spec: entry.spec, quantity: entry.labels.length, note: entry.labels.join(', ') })
  }
  const byResistor = new Map<string, { quantity: number; labels: string[] }>()
  for (const r of computeSeriesResistors(circuit)) {
    if (r.status !== 'ok') continue
    const key = `${formatOhms(r.choice.standardOhms)}|${r.choice.ratingLabel}`
    const entry = byResistor.get(key) ?? { quantity: 0, labels: [] }
    entry.quantity += 1
    entry.labels.push(circuit.placed.find((p) => p.instanceId === r.instanceId)!.label)
    byResistor.set(key, entry)
  }
  for (const [key, entry] of byResistor) {
    const [value, rating] = key.split('|')
    rows.push({ item: '저항', spec: `${value} ${rating} (E12)`, quantity: entry.quantity, note: `${entry.labels.join(', ')} 직렬 저항` })
  }
  const byRung = new Map<number, string[]>()
  for (const r of computeLadderResistors(circuit)) {
    if (!r.ohms) continue
    byRung.set(r.ohms, [...(byRung.get(r.ohms) ?? []), circuit.placed.find((p) => p.instanceId === r.instanceId)!.label])
  }
  for (const [ohms, labels] of byRung) rows.push({ item: '저항', spec: `${formatOhms(ohms)} 1/4 W (E12)`, quantity: labels.length, note: `${labels.join(', ')} 버튼 사다리` })
  if (breadboard?.leads.length) {
    const direct = circuit.connections.filter((c) => c.via !== 'breadboard').length
    rows.push({ item: '브레드보드', spec: '830홀 (63열)', quantity: 1, note: 'Autoino 자동 배치 기준' })
    rows.push({ item: '점퍼 와이어', spec: '', quantity: direct + breadboard.leads.length + breadboard.jumpers.length, note: '브레드보드 경유 배선 포함' })
  } else if (circuit.connections.length)
    rows.push({ item: '점퍼 와이어', spec: '', quantity: circuit.connections.length, note: '브레드보드 배선에 따라 달라질 수 있음' })
  return rows
}

function csvCell(value: string | number): string {
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** UTF-8 BOM 을 붙여 엑셀에서 한글이 깨지지 않게 한다. */
export function toCsv(header: string[], rows: (string | number)[][]): string {
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

export function bomCsv(circuit: Circuit, breadboard?: BreadboardRouting): string {
  return toCsv(['품목', '사양', '수량', '비고'], buildBom(circuit, breadboard).map((r) => [r.item, r.spec, r.quantity, r.note]))
}

export function pinTableCsv(circuit: Circuit): string {
  const multi = circuit.boards.length > 1
  return toCsv(
    ['부품', '부품 핀', '역할', ...(multi ? ['보드'] : []), '보드 핀', '보드 핀 기능', '비고'],
    buildPinTable(circuit).map((r) => [
      r.moduleLabel,
      r.pinName,
      r.role,
      ...(multi ? [r.boardName] : []),
      r.boardPin || (r.optional ? '' : '미연결'),
      r.boardPinFeatures,
      r.note,
    ]),
  )
}
