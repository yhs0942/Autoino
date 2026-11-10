import { findModule } from '../data/modules'
import type { Endpoint, Module } from '../types'
import type { Circuit } from './circuit'
import { endpointKey } from './connections'

// 아날로그 멀티플렉서 (CD74HC4067 등)
//
// 아날로그 센서 출력은 전압이라 한 아날로그 핀에 바로 묶으면 서로 부딪친다. 멀티플렉서는 선택선(S0…)으로 고른
// 채널 하나만 공통 핀(SIG)에 잇기 때문에, 센서마다 채널을 하나씩 주고 SIG 를 아날로그 핀 하나에 연결하면
// 코드가 채널을 바꿔 가며 차례로 읽을 수 있다. 선택선은 쓰는 채널 수만큼만 보드 핀에 잇고 나머지는 GND 에 묶는다.

export interface MuxChannel {
  muxId: string
  channel: number
}

/** 끝점이 멀티플렉서의 채널 핀이면 그 채널 */
export function muxChannelPin(circuit: Circuit, e: Endpoint): MuxChannel | null {
  if (e.kind !== 'module') return null
  const item = circuit.placed.find((p) => p.instanceId === e.instanceId)
  const module = item && findModule(item.moduleId)
  const channel = module?.mux?.channels.indexOf(e.pinId) ?? -1
  return item && channel >= 0 ? { muxId: item.instanceId, channel } : null
}

/** 센서 핀(끝점 키)이 이어진 멀티플렉서 채널 */
export function muxChannelOf(circuit: Circuit, key: string): MuxChannel | null {
  for (const c of circuit.connections) {
    const ends = [c.from, c.to]
    const mine = ends.findIndex((e) => endpointKey(e) === key)
    if (mine < 0) continue
    const found = muxChannelPin(circuit, ends[1 - mine])
    if (found) return found
  }
  return null
}

/** 멀티플렉서에 이어진 센서 핀 (채널 순) */
export function muxUsers(circuit: Circuit, muxId: string): { channel: number; key: string }[] {
  const users: { channel: number; key: string }[] = []
  for (const c of circuit.connections)
    for (const [a, b] of [
      [c.from, c.to],
      [c.to, c.from],
    ]) {
      const ch = muxChannelPin(circuit, a)
      if (ch?.muxId === muxId && !muxChannelPin(circuit, b)) users.push({ channel: ch.channel, key: endpointKey(b) })
    }
  return users.sort((x, y) => x.channel - y.channel)
}

/** 채널 0…maxChannel 을 고르는 데 필요한 선택선 수 (최소 1) */
export function selectBitsFor(maxChannel: number): number {
  return Math.max(1, Math.ceil(Math.log2(maxChannel + 1)))
}

/** 쓰지 않을 때 GND 에 묶어도 되는 선택선인지 */
export function isMuxSelect(module: Module, pinId: string): boolean {
  return !!module.mux?.select.includes(pinId)
}
