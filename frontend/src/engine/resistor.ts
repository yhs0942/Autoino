import { getModule } from '../data/modules'
import { resolveBoardPin, type Circuit } from './circuit'
import { boardPinFor } from './connections'
import { boardPinVoltage, paramNumber } from './electrical'

// 직렬 저항 자동 선정 (LED 등)

const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2]

/** 주어진 값 이상인 가장 작은 E12 표준 저항값 (전류가 목표보다 커지지 않도록 올림) */
export function nextE12(ohms: number): number {
  if (!(ohms > 0)) return 10
  let decade = 10 ** Math.floor(Math.log10(ohms))
  for (;;) {
    for (const base of E12) {
      const value = Math.round(base * decade * 1000) / 1000
      if (value >= ohms - 1e-9) return value
    }
    decade *= 10
  }
}

export function formatOhms(ohms: number): string {
  if (ohms >= 1_000_000) return `${+(ohms / 1_000_000).toFixed(2)} MΩ`
  if (ohms >= 1000) return `${+(ohms / 1000).toFixed(2)} kΩ`
  return `${+ohms.toFixed(1)} Ω`
}

export interface ResistorChoice {
  supplyVoltage: number
  forwardVoltage: number
  targetMa: number
  calculatedOhms: number
  standardOhms: number
  actualMa: number
  powerMw: number
  /** 권장 정격 전력 (소비 전력의 2배 이상 여유) */
  ratingLabel: string
}

export function selectSeriesResistor(supplyVoltage: number, forwardVoltage: number, targetMa: number): ResistorChoice | null {
  const drop = supplyVoltage - forwardVoltage
  if (drop <= 0 || targetMa <= 0) return null
  const calculatedOhms = drop / (targetMa / 1000)
  const standardOhms = nextE12(calculatedOhms)
  const actualMa = (drop / standardOhms) * 1000
  const powerMw = drop * actualMa
  const ratingLabel = powerMw * 2 <= 250 ? '1/4 W' : powerMw * 2 <= 500 ? '1/2 W' : '1 W 이상'
  return { supplyVoltage, forwardVoltage, targetMa, calculatedOhms, standardOhms, actualMa, powerMw, ratingLabel }
}

export type SeriesResistorResult =
  | { status: 'ok'; instanceId: string; pinId: string; boardInstanceId: string; boardPinId: string; choice: ResistorChoice }
  | { status: 'unconnected'; instanceId: string; pinId: string }
  | {
      status: 'insufficient-voltage'
      instanceId: string
      pinId: string
      boardInstanceId: string
      boardPinId: string
      supplyVoltage: number
      forwardVoltage: number
    }
  | { status: 'unknown-voltage'; instanceId: string; pinId: string; boardInstanceId: string; boardPinId: string }

/** 직렬 저항이 필요한 모든 배치 부품의 저항을 계산한다. */
export function computeSeriesResistors(circuit: Circuit): SeriesResistorResult[] {
  const results: SeriesResistorResult[] = []
  for (const item of circuit.placed) {
    const module = getModule(item.moduleId)
    const spec = module.seriesResistor
    if (!spec) continue
    const base = { instanceId: item.instanceId, pinId: spec.pinId }
    const ref = boardPinFor(circuit.connections, item.instanceId, spec.pinId)
    const target = ref ? resolveBoardPin(circuit, ref.boardInstanceId, ref.pinId) : null
    if (!ref || !target?.pin) {
      results.push({ status: 'unconnected', ...base })
      continue
    }
    const at = { boardInstanceId: ref.boardInstanceId, boardPinId: ref.pinId }
    const supply = boardPinVoltage(target.board, target.pin)
    const vf = paramNumber(module, item, spec.forwardVoltageParam)
    const ma = paramNumber(module, item, spec.currentParam)
    if (supply === null || supply === 0 || vf === null || ma === null) {
      results.push({ status: 'unknown-voltage', ...base, ...at })
      continue
    }
    const choice = selectSeriesResistor(supply, vf, ma)
    results.push(
      choice
        ? { status: 'ok', ...base, ...at, choice }
        : { status: 'insufficient-voltage', ...base, ...at, supplyVoltage: supply, forwardVoltage: vf },
    )
  }
  return results
}
