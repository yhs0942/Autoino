import modulesJson from '@data/modules.json'
import type { Module, ModuleCategory } from '../types'
import { validateModules } from './validate'

// 모듈 정의는 저장소 루트의 data/modules.json 에 있다.
// 전기적 사양은 제품·제조사마다 다를 수 있으므로 confidence 로 신뢰도를 구분한다.
//  - official: 데이터시트에 명시된 값
//  - typical : 일반적으로 알려진 대표값 (제품별 확인 필요)
//  - varies  : 제품마다 크게 달라 확정할 수 없음

export const CATEGORY_LABELS: Record<ModuleCategory, string> = {
  output: '출력',
  input: '입력',
  sensor: '센서',
  motor: '모터',
  driver: '모터 드라이버',
  power: '전원',
  actuator: '릴레이',
  display: '디스플레이',
  comm: '통신',
  interface: '신호 변환',
}

export const MODULES: Module[] = validateModules(modulesJson)

export function findModule(id: string): Module | undefined {
  return MODULES.find((m) => m.id === id)
}

export function getModule(id: string): Module {
  const module = findModule(id)
  if (!module) throw new Error(`알 수 없는 모듈 ID: ${id}`)
  return module
}
