import { getModule } from '../data/modules'
import { shareOf, shareToken } from './shares'
import type { Board, BoardPin, Connection, DriverChannel, Endpoint, Module, ModulePin, MotorKind, PinCapability, PlacedModule, RouteMode } from '../types'
import { boardDefOf, hostBoardOf, resolveBoardPin, type Circuit } from './circuit'
import {
  activeChannels,
  asModuleBoardLink,
  boardEndpoint,
  endpointKey,
  isBoardToBoard,
  isPinConnected,
  moduleEndpoint,
  resolveModulePin,
  sameEndpoint,
  parseEndpointKey,
} from './connections'
import {
  boardToBoardError,
  groundPinsOf,
  hasRestriction,
  isGpio,
  isUsbSerialPin,
  linkError,
  sourceVoltage,
  supplyPinForPin,
  usesServo,
} from './electrical'
import { BREADBOARD_CURRENT_LIMIT_MA, wirePeakMa } from './power'

// 자동 핀 배정 엔진
//
// 1) 기존 연결 중 오류가 있거나 다른 신호와 충돌하는 연결을 해제한다(재배치 대상).
// 2) 모터 단자를 같은 보드의 드라이버 빈 채널 출력에 연결한다.
// 3) 연결되지 않은 핀을 부품의 호스트 보드에 규칙에 따라 배정한다.
//    - 외부 전원이 필요한 전원 핀 → 전압이 맞는 외부 전원 (없으면 필수 핀은 실패, 권장 핀은 보드 전원)
//    - 전원 → 5V(또는 3.3V), GND → GND (외부 전원을 쓰는 부품의 GND 는 전원 − 로, 전원 − 는 보드 GND 로)
//    - I²C 신호 → 보드의 SDA/SCL (여러 장치가 버스를 공유)
//    - 그 밖의 신호 → 요구 기능(requires)을 만족하는 빈 GPIO 중 점수가 가장 낮은 핀
//      (입력 전용 핀에는 출력 신호를 두지 않고, 스트래핑·JTAG 핀 등은 뒤로 미룬다)
//    - 드라이버는 쓰는 채널의 제어 핀만 연결한다.
// 사용자가 직접 연결한 올바른 배선과 보드 간 통신 배선은 그대로 유지한다.
// 브레드보드 경로를 고르면 새 전선은 브레드보드를 거치되, 큰 전류가 흐르는 전선은 직결한다.

export interface AutoAssignResult {
  connections: Connection[]
  nextConnSeq: number
  added: Connection[]
  /** 오류·충돌로 해제된 연결 */
  removed: Connection[]
  /** 배정할 핀을 찾지 못한 모듈 핀 설명 */
  failed: string[]
}

/** 여러 장치가 같은 보드 핀을 공유할 수 있는 버스 신호 */
const SHARED_BUS: PinCapability[] = ['i2c-sda', 'i2c-scl', 'spi-mosi', 'spi-miso', 'spi-sck']

const SPECIAL_CAPS: PinCapability[] = [
  'pwm', 'interrupt', 'analog', 'dac', 'i2c-sda', 'i2c-scl', 'spi-mosi', 'spi-miso', 'spi-sck', 'spi-ss', 'uart-rx', 'uart-tx',
]

/** 이 신호가 공유 버스 신호이면 그 기능을 반환한다. */
export function sharedBusCapability(pin: ModulePin): PinCapability | null {
  return pin.requires.find((c) => SHARED_BUS.includes(c)) ?? null
}

/** 보드 간 연결에 쓰인 보드 핀이 공유 버스 신호이면 그 기능 (I²C 통신 연결의 SDA/SCL) */
function boardLinkBus(circuit: Circuit, c: Connection, pin: BoardPin): PinCapability | null {
  const link = c.linkId ? circuit.links.find((l) => l.id === c.linkId) : undefined
  if (link?.protocol !== 'I2C') return null
  return pin.capabilities.find((cap) => cap === 'i2c-sda' || cap === 'i2c-scl') ?? null
}

/**
 * 후보 핀 점수 (낮을수록 우선).
 * 희소한 기능(PWM, 인터럽트, 통신, 아날로그)을 가진 핀은 그 기능이 필요한 부품을 위해 아껴 둔다.
 */
function scorePin(board: Board, boardPin: BoardPin, pin: ModulePin, index: number, servo: boolean): number {
  let score = index
  const wanted = new Set([...pin.requires, ...(pin.prefers ?? [])])
  for (const cap of pin.prefers ?? []) {
    const blockedByServo = cap === 'pwm' && servo && board.servoPwmConflictPins.includes(boardPin.id)
    if (boardPin.capabilities.includes(cap) && !blockedByServo) score -= 500
  }
  for (const cap of boardPin.capabilities) {
    if (SPECIAL_CAPS.includes(cap) && !wanted.has(cap)) score += 40
    if ((cap === 'i2c-sda' || cap === 'i2c-scl') && !wanted.has(cap)) score += 200
  }
  if (boardPin.group === 'analog' && !wanted.has('analog')) score += 80
  if (isUsbSerialPin(board, boardPin)) score += 2000
  // 핀 제약 (ESP32 등). 데이터에 제약이 없는 보드(Arduino)는 영향 없음.
  if (hasRestriction(boardPin, 'strapping')) score += 1000
  if (hasRestriction(boardPin, 'jtag')) score += 40
  if (hasRestriction(boardPin, 'onboard-led')) score += 60
  if (hasRestriction(boardPin, 'no-internal-pull') && pin.pull === 'up') score += 1500
  return score
}

/** 신호 핀 처리 순서: 특수 기능이 필요한 핀 → 선호 기능이 있는 핀 → 일반 디지털 */
function signalPriority(pin: ModulePin): number {
  if (pin.requires.some((c) => c !== 'digital')) return 0
  if (pin.prefers?.length) return 1
  return 2
}

const usedKey = (boardInstanceId: string, pinId: string) => `${boardInstanceId}:${pinId}`

/** 기존 연결에서 사용 중인 GPIO (보드 인스턴스:핀 → 공유 버스 기능 또는 null) */
function usedGpioOf(circuit: Circuit, connections: Connection[]): Map<string, PinCapability | null> {
  const used = new Map<string, PinCapability | null>()
  for (const c of connections) {
    if (isBoardToBoard(c)) {
      for (const e of [c.from, c.to]) {
        if (e.kind !== 'board') continue
        const r = resolveBoardPin(circuit, e.boardInstanceId, e.pinId)
        if (r?.pin && isGpio(r.pin)) used.set(usedKey(e.boardInstanceId, e.pinId), boardLinkBus(circuit, c, r.pin))
      }
      continue
    }
    const link = asModuleBoardLink(c)
    if (!link) continue
    const r = resolveBoardPin(circuit, link.boardInstanceId, link.pinId)
    const m = resolveModulePin(circuit.placed, moduleEndpoint(link.instanceId, link.modulePinId))
    if (r?.pin && isGpio(r.pin)) used.set(usedKey(link.boardInstanceId, link.pinId), m ? sharedBusCapability(m.pin) : null)
  }
  return used
}

/** 일반 디지털 입출력 신호 (보드 간 SoftwareSerial·SPI SS 핀 선택용) */
const GENERIC_SIGNAL: ModulePin = { id: 'signal', name: '신호', role: 'signal', description: '', requires: ['digital'], direction: 'inout' }

/** 보드에서 비어 있는 GPIO 를 점수 순으로 count 개 고른다. 부족하면 가능한 만큼만 반환한다. */
export function pickFreeGpios(circuit: Circuit, boardInstanceId: string, count: number): string[] {
  const board = boardDefOf(circuit, boardInstanceId)
  if (!board) return []
  const used = usedGpioOf(circuit, circuit.connections)
  const servo = usesServo(circuit.placed, getModule)
  const fake: Module = { id: '_', name: '_', nameEn: '_', category: 'input', icon: '', description: '', pins: [], electrical: [], tags: [], notes: [] }
  return board.pins
    .filter(isGpio)
    .map((bp, index) => ({ bp, index }))
    .filter(({ bp }) => !used.has(usedKey(boardInstanceId, bp.id)) && linkError(board, fake, GENERIC_SIGNAL, bp) === null)
    .map(({ bp, index }) => ({ id: bp.id, score: scorePin(board, bp, GENERIC_SIGNAL, index, servo) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, count)
    .map((x) => x.id)
}

export interface AutoAssignOptions {
  /** 새 전선의 경로 */
  route?: RouteMode
  /** 주어지면 이 모듈 핀(끝점 키)만 배정하고 기존 전선은 그대로 둔다 */
  only?: Set<string>
}

interface SourceRef {
  item: PlacedModule
  module: Module
  pin: ModulePin
  voltage: number
}

function sourcesOf(circuit: Circuit): SourceRef[] {
  const sources: SourceRef[] = []
  for (const item of circuit.placed) {
    const module = getModule(item.moduleId)
    for (const pin of module.pins) {
      if (pin.role !== 'source') continue
      const voltage = sourceVoltage(module, item, pin)
      if (voltage !== null) sources.push({ item, module, pin, voltage })
    }
  }
  return sources
}

/** 외부 전원 핀에 쓸 전원: 허용 전압 안에서 요구 전압에 가장 가까운 것 */
function pickSource(sources: SourceRef[], item: PlacedModule, pin: ModulePin): SourceRef | undefined {
  const lo = pin.minVoltage ?? pin.supplyVoltage ?? 0
  const hi = pin.maxVoltage ?? pin.supplyVoltage ?? 0
  const wanted = pin.supplyVoltage ?? hi
  return sources
    .filter((s) => s.item.instanceId !== item.instanceId && s.voltage >= lo && s.voltage <= hi)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => Math.abs(a.s.voltage - wanted) - Math.abs(b.s.voltage - wanted) || a.i - b.i)[0]?.s
}

/** 전원 출력 핀과 짝이 되는 − 단자: 출력 핀 뒤의 첫 GND, 없으면 첫 GND */
function groundOfSource(source: SourceRef): Endpoint | null {
  const { module, item, pin } = source
  const after = module.pins.slice(module.pins.indexOf(pin))
  const ground = after.find((p) => p.role === 'ground') ?? module.pins.find((p) => p.role === 'ground')
  return ground ? moduleEndpoint(item.instanceId, ground.id) : null
}

/** 모터를 받을 수 있는 빈 드라이버 채널 */
function freeChannel(circuit: Circuit, connections: Connection[], motorItem: PlacedModule, kind: MotorKind, pinCount: number): { item: PlacedModule; channel: DriverChannel } | null {
  for (const item of circuit.placed) {
    const module = getModule(item.moduleId)
    if (!module.driver || item.hostBoardId !== motorItem.hostBoardId) continue
    for (const channel of module.driver.channels) {
      if (!channel.accepts.includes(kind) || channel.outputs.length !== pinCount) continue
      if (channel.outputs.every((id) => !isPinConnected(connections, item.instanceId, id))) return { item, channel }
    }
  }
  return null
}

export function autoAssign(circuit: Circuit, nextConnSeq: number, options: AutoAssignOptions = {}): AutoAssignResult {
  const route = options.route ?? 'direct'
  const inScope = (instanceId: string, pinId: string) => !options.only || options.only.has(endpointKey(moduleEndpoint(instanceId, pinId)))
  let removed: Connection[] = []
  let kept: Connection[] = []
  /** GPIO 보드 핀 → 사용 중인 신호 (공유 버스면 그 기능, 핀 공유 그룹이면 share:ID, 아니면 null) */
  const usedGpio = new Map<string, string | null>()
  const claim = (boardInstanceId: string, pinId: string, bus: string | null): boolean => {
    const key = usedKey(boardInstanceId, pinId)
    if (usedGpio.has(key) && !(bus && usedGpio.get(key) === bus)) return false
    usedGpio.set(key, bus)
    return true
  }

  // 1) 기존 연결 검사
  for (const c of circuit.connections) {
    const ends = [c.from, c.to]
    if (ends.some((e) => e.kind === 'module' && !resolveModulePin(circuit.placed, e))) {
      removed.push(c)
      continue
    }
    if (isBoardToBoard(c)) {
      const [a, b] = ends.map((e) => (e.kind === 'board' ? resolveBoardPin(circuit, e.boardInstanceId, e.pinId) : null))
      const sameBoard = a && b && a.instance.instanceId === b.instance.instanceId
      if (!a || !b || sameBoard || boardToBoardError(a.board, a.pin, b.board, b.pin)) {
        removed.push(c)
        continue
      }
      const ok = [a, b].every((r) => !(r.pin && isGpio(r.pin)) || claim(r.instance.instanceId, r.pin.id, boardLinkBus(circuit, c, r.pin)))
      if (ok) kept.push(c)
      else removed.push(c)
      continue
    }
    const link = asModuleBoardLink(c)
    if (!link) {
      kept.push(c) // 모듈 ↔ 모듈 연결은 유지
      continue
    }
    const r = resolveModulePin(circuit.placed, moduleEndpoint(link.instanceId, link.modulePinId))!
    const target = resolveBoardPin(circuit, link.boardInstanceId, link.pinId)
    if (!target || linkError(target.board, r.module, r.pin, target.pin, r.placed)) {
      removed.push(c)
      continue
    }
    const token = shareToken(circuit, endpointKey(moduleEndpoint(link.instanceId, link.modulePinId))) ?? sharedBusCapability(r.pin)
    if (target.pin && isGpio(target.pin) && !claim(link.boardInstanceId, target.pin.id, token)) {
      removed.push(c) // 충돌: 먼저 연결된 신호를 유지하고 나중 것을 재배치
      continue
    }
    kept.push(c)
  }

  // 범위를 정한 배정(예: 전원 예시 적용)은 기존 전선을 건드리지 않는다
  if (options.only) {
    kept = [...circuit.connections]
    removed = []
  }

  const result = [...kept]
  const added: Connection[] = []
  const failed: string[] = []
  let seq = nextConnSeq
  const connectEndpoints = (from: Endpoint, to: Endpoint) => {
    const c: Connection = { id: `w${seq++}`, from, to, auto: true }
    result.push(c)
    if (route === 'breadboard' && wirePeakMa({ ...circuit, connections: result }, from, to) < BREADBOARD_CURRENT_LIMIT_MA) c.via = 'breadboard'
    added.push(c)
  }
  const connect = (instanceId: string, pinId: string, boardInstanceId: string, boardPinId: string) =>
    connectEndpoints(moduleEndpoint(instanceId, pinId), boardEndpoint(boardInstanceId, boardPinId))

  // 2) 모터 → 드라이버 채널
  for (const item of circuit.placed) {
    const module = getModule(item.moduleId)
    if (!module.motor) continue
    const loads = module.pins.filter((p) => p.role === 'load')
    const open = loads.filter((p) => !isPinConnected(result, item.instanceId, p.id) && inScope(item.instanceId, p.id))
    if (!open.length) continue
    const free = freeChannel(circuit, result, item, module.motor.kind, loads.length)
    if (!free) {
      failed.push(`${item.label} (맞는 모터 드라이버 없음)`)
      continue
    }
    loads.forEach((p, i) => {
      if (!isPinConnected(result, item.instanceId, p.id)) connectEndpoints(moduleEndpoint(item.instanceId, p.id), moduleEndpoint(free.item.instanceId, free.channel.outputs[i]))
    })
  }

  // 3) 미연결 핀 배정
  const pending: { item: PlacedModule; module: Module; pin: ModulePin; order: number }[] = []
  circuit.placed.forEach((item, itemIndex) => {
    const module = getModule(item.moduleId)
    const active = activeChannels(result, item.instanceId, module)
    const idle = new Set((module.driver?.channels ?? []).filter((ch) => !active.includes(ch)).flatMap((ch) => [...ch.outputs, ...ch.inputs]))
    module.pins.forEach((pin, pinIndex) => {
      if (['passive', 'source', 'load', 'drive'].includes(pin.role) || idle.has(pin.id)) return
      if (isPinConnected(result, item.instanceId, pin.id) || !inScope(item.instanceId, pin.id)) return
      pending.push({ item, module, pin, order: itemIndex * 100 + pinIndex })
    })
  })

  // 전원 계획: 어떤 전원 핀을 어떤 외부 전원에 잇는지 먼저 정해야 GND 를 같은 전원으로 보낼 수 있다
  const sources = sourcesOf(circuit)
  const plan = new Map<string, SourceRef>()
  for (const { item, pin } of pending) {
    if (pin.role !== 'power' || !pin.external) continue
    const source = pickSource(sources, item, pin)
    if (source) plan.set(endpointKey(moduleEndpoint(item.instanceId, pin.id)), source)
  }
  /** 이 부품의 전원 핀이 쓰는 외부 전원 (계획 또는 기존 전선) */
  const sourceOfItem = (item: PlacedModule, module: Module): SourceRef | undefined => {
    for (const pin of module.pins.filter((p) => p.role === 'power')) {
      const e = moduleEndpoint(item.instanceId, pin.id)
      const planned = plan.get(endpointKey(e))
      if (planned) return planned
      for (const c of result) {
        const far = sameEndpoint(c.from, e) ? c.to : sameEndpoint(c.to, e) ? c.from : null
        const found = far && sources.find((s) => sameEndpoint(far, moduleEndpoint(s.item.instanceId, s.pin.id)))
        if (found) return found
      }
    }
    return undefined
  }
  const groundedOnSource = new Set<string>()

  const servo = usesServo(circuit.placed, getModule)
  const priority = (pin: ModulePin) => (pin.role === 'signal' ? signalPriority(pin) : 3)
  pending.sort((a, b) => priority(a.pin) - priority(b.pin) || a.order - b.order)

  for (const { item, module, pin } of pending) {
    const host = hostBoardOf(circuit, item)
    const board = host && boardDefOf(circuit, host.instanceId)
    if (!host || !board) {
      failed.push(`${item.label} · ${pin.name}`)
      continue
    }
    if (pin.role === 'power') {
      const source = plan.get(endpointKey(moduleEndpoint(item.instanceId, pin.id)))
      if (source) {
        connectEndpoints(moduleEndpoint(item.instanceId, pin.id), moduleEndpoint(source.item.instanceId, source.pin.id))
        continue
      }
      if (pin.external === 'required') {
        failed.push(`${item.label} · ${pin.name} (외부 전원 필요)`)
        continue
      }
      const target = supplyPinForPin(board, pin)
      if (target) connect(item.instanceId, pin.id, host.instanceId, target)
      else failed.push(`${item.label} · ${pin.name}`)
      continue
    }
    if (pin.role === 'ground') {
      // 외부 전원을 쓰는 부품의 전류는 보드를 거치지 않고 전원 − 로 돌아가야 한다
      const source = groundedOnSource.has(item.instanceId) ? undefined : sourceOfItem(item, module)
      const sourceGround = source && groundOfSource(source)
      if (sourceGround) {
        groundedOnSource.add(item.instanceId)
        connectEndpoints(moduleEndpoint(item.instanceId, pin.id), sourceGround)
        continue
      }
      const ground = groundPinsOf(board)[0]
      if (ground) connect(item.instanceId, pin.id, host.instanceId, ground)
      else failed.push(`${item.label} · ${pin.name}`)
      continue
    }
    // 핀 공유 그룹: 다른 멤버가 이미 보드 핀에 연결되어 있으면 같은 핀에 잇는다
    const shareKey = endpointKey(moduleEndpoint(item.instanceId, pin.id))
    const token = shareToken(circuit, shareKey)
    const share = token ? shareOf(circuit, shareKey) : undefined
    const mate = share
      ? share.members
          .filter((k) => k !== shareKey)
          .map((k) => parseEndpointKey(k))
          .map((e) => (e?.kind === 'module' ? result.map(asModuleBoardLink).find((l) => l && l.instanceId === e.instanceId && l.modulePinId === e.pinId) : null))
          .find((l) => l && l.boardInstanceId === host.instanceId)
      : null
    if (mate) {
      usedGpio.set(usedKey(host.instanceId, mate.pinId), token)
      connect(item.instanceId, pin.id, host.instanceId, mate.pinId)
      continue
    }
    const bus = token ?? sharedBusCapability(pin)
    const candidates = board.pins
      .filter(isGpio)
      .map((bp, index) => ({ bp, index }))
      .filter(({ bp }) => linkError(board, module, pin, bp) === null)
      .filter(({ bp }) => {
        const key = usedKey(host.instanceId, bp.id)
        return !usedGpio.has(key) || (bus !== null && usedGpio.get(key) === bus)
      })
      .map(({ bp, index }) => ({ bp, score: scorePin(board, bp, pin, index, servo) }))
      .sort((a, b) => a.score - b.score)
    const best = candidates[0]
    if (!best) {
      failed.push(`${item.label} · ${pin.name}`)
      continue
    }
    usedGpio.set(usedKey(host.instanceId, best.bp.id), bus)
    connect(item.instanceId, pin.id, host.instanceId, best.bp.id)
  }

  return { connections: result, nextConnSeq: seq, added, removed, failed }
}

