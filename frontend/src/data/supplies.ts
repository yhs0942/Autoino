import suppliesJson from '@data/power-supplies.json'
import type { PowerSupply, SupplyKind } from '../types'
import { validateSupplies } from './validate'

// 외부 전원 예시는 저장소 루트의 data/power-supplies.json 에 있다.
// 전압·전류는 일반적인 제품의 대표값이며 실제 제품 라벨로 확인해야 한다.

export const SUPPLY_KIND_LABELS: Record<SupplyKind, string> = {
  adapter: '어댑터',
  battery: '배터리',
  usb: 'USB',
}

export const SUPPLIES: PowerSupply[] = validateSupplies(suppliesJson)

export function findSupply(id: string): PowerSupply | undefined {
  return SUPPLIES.find((s) => s.id === id)
}
