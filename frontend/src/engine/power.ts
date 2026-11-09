import { findModule } from '../data/modules'
import { SUPPLIES } from '../data/supplies'
import type { DriverChannel, Endpoint, Module, ModulePin, PlacedModule, PowerSupply } from '../types'
import { boardDefOf, boardLabel, resolveBoardPin, type Circuit } from './circuit'
import { endpointKey, isPinConnected, moduleEndpoint, parseEndpointKey, resolveModulePin } from './connections'
import { paramNumber, sourceLimitMa, sourceVoltage, supplyPinsOf } from './electrical'
import { buildNetlist, type Netlist } from './netlist'

// 전원 분석
//
// 1) 현재 전원 상태: 보드 전원 핀·외부 전원·레귤레이터 출력마다 그 넷에 달린 부하의 전류를 더한다.
//    - 드라이버 전원 핀에는 드라이버 채널에 연결된 모터 전류를 더한다.
//    - 레귤레이터 입력에는 출력 쪽 부하를 더한다 (입력 전류 = 출력 전류로 보수적으로 계산).
// 2) 필요한 외부 전원: 모터·드라이버·서보처럼 외부 전원이 필요한 부품을 전압 범위가 겹치는 것끼리 묶고,
//    권장 전압·전류와 그에 맞는 전원 예시(data/power-supplies.json)를 고른다.
//    - 최소 전류: 평상시 전류 합 × 1.25
//    - 권장 전류: 기동·스톨 전류 합 (모두 동시에 걸려도 전압이 무너지지 않는 값)
// 같은 규칙이 Python 백엔드(backend/autoino/engine/power.py)에도 구현되어 있다.

/** USB 전원(500 mA, 보드 보호 소자) 중 부품에 쓸 수 있다고 보는 대략적 상한 */
export const USB_5V_BUDGET_MA = 400
/** 브레드보드 접점이 안전하게 흘릴 수 있다고 보는 전류 */
export const BREADBOARD_CURRENT_LIMIT_MA = 1000
/** 보드가 VIN 에서 쓰는 대략적인 전류 */
const BOARD_VIN_MA = 100
const MIN_MARGIN = 1.25
const EXAMPLE_LIMIT = 4

export interface PowerLoad {
  key: string
  instanceId: string | null
  label: string
  pinName: string
  /** 전류를 모르면 null */
  typicalMa: number | null
  peakMa: number | null
  minVoltage: number | null
  maxVoltage: number | null
}

export type SourceKind = 'board' | 'external' | 'regulator'
export type SourceStatus = 'ok' | 'peak' | 'overload' | 'unused'

export interface PowerSource {
  key: string
  kind: SourceKind
  label: string
  voltage: number
  limitMa: number | null
  loads: PowerLoad[]
  typicalMa: number
  peakMa: number
  /** 소비 전류를 모르는 부하 */
  unknown: string[]
  status: SourceStatus
  /** 같은 넷에 함께 연결된 다른 전원 */
  parallel: string[]
}

export interface PowerConsumer {
  instanceId: string
  label: string
  typicalMa: number
  peakMa: number
}

export interface SupplyExample extends PowerSupply {
  /** recommended: 권장 전류 충족, minimum: 최소 전류만 충족 */
  level: 'recommended' | 'minimum'
  /** 배터리 예상 사용 시간(시간) */
  runtimeHours?: number
}

export interface PowerNeed {
  id: string
  consumers: PowerConsumer[]
  /** 외부 전원을 연결할 부품 전원 핀 끝점 키 */
  pins: string[]
  minVoltage: number
  maxVoltage: number
  targetVoltage: number
  typicalMa: number
  peakMa: number
  minimumMa: number
  recommendedMa: number
  /** 드라이버와 모터의 전압 범위가 겹치지 않으면 true */
  conflict: boolean
  /** 이미 연결된 전원 이름 */
  servedBy: string | null
  examples: SupplyExample[]
}

export interface PowerReport {
  sources: PowerSource[]
  needs: PowerNeed[]
}

const round1 = (v: number) => Math.round(v * 10) / 10
const ceil100 = (ma: number) => Math.ceil(ma / 100 - 1e-9) * 100

/** 전류 표시: 1000 mA 이상은 A 단위 */
export function formatCurrent(ma: number): string {
  return ma >= 1000 ? `${+(ma / 1000).toFixed(2)} A` : `${Math.round(ma)} mA`
}

function netMembers(netlist: Netlist, key: string): string[] {
  return netlist.members.get(netlist.netOf(key)) ?? []
}

function placedOf(circuit: Circuit, instanceId: string): { item: PlacedModule; module: Module } | null {
  const item = circuit.placed.find((p) => p.instanceId === instanceId)
  const module = item && findModule(item.moduleId)
  return item && module ? { item, module } : null
}

/** 드라이버 채널 출력에 연결된 모터 */
export function motorsOnChannel(circuit: Circuit, netlist: Netlist, item: PlacedModule, channel: DriverChannel): { item: PlacedModule; module: Module }[] {
  const found = new Map<string, { item: PlacedModule; module: Module }>()
  for (const output of channel.outputs)
    for (const k of netMembers(netlist, endpointKey(moduleEndpoint(item.instanceId, output)))) {
      const e = parseEndpointKey(k)
      const r = e && resolveModulePin(circuit.placed, e)
      if (r?.pin.role === 'load' && r.module.motor && r.placed.instanceId !== item.instanceId) found.set(r.placed.instanceId, { item: r.placed, module: r.module })
    }
  return [...found.values()]
}

function motorsOfDriver(circuit: Circuit, netlist: Netlist, item: PlacedModule, module: Module): { item: PlacedModule; module: Module }[] {
  const found = new Map<string, { item: PlacedModule; module: Module }>()
  for (const channel of module.driver?.channels ?? []) for (const m of motorsOnChannel(circuit, netlist, item, channel)) found.set(m.item.instanceId, m)
  return [...found.values()]
}

/** 부품 자체가 전원 핀에서 쓰는 전류 */
function ownCurrent(item: PlacedModule, module: Module, pin: ModulePin): [number | null, number | null] {
  const first = module.pins.find((p) => p.role === 'power')
  const typical = pin.typicalMa ?? (first?.id === pin.id ? module.typicalCurrentMa : undefined)
  if (typical === undefined) return [null, null]
  const scale = pin.scaleParam ? (paramNumber(module, item, pin.scaleParam) ?? 1) : 1
  return [typical * scale, (pin.peakMa ?? typical) * scale]
}

/** 부품 전원 핀 하나의 부하 (드라이버의 모터, 레귤레이터의 출력 부하 포함) */
export function loadOfPin(circuit: Circuit, netlist: Netlist, item: PlacedModule, module: Module, pin: ModulePin, seen: Set<string> = new Set()): PowerLoad {
  let [typical, peak] = ownCurrent(item, module, pin)
  const add = (t: number | null, p: number | null) => {
    if (t === null || p === null) return
    typical = (typical ?? 0) + t
    peak = (peak ?? 0) + p
  }
  if (module.driver?.supplyPin === pin.id) for (const m of motorsOfDriver(circuit, netlist, item, module)) add(m.module.motor!.typicalMa, m.module.motor!.peakMa)
  if (module.regulator?.inputPin === pin.id && !seen.has(item.instanceId)) {
    seen.add(item.instanceId)
    for (const out of module.pins.filter((p) => p.role === 'source'))
      for (const load of loadsOnNet(circuit, netlist, endpointKey(moduleEndpoint(item.instanceId, out.id)), seen)) add(load.typicalMa, load.peakMa)
  }
  return {
    key: endpointKey(moduleEndpoint(item.instanceId, pin.id)),
    instanceId: item.instanceId,
    label: item.label,
    pinName: pin.name,
    typicalMa: typical,
    peakMa: peak,
    minVoltage: pin.minVoltage ?? null,
    maxVoltage: pin.maxVoltage ?? null,
  }
}

/** 넷에 외부 전원·레귤레이터 출력이 있는지 */
function hasModuleSource(circuit: Circuit, netlist: Netlist, key: string): boolean {
  return netMembers(netlist, key).some((k) => {
    const e = parseEndpointKey(k)
    return e?.kind === 'module' && resolveModulePin(circuit.placed, e)?.pin.role === 'source'
  })
}

/** 이 끝점과 같은 넷에 달린 부하 */
function loadsOnNet(circuit: Circuit, netlist: Netlist, key: string, seen: Set<string> = new Set()): PowerLoad[] {
  const loads: PowerLoad[] = []
  for (const k of netMembers(netlist, key)) {
    const e = parseEndpointKey(k)
    if (e?.kind === 'module') {
      const r = resolveModulePin(circuit.placed, e)
      if (r?.pin.role === 'power') loads.push(loadOfPin(circuit, netlist, r.placed, r.module, r.pin, seen))
    } else if (e?.kind === 'board') {
      const r = resolveBoardPin(circuit, e.boardInstanceId, e.pinId)
      // 외부 전원이 보드 전원 입력(VIN)에 물려 있으면 보드도 그 전원의 부하다
      if (r?.board.powerInput?.pinId === e.pinId && hasModuleSource(circuit, netlist, k))
        loads.push({ key: k, instanceId: null, label: `${boardLabel(circuit, e.boardInstanceId)} VIN`, pinName: e.pinId, typicalMa: BOARD_VIN_MA, peakMa: BOARD_VIN_MA, minVoltage: null, maxVoltage: null })
    }
  }
  return loads
}

/** 핀을 지나는 최대 전류(mA). 모르면 0 */
function pinPeakMa(circuit: Circuit, netlist: Netlist, e: Endpoint): number {
  const r = resolveModulePin(circuit.placed, e)
  if (!r) return 0
  const { placed: item, module, pin } = r
  const key = endpointKey(e)
  switch (pin.role) {
    case 'load':
      return module.motor?.peakMa ?? 0
    case 'drive': {
      const channel = module.driver?.channels.find((ch) => ch.outputs.includes(pin.id))
      return channel ? motorsOnChannel(circuit, netlist, item, channel).reduce((sum, m) => sum + m.module.motor!.peakMa, 0) : 0
    }
    case 'power':
      return loadOfPin(circuit, netlist, item, module, pin).peakMa ?? 0
    case 'source':
      return loadsOnNet(circuit, netlist, key).reduce((sum, l) => sum + (l.peakMa ?? 0), 0)
    case 'ground':
      return module.pins
        .filter((p) => p.role === 'power' || p.role === 'source')
        .reduce((sum, p) => sum + pinPeakMa(circuit, netlist, moduleEndpoint(item.instanceId, p.id)), 0)
    default:
      return 0
  }
}

/** 이 전선으로 흐를 수 있는 최대 전류(mA) */
export function wirePeakMa(circuit: Circuit, from: Endpoint, to: Endpoint, netlist: Netlist = buildNetlist(circuit)): number {
  return Math.max(pinPeakMa(circuit, netlist, from), pinPeakMa(circuit, netlist, to))
}

/** 끝점이 속한 넷의 전원 전압. 전원이 없으면 null */
export function netVoltage(circuit: Circuit, netlist: Netlist, key: string): number | null {
  for (const k of netMembers(netlist, key)) {
    const e = parseEndpointKey(k)
    if (e?.kind === 'module') {
      const r = resolveModulePin(circuit.placed, e)
      if (r?.pin.role === 'source') {
        const v = sourceVoltage(r.module, r.placed, r.pin)
        if (v !== null) return v
      }
    } else if (e?.kind === 'board') {
      const def = boardDefOf(circuit, e.boardInstanceId)
      const sp = def && supplyPinsOf(def).find((s) => s.pinId === e.pinId)
      if (sp) return sp.voltage
    }
  }
  return null
}

function sumLoads(loads: PowerLoad[]) {
  return {
    typicalMa: loads.reduce((sum, l) => sum + (l.typicalMa ?? 0), 0),
    peakMa: loads.reduce((sum, l) => sum + (l.peakMa ?? 0), 0),
    unknown: loads.filter((l) => l.typicalMa === null).map((l) => l.label),
  }
}

function statusOf(loads: PowerLoad[], limitMa: number | null, typicalMa: number, peakMa: number): SourceStatus {
  if (!loads.length) return 'unused'
  if (limitMa === null) return 'ok'
  return typicalMa > limitMa ? 'overload' : peakMa > limitMa ? 'peak' : 'ok'
}

function collectSources(circuit: Circuit, netlist: Netlist): PowerSource[] {
  const sources: PowerSource[] = []
  const seen = new Map<string, PowerSource>()
  const push = (key: string, kind: SourceKind, label: string, voltage: number, limitMa: number | null) => {
    const net = netlist.netOf(key)
    const same = seen.get(net)
    if (same) {
      same.parallel.push(label)
      return
    }
    const loads = loadsOnNet(circuit, netlist, key)
    const totals = sumLoads(loads)
    const source: PowerSource = { key, kind, label, voltage, limitMa, loads, ...totals, status: statusOf(loads, limitMa, totals.typicalMa, totals.peakMa), parallel: [] }
    seen.set(net, source)
    sources.push(source)
  }
  for (const b of circuit.boards) {
    const def = boardDefOf(circuit, b.instanceId)
    if (!def) continue
    for (const sp of supplyPinsOf(def)) {
      const key = `board:${b.instanceId}:${sp.pinId}`
      if (!netlist.members.has(netlist.netOf(key))) continue
      // ESP32 VIN 처럼 입력으로도 쓰는 핀에 외부 전원이 물려 있으면 보드가 내보내는 전원이 아니다
      if (def.powerInput?.pinId === sp.pinId && hasModuleSource(circuit, netlist, key)) continue
      push(key, 'board', `${circuit.boards.length > 1 ? `${b.label} ` : '보드 '}${sp.pinId}`, sp.voltage, sp.voltage >= 4.5 ? USB_5V_BUDGET_MA : null)
    }
  }
  for (const item of circuit.placed) {
    const module = findModule(item.moduleId)
    if (!module) continue
    const pins = module.pins.filter((p) => p.role === 'source')
    for (const pin of pins) {
      const voltage = sourceVoltage(module, item, pin)
      if (voltage === null) continue
      const label = pins.length > 1 ? `${item.label} ${pin.name}` : item.label
      push(endpointKey(moduleEndpoint(item.instanceId, pin.id)), module.regulator ? 'regulator' : 'external', label, voltage, sourceLimitMa(module, item, pin))
    }
  }
  return sources
}

interface Demand {
  pins: string[]
  consumers: PowerConsumer[]
  minVoltage: number
  maxVoltage: number
  targetVoltage: number
  typicalMa: number
  peakMa: number
  conflict: boolean
  servedBy: string | null
}

/** 이 전원 핀을 먹여 살리는 외부 전원·레귤레이터 */
function sourceOnNet(sources: PowerSource[], netlist: Netlist, key: string): PowerSource | undefined {
  const net = netlist.netOf(key)
  return sources.find((s) => s.kind !== 'board' && netlist.netOf(s.key) === net)
}

function pinDemand(circuit: Circuit, netlist: Netlist, sources: PowerSource[], item: PlacedModule, module: Module, pin: ModulePin): Demand {
  const load = loadOfPin(circuit, netlist, item, module, pin)
  const typicalMa = load.typicalMa ?? 0
  const peakMa = load.peakMa ?? 0
  const consumers: PowerConsumer[] = [{ instanceId: item.instanceId, label: item.label, typicalMa, peakMa }]
  const lo = pin.minVoltage ?? pin.supplyVoltage ?? 0
  const hi = pin.maxVoltage ?? pin.supplyVoltage ?? 0
  return {
    pins: [load.key],
    consumers,
    minVoltage: lo,
    maxVoltage: hi,
    targetVoltage: pin.supplyVoltage ?? hi,
    typicalMa,
    peakMa,
    conflict: false,
    servedBy: sourceOnNet(sources, netlist, load.key)?.label ?? null,
  }
}

const isServoModule = (module: Module) => module.code?.template === 'servo' || module.code?.template === 'servo-continuous'

function collectDemands(circuit: Circuit, netlist: Netlist, sources: PowerSource[]): Demand[] {
  const demands: Demand[] = []
  const driven = new Set<string>()
  /** 서보 드라이버 수요에 이미 넣은 서보 전원 핀 */
  const covered = new Set<string>()
  for (const item of circuit.placed) {
    const module = findModule(item.moduleId)
    const driver = module?.driver
    if (!module || !driver) continue
    const pin = module.pins.find((p) => p.id === driver.supplyPin)!
    const demand = pinDemand(circuit, netlist, sources, item, module, pin)
    const motors = motorsOfDriver(circuit, netlist, item, module)
    if (motors.length) {
      const own = ownCurrent(item, module, pin)
      demand.consumers = [
        { instanceId: item.instanceId, label: item.label, typicalMa: own[0] ?? 0, peakMa: own[1] ?? 0 },
        ...motors.map((m) => ({ instanceId: m.item.instanceId, label: m.item.label, typicalMa: m.module.motor!.typicalMa, peakMa: m.module.motor!.peakMa })),
      ]
      const windowLo = Math.max(demand.minVoltage, ...motors.map((m) => m.module.motor!.minVoltage + driver.dropVoltage))
      const windowHi = Math.min(demand.maxVoltage, ...motors.map((m) => m.module.motor!.maxVoltage + driver.dropVoltage))
      demand.conflict = windowLo > windowHi
      if (!demand.conflict) {
        demand.minVoltage = round1(windowLo)
        demand.maxVoltage = round1(windowHi)
      }
      const target = Math.max(...motors.map((m) => m.module.motor!.nominalVoltage + driver.dropVoltage))
      demand.targetVoltage = round1(Math.min(demand.maxVoltage, Math.max(demand.minVoltage, target)))
      for (const m of motors) driven.add(m.item.instanceId)
    }
    // 서보 드라이버: V+ 에 함께 물린 서보 전원 핀의 전류와 전압 범위를 더한다
    if (driver.channels.some((ch) => ch.accepts.includes('servo'))) {
      for (const k of netMembers(netlist, endpointKey(moduleEndpoint(item.instanceId, pin.id)))) {
        const e = parseEndpointKey(k)
        const r = e?.kind === 'module' ? resolveModulePin(circuit.placed, e) : null
        if (!r || r.placed.instanceId === item.instanceId || r.pin.role !== 'power' || !isServoModule(r.module)) continue
        const load = loadOfPin(circuit, netlist, r.placed, r.module, r.pin)
        demand.consumers.push({ instanceId: r.placed.instanceId, label: r.placed.label, typicalMa: load.typicalMa ?? 0, peakMa: load.peakMa ?? 0 })
        demand.typicalMa += load.typicalMa ?? 0
        demand.peakMa += load.peakMa ?? 0
        if (r.pin.minVoltage !== undefined) demand.minVoltage = Math.max(demand.minVoltage, r.pin.minVoltage)
        if (r.pin.maxVoltage !== undefined) demand.maxVoltage = Math.min(demand.maxVoltage, r.pin.maxVoltage)
        covered.add(k)
      }
      demand.conflict = demand.minVoltage > demand.maxVoltage
      if (!demand.conflict) demand.targetVoltage = round1(Math.min(demand.maxVoltage, Math.max(demand.minVoltage, demand.targetVoltage)))
    }
    demands.push(demand)
  }
  for (const item of circuit.placed) {
    const module = findModule(item.moduleId)
    if (!module) continue
    if (module.motor && !driven.has(item.instanceId)) {
      const { motor } = module
      demands.push({
        pins: [],
        consumers: [{ instanceId: item.instanceId, label: item.label, typicalMa: motor.typicalMa, peakMa: motor.peakMa }],
        minVoltage: motor.minVoltage,
        maxVoltage: motor.maxVoltage,
        targetVoltage: motor.nominalVoltage,
        typicalMa: motor.typicalMa,
        peakMa: motor.peakMa,
        conflict: false,
        servedBy: null,
      })
    }
    if (module.driver) continue
    for (const pin of module.pins) {
      if (pin.role !== 'power' || !pin.external) continue
      const key = endpointKey(moduleEndpoint(item.instanceId, pin.id))
      if (covered.has(key)) continue
      // 레귤레이터 출력에 달린 부품은 레귤레이터 입력의 수요로 계산한다
      if (sourceOnNet(sources, netlist, key)?.kind === 'regulator') continue
      demands.push(pinDemand(circuit, netlist, sources, item, module, pin))
    }
  }
  return demands
}

function examplesFor(need: Pick<PowerNeed, 'minVoltage' | 'maxVoltage' | 'targetVoltage' | 'minimumMa' | 'recommendedMa' | 'typicalMa'>): SupplyExample[] {
  const levelOf = (s: PowerSupply): SupplyExample['level'] => (s.maxCurrentMa >= need.recommendedMa ? 'recommended' : 'minimum')
  return SUPPLIES.filter((s) => s.voltage >= need.minVoltage && s.voltage <= need.maxVoltage && s.maxCurrentMa >= need.minimumMa)
    .map((s) => ({ s, level: levelOf(s) }))
    .sort(
      (a, b) =>
        Number(a.level === 'minimum') - Number(b.level === 'minimum') ||
        Math.abs(a.s.voltage - need.targetVoltage) - Math.abs(b.s.voltage - need.targetVoltage) ||
        a.s.maxCurrentMa - b.s.maxCurrentMa ||
        (a.s.id < b.s.id ? -1 : 1),
    )
    .slice(0, EXAMPLE_LIMIT)
    .map(({ s, level }) => ({
      ...s,
      level,
      ...(s.capacityMah !== undefined && need.typicalMa > 0 ? { runtimeHours: round1(s.capacityMah / need.typicalMa) } : {}),
    }))
}

function mergeDemands(demands: Demand[]): PowerNeed[] {
  const buckets: Demand[] = []
  const sorted = [...demands].sort((a, b) => a.maxVoltage - b.maxVoltage || a.minVoltage - b.minVoltage)
  for (const d of sorted) {
    const bucket = buckets.find((b) => {
      if (b.servedBy !== d.servedBy) return false
      return Math.max(b.minVoltage, d.minVoltage) <= Math.min(b.maxVoltage, d.maxVoltage)
    })
    if (!bucket) {
      buckets.push({ ...d, pins: [...d.pins], consumers: [...d.consumers] })
      continue
    }
    bucket.minVoltage = Math.max(bucket.minVoltage, d.minVoltage)
    bucket.maxVoltage = Math.min(bucket.maxVoltage, d.maxVoltage)
    bucket.targetVoltage = Math.min(bucket.maxVoltage, Math.max(bucket.minVoltage, bucket.targetVoltage, d.targetVoltage))
    bucket.typicalMa += d.typicalMa
    bucket.peakMa += d.peakMa
    bucket.conflict = bucket.conflict || d.conflict
    bucket.pins.push(...d.pins)
    bucket.consumers.push(...d.consumers)
  }
  return buckets.map((b, i) => {
    const minimumMa = ceil100(b.typicalMa * MIN_MARGIN)
    const recommendedMa = Math.max(minimumMa, ceil100(b.peakMa))
    const need = { ...b, id: `need-${i + 1}`, minimumMa, recommendedMa }
    return { ...need, examples: examplesFor(need) }
  })
}

export function analyzePower(circuit: Circuit, netlist: Netlist = buildNetlist(circuit)): PowerReport {
  const sources = collectSources(circuit, netlist)
  return { sources, needs: mergeDemands(collectDemands(circuit, netlist, sources)) }
}

/** 전압이 같아 하나로 합칠 수 있는 외부 전원 묶음 */
export function findMergeableSupplies(circuit: Circuit): { voltage: number; items: PlacedModule[] }[] {
  const byVoltage = new Map<string, PlacedModule[]>()
  for (const item of circuit.placed) {
    if (item.moduleId !== 'external-power') continue
    const v = item.params.voltage
    byVoltage.set(v, [...(byVoltage.get(v) ?? []), item])
  }
  return [...byVoltage].filter(([, items]) => items.length > 1).map(([v, items]) => ({ voltage: Number(v), items }))
}

/** 전원 핀을 가진 부품의 첫 GND 핀 (전원 전류가 돌아가는 핀) */
export function primaryGrounds(pins: string[], placed: PlacedModule[]): string[] {
  const keys: string[] = []
  for (const key of pins) {
    const e = parseEndpointKey(key)
    const item = e?.kind === 'module' ? placed.find((p) => p.instanceId === e.instanceId) : undefined
    const ground = item && findModule(item.moduleId)?.pins.find((p) => p.role === 'ground')
    if (item && ground) keys.push(endpointKey(moduleEndpoint(item.instanceId, ground.id)))
  }
  return keys
}

/** 예시를 적용할 때 함께 연결할 끝점: 전원 핀, 그 부품의 미연결 GND */
export function supplyScope(circuit: Circuit, pins: string[]): Set<string> {
  const scope = new Set(pins)
  for (const key of pins) {
    const e = parseEndpointKey(key)
    if (e?.kind !== 'module') continue
    const found = placedOf(circuit, e.instanceId)
    for (const pin of found?.module.pins ?? [])
      if (pin.role === 'ground' && !isPinConnected(circuit.connections, e.instanceId, pin.id)) scope.add(endpointKey(moduleEndpoint(e.instanceId, pin.id)))
  }
  return scope
}
