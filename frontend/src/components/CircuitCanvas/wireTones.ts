import type { BbLead, BreadboardRouting } from '../../engine/breadboard'
import { leadColors } from '../../engine/breadboardSvg'
import { endpointKey, resolveModulePin } from '../../engine/connections'
import type { Connection, PlacedModule } from '../../types'

// 전선 색. 전선과 부품 핀 칩(전선 색 점)이 같은 색을 쓰도록 한곳에서 정한다.

export interface Tone {
  /** 전선에 붙이는 클래스 (wire--power 등) */
  className: string
  /** 실제 색 (CSS 값) */
  color: string
}

/** CircuitCanvas.css 의 .wire--signal-N 과 같은 순서 */
const SIGNAL = ['#2563eb', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#ca8a04']
const POWER = 'var(--wire-power)'
const GROUND = 'var(--wire-ground)'
const LINK = '#db2777'

function leadTone(lead: BbLead, colors: Map<string, string>): Tone {
  if (lead.kind === 'power') return { className: 'wire--power', color: POWER }
  if (lead.kind === 'ground') return { className: 'wire--ground', color: GROUND }
  return { className: 'wire--lead', color: colors.get(lead.key) ?? SIGNAL[0] }
}

export function wireTones(connections: Connection[], placed: PlacedModule[], routing: BreadboardRouting) {
  const wires = new Map<string, Tone>()
  const leads = new Map<string, Tone>()
  /** 부품 핀 끝점 키 → 그 핀에 물린 전선 색 */
  const ends = new Map<string, string>()
  let signal = 0
  for (const c of connections) {
    if (c.via === 'breadboard') continue
    const role = [c.from, c.to].map((e) => resolveModulePin(placed, e)?.pin.role).find(Boolean) ?? 'signal'
    const tone: Tone = c.linkId
      ? { className: 'wire--link', color: LINK }
      : role === 'power' || role === 'source'
        ? { className: 'wire--power', color: POWER }
        : role === 'ground'
          ? { className: 'wire--ground', color: GROUND }
          : (() => {
              const n = signal++ % SIGNAL.length
              return { className: `wire--signal-${n}`, color: SIGNAL[n] }
            })()
    wires.set(c.id, tone)
    for (const e of [c.from, c.to]) if (e.kind === 'module' && !ends.has(endpointKey(e))) ends.set(endpointKey(e), tone.color)
  }
  const colors = leadColors(routing)
  for (const lead of routing.leads) {
    const tone = leadTone(lead, colors)
    leads.set(lead.key, tone)
    if (lead.key.startsWith('module:') && !ends.has(lead.key)) ends.set(lead.key, tone.color)
  }
  return { wires, leads, ends }
}

export type WireTones = ReturnType<typeof wireTones>
