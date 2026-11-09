import { getModule } from '../data/modules'
import type { Connection, Endpoint } from '../types'
import type { Circuit } from './circuit'
import { endpointKey } from './connections'
import { attachedChannel } from './motorAttach'

// 작업 화면에서 부품을 고르면 그 부품의 배선과, 다른 부품을 거쳐 메인보드까지 가는 경로를 강조한다.

export interface Focus {
  /** 고른 부품에 직접 물린 전선 */
  wires: Set<string>
  /** 중간 부품(드라이버·레벨 시프터·전원 등)을 거쳐 보드로 가는 전선 */
  path: Set<string>
  /** 경로 끝의 보드 핀 (끝점 키) */
  boardPins: Set<string>
}

const other = (c: Connection, instanceId: string): Endpoint => (c.from.kind === 'module' && c.from.instanceId === instanceId ? c.to : c.from)
const onModule = (e: Endpoint, instanceId: string): e is Extract<Endpoint, { kind: 'module' }> => e.kind === 'module' && e.instanceId === instanceId

export function focusOf(circuit: Circuit, instanceId: string): Focus {
  const wires = new Set<string>()
  const path = new Set<string>()
  const boardPins = new Set<string>()
  const item = circuit.placed.find((p) => p.instanceId === instanceId)
  if (!item) return { wires, path, boardPins }

  const touching = circuit.connections.filter((c) => onModule(c.from, instanceId) || onModule(c.to, instanceId))
  for (const c of touching) {
    wires.add(c.id)
    const far = other(c, instanceId)
    if (far.kind === 'board') {
      boardPins.add(endpointKey(far))
      continue
    }
    // 다른 부품을 거친다: 그 부품에서 보드로 가는 관련 전선을 따라간다 (한 단계)
    const mid = circuit.placed.find((p) => p.instanceId === far.instanceId)
    if (!mid) continue
    const midModule = getModule(mid.moduleId)
    let pins: Set<string> | null = null
    if (midModule.driver) {
      const channel = attachedChannel(circuit, item, mid)
      // 채널 제어선이 따로 없는 드라이버(PCA9685)는 I²C 같은 신호선으로 보드와 이어진다
      if (channel) pins = new Set(channel.inputs.length ? channel.inputs : midModule.pins.filter((p) => p.role === 'signal').map((p) => p.id))
    } else if (midModule.passThrough) {
      const pair = midModule.passThrough.find(([a, b]) => a === far.pinId || b === far.pinId)
      if (pair) pins = new Set(pair.filter((p) => p !== far.pinId))
    }
    for (const d of circuit.connections) {
      if (d === c) continue
      const end = onModule(d.from, mid.instanceId) ? d.from : onModule(d.to, mid.instanceId) ? d.to : null
      if (!end || end.kind !== 'module') continue
      const next = other(d, mid.instanceId)
      if (next.kind !== 'board' || (pins && !pins.has(end.pinId))) continue
      path.add(d.id)
      boardPins.add(endpointKey(next))
    }
  }
  return { wires, path, boardPins }
}
