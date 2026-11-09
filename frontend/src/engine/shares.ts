import { getModule } from '../data/modules'
import type { Board, BoardPin, Module, ModulePin, PinShare } from '../types'
import { resolveBoardPin, type Circuit } from './circuit'
import { asModuleBoardLink, parseEndpointKey, resolveModulePin } from './connections'
import { formatOhms } from './resistor'

// 핀 공유 그룹
//
// 사람이 부품 핀을 다른 부품 핀에 끌어 이으면, 두 핀이 같은 보드 핀을 함께 쓰는 그룹이 된다.
// - 출력끼리(LED·부저·릴레이 입력): 같이 켜지고 꺼진다
// - 버튼끼리, 디지털 핀: 어느 버튼을 눌러도 LOW 가 된다 (서로 구분할 수 없다)
// - 버튼끼리, AVR(Uno·Nano·Mega)의 아날로그 핀, 4개까지: 저항 사다리. 버튼마다 다른 직렬 저항을 넣고
//   INPUT_PULLUP(20–50 kΩ) 상태에서 analogRead 값으로 어느 버튼인지 구분한다.
//   (ESP32 는 analogRead 가 핀을 아날로그 모드로 바꾸며 내부 풀업을 끄므로 사다리로 쓰지 않는다)
// 그 밖의 신호(센서 출력, 통신선 등)는 한 핀을 같이 쓰면 서로 부딪치므로 묶지 않는다.

export type ShareRole = 'output' | 'button'
export type ShareKind = 'output' | 'input' | 'ladder'

/** 사다리 직렬 저항: 그룹의 첫 버튼은 저항 없이, 다음부터 차례로 */
export const LADDER_OHMS = [0, 4700, 22000, 100000]
/** AVR 내부 풀업 저항 범위 (데이터시트 20–50 kΩ) */
export const LADDER_PULLUP = { min: 20000, max: 50000 }

/** 핀 공유에 쓸 수 있는 부품 핀의 종류 */
export function shareRole(module: Module, pin: ModulePin): ShareRole | null {
  if (pin.role !== 'signal') return null
  const template = module.code?.template
  if (pin.direction === 'out' && (module.seriesResistor?.pinId === pin.id || template === 'digital-write')) return 'output'
  if (pin.direction === 'in' && pin.pull === 'up' && !template && !module.pins.some((p) => p.role === 'power')) return 'button'
  return null
}

export function roleOfKey(circuit: Circuit, key: string): ShareRole | null {
  const e = parseEndpointKey(key)
  const r = e?.kind === 'module' ? resolveModulePin(circuit.placed, e) : null
  return r ? shareRole(r.module, r.pin) : null
}

export function supportsLadder(board: Board, pin: BoardPin | undefined): boolean {
  return board.core === 'arduino-avr' && !!pin && pin.capabilities.includes('analog') && pin.capabilities.includes('digital')
}

/** 멤버(끝점 키)들의 공유 방식. 종류가 섞였으면 null */
export function shareKind(circuit: Circuit, members: string[], board?: Board, pin?: BoardPin): ShareKind | null {
  if (members.length < 2) return null
  const roles = members.map((k) => roleOfKey(circuit, k))
  if (roles.every((r) => r === 'output')) return 'output'
  if (roles.every((r) => r === 'button')) return board && supportsLadder(board, pin) && members.length <= LADDER_OHMS.length ? 'ladder' : 'input'
  return null
}

export function shareOf(circuit: Circuit, key: string): PinShare | undefined {
  return (circuit.shares ?? []).find((s) => s.members.includes(key))
}

/** 자동 배정이 같은 보드 핀을 함께 쓰게 하는 표식. 그룹 멤버가 아니거나 종류가 섞였으면 null */
export function shareToken(circuit: Circuit, key: string): string | null {
  const share = shareOf(circuit, key)
  if (!share) return null
  const roles = share.members.map((k) => roleOfKey(circuit, k))
  return roles.every((r) => r !== null && r === roles[0]) ? `share:${share.id}` : null
}

/** 그룹 멤버들이 연결된 보드 핀 (첫 멤버부터) */
export function shareBoardPin(circuit: Circuit, share: PinShare): { boardInstanceId: string; pinId: string } | null {
  for (const key of share.members) {
    const e = parseEndpointKey(key)
    if (e?.kind !== 'module') continue
    const link = circuit.connections.map(asModuleBoardLink).find((l) => l && l.instanceId === e.instanceId && l.modulePinId === e.pinId)
    if (link) return { boardInstanceId: link.boardInstanceId, pinId: link.pinId }
  }
  return null
}

export interface LadderResistor {
  instanceId: string
  pinId: string
  boardInstanceId: string
  boardPinId: string
  /** 0 이면 저항 없이 바로 */
  ohms: number
  /** 그룹 안 순서 (0부터) */
  index: number
}

/** 저항 사다리로 묶인 버튼마다의 직렬 저항 (같은 보드 핀에 연결된 멤버만, 그룹 순서대로) */
export function computeLadderResistors(circuit: Circuit): LadderResistor[] {
  const result: LadderResistor[] = []
  for (const share of circuit.shares ?? []) {
    const target = shareBoardPin(circuit, share)
    if (!target) continue
    const on = share.members.filter((key) => {
      const e = parseEndpointKey(key)
      return e?.kind === 'module' && circuit.connections.map(asModuleBoardLink).some((l) => l && l.instanceId === e.instanceId && l.modulePinId === e.pinId && l.boardInstanceId === target.boardInstanceId && l.pinId === target.pinId)
    })
    const rp = resolveBoardPin(circuit, target.boardInstanceId, target.pinId)
    if (!rp || shareKind(circuit, on, rp.board, rp.pin) !== 'ladder') continue
    on.forEach((key, index) => {
      const e = parseEndpointKey(key) as Extract<ReturnType<typeof parseEndpointKey>, { kind: 'module' }>
      result.push({ instanceId: e.instanceId, pinId: e.pinId, boardInstanceId: target.boardInstanceId, boardPinId: target.pinId, ohms: LADDER_OHMS[index], index })
    })
  }
  return result
}

/** 사다리 analogRead 경계 (0–1023): 버튼 i 를 누르면 값이 thresholds[i] 보다 작고 thresholds[i-1] 이상이다 */
export function ladderThresholds(n: number): number[] {
  const bands = LADDER_OHMS.slice(0, n).map((r) => [r / (LADDER_PULLUP.max + r), r / (LADDER_PULLUP.min + r)])
  return bands.map((band, i) => Math.round(((band[1] + (i + 1 < n ? bands[i + 1][0] : 1)) / 2) * 1023))
}

/** 사다리 저항 설명 (예: 버튼 1: 저항 없이, 버튼 2: 4.7 kΩ) */
export function ladderLabel(circuit: Circuit, ladder: LadderResistor[]): string {
  return ladder
    .map((r) => `${circuit.placed.find((p) => p.instanceId === r.instanceId)?.label ?? r.instanceId}: ${r.ohms ? formatOhms(r.ohms) : '저항 없이'}`)
    .join(', ')
}

export const describeRole = (role: ShareRole) => (role === 'output' ? '출력(LED·부저·릴레이)' : '버튼')

/** 두 핀을 묶을 수 없는 이유 (묶을 수 있으면 null) */
export function shareRefusal(circuit: Circuit, keys: string[]): string | null {
  const labels = keys.map((k) => {
    const e = parseEndpointKey(k)
    const r = e?.kind === 'module' ? resolveModulePin(circuit.placed, e) : null
    return r ? `${r.placed.label} · ${r.pin.name}` : k
  })
  const roles = keys.map((k) => roleOfKey(circuit, k))
  if (roles.every((r) => r !== null && r === roles[0])) return null
  return `${labels.join(', ')} 은(는) 한 핀을 함께 쓸 수 없습니다. 출력(LED·부저·릴레이)끼리 또는 버튼끼리만 묶을 수 있습니다.`
}

export function moduleOfKey(circuit: Circuit, key: string): Module | null {
  const e = parseEndpointKey(key)
  const item = e?.kind === 'module' ? circuit.placed.find((p) => p.instanceId === e.instanceId) : undefined
  return item ? getModule(item.moduleId) : null
}
