import { getModule } from '../data/modules'
import type { Connection, Endpoint, PlacedModule } from '../types'
import { breadboardRect, findFreePosition } from '../utils/placement'
import { boardDefOf, type Circuit } from './circuit'
import { boardEndpoint, endpointKey, moduleEndpoint, parseEndpointKey } from './connections'
import { groundPinsOf, supplyPinFor } from './electrical'
import { analyzeLevels, computeNetDrivers } from './levels'
import { buildNetlist } from './netlist'

// 레벨 변환 자동 추가
//
// 넷 단위 레벨 검사에서 "GPIO 최대 입력 전압 초과" 오류가 난 연결마다:
// - 부품의 입력 신호(direction 'in', 예: HC-SR04 Echo) → 전압 분배기를 넣는다.
// - 양방향·출력 신호(I²C 등) 또는 보드 ↔ 보드 신호 → 4채널 레벨 시프터의 채널을 하나 쓴다
//   (같은 부품/보드 쌍은 시프터 하나를 채널이 찰 때까지 함께 쓴다).
// 직접 연결이 아닌 경우(다른 부품을 거친 신호)는 자동으로 고치지 않고 보고만 한다.

export const DIVIDER_ID = 'voltage-divider'
export const SHIFTER_ID = 'level-shifter-4ch'
const SHIFTER_CHANNELS = 4

export interface LevelShiftCounters {
  nextSeq: number
  nextConnSeq: number
  labelCounters: Record<string, number>
}

export interface LevelShiftResult extends LevelShiftCounters {
  placed: PlacedModule[]
  connections: Connection[]
  /** 추가한 부품 표시 이름 */
  added: string[]
  /** 자동으로 고치지 못한 문제 */
  unresolved: string[]
}

export function insertLevelShifters(circuit: Circuit, counters: LevelShiftCounters): LevelShiftResult {
  let placed = [...circuit.placed]
  let connections = [...circuit.connections]
  let { nextSeq, nextConnSeq } = counters
  const labelCounters = { ...counters.labelCounters }
  const added: string[] = []
  const unresolved: string[] = []
  const netlist = buildNetlist(circuit)
  const drivers = computeNetDrivers(circuit, netlist)

  const addModule = (moduleId: string, hostBoardId: string, near: { x: number; y: number }): PlacedModule => {
    const module = getModule(moduleId)
    const labelNo = (labelCounters[module.id] ?? 0) + 1
    labelCounters[module.id] = labelNo
    const boards = circuit.boards.map((b) => {
      const def = boardDefOf(circuit, b.instanceId)
      return { x: b.x, y: b.y, width: def?.footprint.width ?? 0, height: def?.footprint.height ?? 0 }
    })
    const position = findFreePosition(placed, circuit.breadboard ? [...boards, breadboardRect(circuit.breadboard)] : boards, near)
    const item: PlacedModule = {
      instanceId: `${module.id}#${nextSeq++}`,
      moduleId: module.id,
      label: `${module.name} ${labelNo}`,
      x: position.x,
      y: position.y,
      params: Object.fromEntries((module.parameters ?? []).map((p) => [p.id, p.defaultValue])),
      hostBoardId,
    }
    placed = [...placed, item]
    added.push(item.label)
    return item
  }
  const wire = (from: Endpoint, to: Endpoint, linkId?: string, via?: Connection['via']) => {
    connections = [...connections, { id: `w${nextConnSeq++}`, from, to, auto: true, ...(linkId ? { linkId } : {}), ...(via ? { via } : {}) }]
  }
  /** 이 넷에 전원을 공급하는 보드 전원 핀 */
  const supplyEndpointOf = (key: string): Endpoint | null => {
    const d = (drivers.get(netlist.netOf(key)) ?? []).find((x) => x.source === 'supply')
    return d ? parseEndpointKey(d.key) : null
  }

  /** (보드 핀 쪽 보드, 높은 전압 쪽 식별자) → 사용 중인 시프터와 다음 채널 */
  const shifters = new Map<string, { item: PlacedModule; used: number }>()

  for (const f of analyzeLevels(circuit, netlist)) {
    if (f.severity !== 'error') continue
    const direct = connections.find(
      (c) =>
        (endpointKey(c.from) === f.key && endpointKey(c.to) === f.driver.key) ||
        (endpointKey(c.to) === f.key && endpointKey(c.from) === f.driver.key),
    )
    const lowBoard = boardDefOf(circuit, f.boardInstanceId)
    const lowGnd = lowBoard && groundPinsOf(lowBoard)[0]
    if (!direct || !lowBoard || !lowGnd) {
      unresolved.push(f.message)
      continue
    }
    const highEnd = parseEndpointKey(f.driver.key)!
    const lowEnd = boardEndpoint(f.boardInstanceId, f.pinId)
    const near = (() => {
      if (highEnd.kind === 'module') {
        const m = placed.find((p) => p.instanceId === highEnd.instanceId)
        if (m) return { x: m.x, y: m.y + 130 }
      }
      const b = circuit.boards.find((x) => x.instanceId === f.boardInstanceId)!
      return { x: b.x + (lowBoard.footprint.width ?? 0) + 40, y: b.y + (lowBoard.footprint.height ?? 0) + 40 }
    })()

    // 1) 부품의 입력 신호 → 전압 분배기
    if (f.driver.source === 'module-supply' && highEnd.kind === 'module') {
      const item = circuit.placed.find((p) => p.instanceId === highEnd.instanceId)!
      const pin = getModule(item.moduleId).pins.find((p) => p.id === highEnd.pinId)!
      if (pin.direction === 'in') {
        const dv = addModule(DIVIDER_ID, f.boardInstanceId, near)
        connections = connections.filter((c) => c !== direct)
        wire(highEnd, moduleEndpoint(dv.instanceId, 'in'), undefined, direct.via)
        wire(moduleEndpoint(dv.instanceId, 'out'), lowEnd, undefined, direct.via)
        wire(moduleEndpoint(dv.instanceId, 'gnd'), boardEndpoint(f.boardInstanceId, lowGnd), undefined, direct.via)
        continue
      }
    }

    // 2) 양방향·출력 신호, 보드 ↔ 보드 신호 → 레벨 시프터 채널
    const highSupply =
      highEnd.kind === 'module'
        ? (() => {
            const item = circuit.placed.find((p) => p.instanceId === highEnd.instanceId)!
            const power = getModule(item.moduleId).pins.find((p) => p.role === 'power')
            return power ? supplyEndpointOf(endpointKey(moduleEndpoint(item.instanceId, power.id))) : null
          })()
        : (() => {
            const hb = boardDefOf(circuit, highEnd.boardInstanceId)
            const pinId = hb && supplyPinFor(hb, hb.logicVoltage)
            return pinId ? boardEndpoint(highEnd.boardInstanceId, pinId) : null
          })()
    const lowSupplyPin = supplyPinFor(lowBoard, lowBoard.logicVoltage)
    if (!highSupply || !lowSupplyPin) {
      unresolved.push(f.message)
      continue
    }
    const groupKey = `${f.boardInstanceId}|${highEnd.kind === 'module' ? highEnd.instanceId : highEnd.boardInstanceId}`
    let shifter = shifters.get(groupKey)
    if (!shifter || shifter.used >= SHIFTER_CHANNELS) {
      const item = addModule(SHIFTER_ID, f.boardInstanceId, near)
      wire(moduleEndpoint(item.instanceId, 'hv'), highSupply, undefined, direct.via)
      wire(moduleEndpoint(item.instanceId, 'lv'), boardEndpoint(f.boardInstanceId, lowSupplyPin), undefined, direct.via)
      wire(moduleEndpoint(item.instanceId, 'gnd'), boardEndpoint(f.boardInstanceId, lowGnd), undefined, direct.via)
      shifter = { item, used: 0 }
      shifters.set(groupKey, shifter)
    }
    const channel = ++shifter.used
    connections = connections.filter((c) => c !== direct)
    wire(highEnd, moduleEndpoint(shifter.item.instanceId, `hv${channel}`), direct.linkId, direct.via)
    wire(moduleEndpoint(shifter.item.instanceId, `lv${channel}`), lowEnd, direct.linkId, direct.via)
  }

  return { placed, connections, nextSeq, nextConnSeq, labelCounters, added, unresolved }
}
