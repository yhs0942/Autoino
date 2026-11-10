import { getModule } from '../data/modules'
import { findSupply, SUPPLIES } from '../data/supplies'
import type { Module, PlacedModule, PowerSupply } from '../types'
import type { Circuit } from './circuit'
import { endpointKey, moduleEndpoint } from './connections'
import { sourceLimitMa, sourceVoltage } from './electrical'
import type { PowerLoad, PowerReport, PowerSource } from './power'

// 외부 전원의 정확한 종류. 외부 전원 부품의 [전원 종류] 파라미터(supply)에 전원 예시 ID 를 기록한다.
// 'custom' 은 전압·전류만 직접 정한 전원이다.

export const SUPPLY_PARAM = 'supply'
export const CUSTOM_SUPPLY = 'custom'

export const hasSupplyKind = (module: Module) => !!module.parameters?.some((p) => p.id === SUPPLY_PARAM)

/** 기록된 전원 예시 (직접 설정이면 null) */
export function supplyOf(item: PlacedModule): PowerSupply | null {
  return findSupply(item.params[SUPPLY_PARAM] ?? CUSTOM_SUPPLY) ?? null
}

/** 그 전압에서 이 전류 이상을 낼 수 있는 전원 예시 (전류가 작은 순) */
export function matchingSupplies(voltage: number | null, currentMa: number | null): PowerSupply[] {
  if (voltage === null) return []
  return SUPPLIES.filter((s) => s.voltage === voltage && s.maxCurrentMa >= (currentMa ?? 0)).sort((a, b) => a.maxCurrentMa - b.maxCurrentMa)
}

/** 파라미터 선택지 중 이 수치의 값 */
const optionValue = (module: Module, paramId: string, wanted: number) => module.parameters?.find((p) => p.id === paramId)?.options.find((o) => o.number === wanted)?.value

/** 전원 예시에 맞춘 파라미터 (전압·전류를 그 제품의 대표값으로) */
export function paramsForSupply(module: Module, params: Record<string, string>, supply: PowerSupply): Record<string, string> {
  return {
    ...params,
    [SUPPLY_PARAM]: supply.id,
    voltage: optionValue(module, 'voltage', supply.voltage) ?? params.voltage,
    current: optionValue(module, 'current', supply.maxCurrentMa) ?? params.current,
  }
}

/** 전압·전류가 기록된 제품과 달라졌으면 직접 설정으로 바꾼다 */
export function syncSupplyKind(module: Module, params: Record<string, string>): Record<string, string> {
  if (!hasSupplyKind(module)) return params
  const supply = findSupply(params[SUPPLY_PARAM] ?? CUSTOM_SUPPLY)
  if (!supply) return params[SUPPLY_PARAM] === CUSTOM_SUPPLY ? params : { ...params, [SUPPLY_PARAM]: CUSTOM_SUPPLY }
  const same = optionValue(module, 'voltage', supply.voltage) === params.voltage && optionValue(module, 'current', supply.maxCurrentMa) === params.current
  return same ? params : { ...params, [SUPPLY_PARAM]: CUSTOM_SUPPLY }
}

export interface PlacedSupplyInfo {
  instanceId: string
  label: string
  /** 기록된 전원 예시 (직접 설정이면 null) */
  supply: PowerSupply | null
  voltage: number | null
  limitMa: number | null
  /** 전원 분석 결과 (+ 출력이 아무 데도 연결되지 않았으면 없음) */
  source?: PowerSource
  /** 이 전원에서 전기를 받는 부품 */
  loads: PowerLoad[]
  /** 배터리면 지금 쓰는 전류로 계산한 예상 사용 시간(시간) */
  runtimeHours?: number
  /** 직접 설정한 전원이면 같은 전압·충분한 전류의 제품 예 */
  matches: PowerSupply[]
}

const round1 = (n: number) => Math.round(n * 10) / 10

/** 회로에 놓인 외부 전원마다 종류·사양·쓰는 부품을 모은다 */
export function placedSupplies(circuit: Circuit, report: PowerReport): PlacedSupplyInfo[] {
  const out: PlacedSupplyInfo[] = []
  for (const item of circuit.placed) {
    const module = getModule(item.moduleId)
    if (!hasSupplyKind(module)) continue
    const pin = module.pins.find((p) => p.role === 'source')
    if (!pin) continue
    const voltage = sourceVoltage(module, item, pin)
    const limitMa = sourceLimitMa(module, item, pin)
    const source = report.sources.find((s) => s.key === endpointKey(moduleEndpoint(item.instanceId, pin.id)))
    const supply = supplyOf(item)
    const typical = source?.typicalMa ?? 0
    out.push({
      instanceId: item.instanceId,
      label: item.label,
      supply,
      voltage,
      limitMa,
      source,
      loads: (source?.loads ?? []).filter((l) => l.instanceId !== item.instanceId),
      ...(supply?.capacityMah !== undefined && typical > 0 ? { runtimeHours: round1(supply.capacityMah / typical) } : {}),
      matches: supply ? [] : matchingSupplies(voltage, limitMa),
    })
  }
  return out
}
