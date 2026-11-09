import { findModule } from '../data/modules'
import { boardDefOf, type Circuit } from './circuit'
import { endpointKey, moduleEndpoint } from './connections'
import { groundPinsOf } from './electrical'

// 넷리스트: 전기적으로 연결된 끝점(핀)들의 묶음.
// - 전선(connections)으로 이어진 핀
// - 같은 보드의 GND 핀들 (보드 내부에서 연결됨)
// - 부품 내부에서 항상 연결된 핀 (internalConnections)
// passThrough=true 이면 레벨 시프터·분배기처럼 신호를 "전달"하는 핀 쌍도 같은 넷으로 본다
// (전기적으로는 다른 넷이지만 신호 경로를 추적할 때 사용).

export interface Netlist {
  /** 끝점 키 → 넷 ID. 어떤 연결에도 속하지 않은 키는 자기 자신이 넷 ID */
  netOf: (key: string) => string
  /** 넷 ID → 구성 키 (연결이 있는 넷만) */
  members: Map<string, string[]>
}

export function buildNetlist(circuit: Circuit, options: { passThrough?: boolean } = {}): Netlist {
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    let root = k
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!
    // 경로 압축
    let cur = k
    while (parent.has(cur) && parent.get(cur) !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  const add = (k: string) => {
    if (!parent.has(k)) parent.set(k, k)
  }
  const union = (a: string, b: string) => {
    add(a)
    add(b)
    const ra = find(a)
    const rb = find(b)
    // 결정적인 결과를 위해 사전순으로 작은 키를 대표로 둔다
    if (ra === rb) return
    if (ra < rb) parent.set(rb, ra)
    else parent.set(ra, rb)
  }

  for (const c of circuit.connections) union(endpointKey(c.from), endpointKey(c.to))
  for (const instance of circuit.boards) {
    const board = boardDefOf(circuit, instance.instanceId)
    if (!board) continue
    const grounds = groundPinsOf(board).map((id) => `board:${instance.instanceId}:${id}`)
    for (const g of grounds.slice(1)) union(grounds[0], g)
  }
  for (const item of circuit.placed) {
    const module = findModule(item.moduleId)
    const pairs = [...(module?.internalConnections ?? []), ...(options.passThrough ? (module?.passThrough ?? []) : [])]
    for (const [a, b] of pairs)
      union(endpointKey(moduleEndpoint(item.instanceId, a)), endpointKey(moduleEndpoint(item.instanceId, b)))
  }

  const members = new Map<string, string[]>()
  for (const k of [...parent.keys()].sort()) {
    const root = find(k)
    members.set(root, [...(members.get(root) ?? []), k])
  }
  return { netOf: (k) => (parent.has(k) ? find(k) : k), members }
}
