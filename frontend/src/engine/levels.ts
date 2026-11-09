import { findModule } from '../data/modules'
import { boardLabel, resolveBoardPin, type Circuit } from './circuit'
import { asModuleBoardLink, endpointKey, moduleEndpoint, parseEndpointKey } from './connections'
import { gpioMaxInputVoltage, hasRestriction, isGpio, paramNumber, pinDisplayName, sourceVoltage, supplyPinOf } from './electrical'
import { buildNetlist, type Netlist } from './netlist'

// 넷 단위 전압 레벨 분석.
// 각 넷의 "HIGH 전압을 만드는 쪽(드라이버)"을 모은 뒤, 같은 넷에 있는 보드 GPIO 가
// 허용 입력 전압을 넘는지, 또는 HIGH 로 인식되기에 너무 낮은지 판단한다.

export type DriverSource = 'supply' | 'board-gpio' | 'module-supply' | 'module-derived'

export interface NetDriver {
  key: string
  voltage: number
  source: DriverSource
  label: string
  instanceId?: string
  boardInstanceId?: string
}

export interface LevelFinding {
  severity: 'error' | 'warning' | 'info'
  /** 문제가 생기는 보드 GPIO */
  boardInstanceId: string
  pinId: string
  key: string
  driver: NetDriver
  limit: number
  message: string
  hint?: string
}

const RECEIVING_ROLES = new Set(['RX'])

/** 보드 간 통신에서 수신 쪽(입력)으로만 쓰이는 보드 핀 키 */
function linkInputKeys(circuit: Circuit): Set<string> {
  const keys = new Set<string>()
  for (const link of circuit.links) {
    for (const end of [link.a, link.b]) {
      const controller = end === link.a
      for (const [role, pinId] of Object.entries(end.pins)) {
        const input =
          RECEIVING_ROLES.has(role) ||
          (link.protocol === 'SPI' && (controller ? role === 'MISO' : ['MOSI', 'SCK', 'SS'].includes(role)))
        if (input) keys.add(`board:${end.boardInstanceId}:${pinId}`)
      }
    }
  }
  return keys
}

export function computeNetDrivers(circuit: Circuit, netlist: Netlist): Map<string, NetDriver[]> {
  const drivers = new Map<string, NetDriver[]>()
  const push = (d: NetDriver) => {
    const net = netlist.netOf(d.key)
    drivers.set(net, [...(drivers.get(net) ?? []).filter((x) => x.key !== d.key), d])
  }
  const inputs = linkInputKeys(circuit)

  // 보드 GPIO 가 입력으로만 쓰이는지: 직접 연결된 모듈 핀이 모두 direction 'in' 이면 입력
  const moduleDirs = new Map<string, string[]>()
  for (const c of circuit.connections) {
    const l = asModuleBoardLink(c)
    if (!l) continue
    const item = circuit.placed.find((p) => p.instanceId === l.instanceId)
    const pin = item && findModule(item.moduleId)?.pins.find((p) => p.id === l.modulePinId)
    const key = `board:${l.boardInstanceId}:${l.pinId}`
    moduleDirs.set(key, [...(moduleDirs.get(key) ?? []), pin?.direction ?? (pin?.role === 'signal' ? 'inout' : 'none')])
  }

  // 1) 보드 핀: 전원 핀과 출력 가능한 GPIO
  for (const keys of netlist.members.values())
    for (const key of keys) {
      const e = parseEndpointKey(key)
      if (!e || e.kind !== 'board') continue
      const r = resolveBoardPin(circuit, e.boardInstanceId, e.pinId)
      if (!r?.pin) continue
      const supply = supplyPinOf(r.board, r.pin.id)
      const name = `${boardLabel(circuit, e.boardInstanceId)} ${pinDisplayName(r.pin)}`
      if (supply) push({ key, voltage: supply.voltage, source: 'supply', label: name, boardInstanceId: e.boardInstanceId })
      else if (isGpio(r.pin) && !hasRestriction(r.pin, 'input-only') && !inputs.has(key)) {
        const dirs = moduleDirs.get(key)
        if (dirs && dirs.length > 0 && dirs.every((d) => d === 'in')) continue
        push({ key, voltage: r.board.logicVoltage, source: 'board-gpio', label: name, boardInstanceId: e.boardInstanceId })
      }
    }

  // 외부 전원·레귤레이터 출력도 넷의 전원이다
  for (const item of circuit.placed) {
    const module = findModule(item.moduleId)
    for (const pin of module?.pins ?? []) {
      if (pin.role !== 'source') continue
      const voltage = sourceVoltage(module!, item, pin)
      if (voltage !== null) push({ key: endpointKey(moduleEndpoint(item.instanceId, pin.id)), voltage, source: 'supply', label: `${item.label} · ${pin.name}`, instanceId: item.instanceId })
    }
  }

  const supplyVoltageOfNet = (key: string): number | undefined => {
    const ds = (drivers.get(netlist.netOf(key)) ?? []).filter((d) => d.source === 'supply')
    return ds.length ? Math.max(...ds.map((d) => d.voltage)) : undefined
  }

  // 2) 부품 핀: 전원 전압을 따르는 신호
  const derived: { key: string; fromKey: string; ratio: number; label: string; instanceId: string }[] = []
  for (const item of circuit.placed) {
    const module = findModule(item.moduleId)
    if (!module) continue
    for (const pin of module.pins) {
      if (!pin.highLevel) continue
      const key = endpointKey(moduleEndpoint(item.instanceId, pin.id))
      const label = `${item.label} · ${pin.name}`
      if (pin.highLevel === 'supply' || 'powerPin' in pin.highLevel) {
        const powerPinId =
          pin.highLevel === 'supply' ? module.pins.find((p) => p.role === 'power')?.id : pin.highLevel.powerPin
        if (!powerPinId) continue
        const v = supplyVoltageOfNet(endpointKey(moduleEndpoint(item.instanceId, powerPinId)))
        if (v !== undefined) push({ key, voltage: v, source: 'module-supply', label, instanceId: item.instanceId })
      } else {
        const ratio = paramNumber(module, item, pin.highLevel.ratioParam)
        if (ratio === null) continue
        derived.push({ key, fromKey: endpointKey(moduleEndpoint(item.instanceId, pin.highLevel.fromPin)), ratio, label, instanceId: item.instanceId })
      }
    }
  }

  // 3) 비율로 정해지는 신호 (분배기 OUT 등). 연쇄될 수 있으므로 몇 번 반복한다.
  for (let pass = 0; pass < 4; pass++)
    for (const d of derived) {
      const src = (drivers.get(netlist.netOf(d.fromKey)) ?? []).filter((x) => x.key !== d.key)
      if (!src.length) continue
      const v = Math.max(...src.map((x) => x.voltage)) * d.ratio
      push({ key: d.key, voltage: Math.round(v * 1000) / 1000, source: 'module-derived', label: d.label, instanceId: d.instanceId })
    }

  return drivers
}

function fmtV(v: number): string {
  return Number.isInteger(v * 10) ? String(v) : v.toFixed(2)
}

export function analyzeLevels(circuit: Circuit, netlist: Netlist = buildNetlist(circuit)): LevelFinding[] {
  const drivers = computeNetDrivers(circuit, netlist)
  const findings: LevelFinding[] = []
  for (const keys of netlist.members.values())
    for (const key of keys) {
      const e = parseEndpointKey(key)
      if (!e || e.kind !== 'board') continue
      const r = resolveBoardPin(circuit, e.boardInstanceId, e.pinId)
      if (!r?.pin || !isGpio(r.pin)) continue
      const others = (drivers.get(netlist.netOf(key)) ?? []).filter((d) => d.key !== key)
      if (!others.length) continue
      const top = others.reduce((a, b) => (b.voltage > a.voltage ? b : a))
      const max = gpioMaxInputVoltage(r.board)
      const target = `${boardLabel(circuit, e.boardInstanceId)} ${pinDisplayName(r.pin)}`
      const base = { boardInstanceId: e.boardInstanceId, pinId: e.pinId, key, driver: top }
      if (top.voltage > max + 0.01) {
        const why =
          top.source === 'module-supply'
            ? `부품을 ${fmtV(top.voltage)} V 로 구동하면 이 신호가 ${fmtV(top.voltage)} V 가 되어`
            : top.source === 'board-gpio'
              ? `HIGH 출력(${fmtV(top.voltage)} V)이`
              : `이 신호가 약 ${fmtV(top.voltage)} V 가 되어`
        findings.push({
          ...base,
          severity: 'error',
          limit: max,
          message: `${top.label} → ${target}: ${why} ${r.board.name} GPIO 최대 입력 전압(${max} V)을 넘습니다.`,
          hint: '[레벨 변환 자동 추가]로 전압 분배기(입력 신호)나 레벨 시프터(양방향·출력 신호)를 넣거나, 3.3 V 로 동작하는 제품을 사용하세요.',
        })
        continue
      }
      // 낮은 전압 장치가 보내는 HIGH 를 높은 전압 보드가 제대로 읽는지 (부품·다른 보드가 보내는 신호만)
      if (top.source === 'supply') continue
      const vih = r.board.gpioInputHighMinVoltage
      if (top.voltage < vih)
        findings.push({
          ...base,
          severity: 'warning',
          limit: vih,
          message: `${top.label} → ${target}: HIGH 신호(${fmtV(top.voltage)} V)가 ${r.board.name} 의 HIGH 인식 최소 전압(${vih} V)보다 낮아 읽히지 않을 수 있습니다.`,
          hint: '레벨 시프터로 신호 전압을 올리세요.',
        })
      else if (top.voltage < vih + 0.5)
        findings.push({
          ...base,
          severity: 'info',
          limit: vih,
          message: `${top.label} → ${target}: HIGH 신호(${fmtV(top.voltage)} V)가 ${r.board.name} 의 HIGH 인식 최소 전압(${vih} V)에 가까워 여유가 작습니다.`,
        })
    }
  return findings
}
