import { findModule } from '../data/modules'
import { resolveBoardPin, type Circuit } from './circuit'
import { boardPinFor, endpointKey, moduleEndpoint, parseEndpointKey } from './connections'
import { isGpio } from './electrical'
import { buildNetlist, type Netlist } from './netlist'

// 부품 핀에서 보드 핀까지의 신호 경로 추적.
// 레벨 시프터·전압 분배기처럼 신호를 전달하는 부품(passThrough)을 거친 경로도 찾는다.

export interface SignalRoute {
  boardInstanceId: string
  pinId: string
  /** 경유한 부품 표시 이름 (직접 연결이면 빈 배열) */
  via: string[]
}

export function routeToBoard(circuit: Circuit, instanceId: string, pinId: string, traced?: Netlist): SignalRoute | null {
  const direct = boardPinFor(circuit.connections, instanceId, pinId)
  if (direct) return { ...direct, via: [] }
  const net = traced ?? buildNetlist(circuit, { passThrough: true })
  const key = endpointKey(moduleEndpoint(instanceId, pinId))
  const members = net.members.get(net.netOf(key)) ?? []
  // GPIO 를 우선하고, 없으면 전원·GND 핀
  let best: { boardInstanceId: string; pinId: string; gpio: boolean } | null = null
  const via = new Set<string>()
  for (const k of members) {
    const e = parseEndpointKey(k)
    if (!e) continue
    if (e.kind === 'board') {
      const r = resolveBoardPin(circuit, e.boardInstanceId, e.pinId)
      const gpio = !!r?.pin && isGpio(r.pin)
      if (!best || (gpio && !best.gpio)) best = { boardInstanceId: e.boardInstanceId, pinId: e.pinId, gpio }
    } else if (e.instanceId !== instanceId) {
      const item = circuit.placed.find((p) => p.instanceId === e.instanceId)
      const module = item && findModule(item.moduleId)
      if (item && module?.passThrough?.some((pair) => pair.includes(e.pinId))) via.add(item.label)
    }
  }
  return best ? { boardInstanceId: best.boardInstanceId, pinId: best.pinId, via: [...via] } : null
}
