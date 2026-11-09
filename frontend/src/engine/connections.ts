import { findModule } from '../data/modules'
import type { Board, Connection, DriverChannel, Endpoint, Module, ModulePin, PlacedModule } from '../types'
import { boardLabel, type Circuit } from './circuit'

// 연결(전선) 데이터를 다루는 순수 함수 모음

export function endpointKey(e: Endpoint): string {
  return e.kind === 'board' ? `board:${e.boardInstanceId}:${e.pinId}` : `module:${e.instanceId}:${e.pinId}`
}

export function parseEndpointKey(key: string): Endpoint | null {
  const split = (rest: string): [string, string] | null => {
    const sep = rest.lastIndexOf(':')
    return sep > 0 ? [rest.slice(0, sep), rest.slice(sep + 1)] : null
  }
  if (key.startsWith('board:')) {
    const parts = split(key.slice('board:'.length))
    return parts && { kind: 'board', boardInstanceId: parts[0], pinId: parts[1] }
  }
  if (key.startsWith('module:')) {
    const parts = split(key.slice('module:'.length))
    return parts && { kind: 'module', instanceId: parts[0], pinId: parts[1] }
  }
  return null
}

export function boardEndpoint(boardInstanceId: string, pinId: string): Endpoint {
  return { kind: 'board', boardInstanceId, pinId }
}

export function moduleEndpoint(instanceId: string, pinId: string): Endpoint {
  return { kind: 'module', instanceId, pinId }
}

export function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return endpointKey(a) === endpointKey(b)
}

export function touches(c: Connection, e: Endpoint): boolean {
  return sameEndpoint(c.from, e) || sameEndpoint(c.to, e)
}

export function touchesInstance(c: Connection, instanceId: string): boolean {
  return [c.from, c.to].some((e) => e.kind === 'module' && e.instanceId === instanceId)
}

export function touchesBoard(c: Connection, boardInstanceId: string): boolean {
  return [c.from, c.to].some((e) => e.kind === 'board' && e.boardInstanceId === boardInstanceId)
}

export function isBoardToBoard(c: Connection): boolean {
  return c.from.kind === 'board' && c.to.kind === 'board'
}

export interface BoardPinRef {
  boardInstanceId: string
  pinId: string
}

/** 모듈 핀 ↔ 보드 핀 연결이면 정규화된 형태로 반환한다. */
export interface ModuleBoardLink extends BoardPinRef {
  instanceId: string
  /** 모듈 쪽 핀 ID */
  modulePinId: string
}

export function asModuleBoardLink(c: Connection): ModuleBoardLink | null {
  const [a, b] = [c.from, c.to]
  if (a.kind === 'module' && b.kind === 'board')
    return { instanceId: a.instanceId, modulePinId: a.pinId, boardInstanceId: b.boardInstanceId, pinId: b.pinId }
  if (b.kind === 'module' && a.kind === 'board')
    return { instanceId: b.instanceId, modulePinId: b.pinId, boardInstanceId: a.boardInstanceId, pinId: a.pinId }
  return null
}

/** 모듈 핀에 직접 연결된 보드 핀 (핀 배정). 연결이 없거나 다른 모듈에 연결되어 있으면 null */
export function boardPinFor(connections: Connection[], instanceId: string, pinId: string): BoardPinRef | null {
  for (const c of connections) {
    const link = asModuleBoardLink(c)
    if (link && link.instanceId === instanceId && link.modulePinId === pinId)
      return { boardInstanceId: link.boardInstanceId, pinId: link.pinId }
  }
  return null
}

export function isPinConnected(connections: Connection[], instanceId: string, pinId: string): boolean {
  const e = moduleEndpoint(instanceId, pinId)
  return connections.some((c) => touches(c, e))
}

/** 쓰고 있는 드라이버 채널. 연결이 하나도 없으면 첫 번째 채널을 쓴다고 본다 */
export function activeChannels(connections: Connection[], instanceId: string, module: Module): DriverChannel[] {
  const channels = module.driver?.channels ?? []
  const used = channels.filter((ch) => [...ch.outputs, ...ch.inputs].some((id) => isPinConnected(connections, instanceId, id)))
  return used.length ? used : channels.slice(0, 1)
}

/** 연결해야 하는 핀. 수동 핀·전원 출력 핀과 쓰지 않는 드라이버 채널의 핀은 빠진다 */
export function requiredPins(connections: Connection[], instanceId: string, module: Module): ModulePin[] {
  const active = activeChannels(connections, instanceId, module)
  const idle = new Set((module.driver?.channels ?? []).filter((ch) => !active.includes(ch)).flatMap((ch) => [...ch.outputs, ...ch.inputs]))
  return module.pins.filter((p) => p.role !== 'passive' && p.role !== 'source' && !idle.has(p.id))
}

/** 부품 안에서 다른 핀과 이어진 핀 (택트 스위치 1B, 레벨 시프터 채널 등) */
export function isInternalPin(module: Module, pinId: string): boolean {
  return [...(module.internalConnections ?? []), ...(module.passThrough ?? [])].some((pair) => pair.includes(pinId))
}

export interface ResolvedModulePin {
  placed: PlacedModule
  module: Module
  pin: ModulePin
}

export function resolveModulePin(placed: PlacedModule[], e: Endpoint): ResolvedModulePin | null {
  if (e.kind !== 'module') return null
  const item = placed.find((p) => p.instanceId === e.instanceId)
  const module = item && findModule(item.moduleId)
  const pin = module?.pins.find((p) => p.id === e.pinId)
  return item && module && pin ? { placed: item, module, pin } : null
}

export function describeEndpoint(e: Endpoint, circuit: Circuit): string {
  if (e.kind === 'board') return `${boardLabel(circuit, e.boardInstanceId)} ${e.pinId}`
  const r = resolveModulePin(circuit.placed, e)
  return r ? `${r.placed.label} · ${r.pin.name}` : `알 수 없는 핀 (${e.pinId})`
}

export function boardHasPin(board: Board, pinId: string): boolean {
  return board.pins.some((p) => p.id === pinId)
}
