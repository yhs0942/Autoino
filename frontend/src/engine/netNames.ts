import { boardDefOf, boardLabel, type Circuit } from './circuit'
import { parseEndpointKey, resolveModulePin } from './connections'
import { groundPinsOf, sourceVoltage, supplyPinOf } from './electrical'
import type { Netlist } from './netlist'

// 넷 이름 붙이기 (회로도·브레드보드 표시용)
// - GND 핀이 있는 넷: GND
// - 전원 핀이 있는 넷: "5V (5 V)" 처럼 핀 이름과 전압
// - 외부 전원 출력이 있는 넷: 부품 이름과 전압, 외부 전원 − 넷: "외부 전원 1 GND"
// - 보드 GPIO 가 있는 넷: 그 핀 이름 (보드가 여러 개면 "보드 2 GPIO16")
// - 그 밖(부품끼리만 연결): N1, N2 …

export type NetKind = 'power' | 'ground' | 'signal'

export interface NetInfo {
  name: string
  kind: NetKind
  voltage?: number
}

export function nameNets(circuit: Circuit, netlist: Netlist): Map<string, NetInfo> {
  const result = new Map<string, NetInfo>()
  let anon = 1
  for (const [net, keys] of [...netlist.members].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let info: NetInfo | null = null
    let sourceInfo: NetInfo | null = null
    let sourceGround: NetInfo | null = null
    let gpioName = ''
    for (const k of keys) {
      const e = parseEndpointKey(k)
      if (e?.kind === 'module') {
        const r = resolveModulePin(circuit.placed, e)
        if (!r) continue
        const sources = r.module.pins.filter((p) => p.role === 'source')
        if (r.pin.role === 'source' && !sourceInfo)
          sourceInfo = {
            name: sources.length > 1 ? `${r.placed.label} ${r.pin.name}` : r.placed.label,
            kind: 'power',
            voltage: sourceVoltage(r.module, r.placed, r.pin) ?? undefined,
          }
        if (r.pin.role === 'ground' && sources.length && !sourceGround) sourceGround = { name: `${r.placed.label} GND`, kind: 'ground', voltage: 0 }
        continue
      }
      if (e?.kind !== 'board') continue
      const def = boardDefOf(circuit, e.boardInstanceId)
      if (!def) continue
      const prefix = circuit.boards.length > 1 ? `${boardLabel(circuit, e.boardInstanceId)} ` : ''
      if (groundPinsOf(def).includes(e.pinId)) {
        info = { name: circuit.boards.length > 1 ? `${prefix}GND` : 'GND', kind: 'ground', voltage: 0 }
        break
      }
      const supply = supplyPinOf(def, e.pinId)
      if (supply && !info) info = { name: `${prefix}${e.pinId}`, kind: 'power', voltage: supply.voltage }
      else if (!gpioName) gpioName = `${prefix}${e.pinId}`
    }
    result.set(net, info ?? sourceInfo ?? sourceGround ?? { name: gpioName || `N${anon++}`, kind: 'signal' })
  }
  return result
}
