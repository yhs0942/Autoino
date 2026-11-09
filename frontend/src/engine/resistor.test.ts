import { describe, expect, it } from 'vitest'
import { formatOhms, nextE12, selectSeriesResistor } from './resistor'

describe('nextE12', () => {
  it.each([
    [300, 330],
    [330, 330],
    [150, 150],
    [151, 180],
    [9.5, 10],
    [1000, 1000],
    [8300, 10000],
  ])('%d Ω → %d Ω', (input, expected) => {
    expect(nextE12(input)).toBeCloseTo(expected, 6)
  })
})

describe('selectSeriesResistor', () => {
  it('5 V, 빨강 LED(2.0 V), 10 mA → 300 Ω 계산, 330 Ω 선택', () => {
    const r = selectSeriesResistor(5, 2.0, 10)!
    expect(r.calculatedOhms).toBeCloseTo(300)
    expect(r.standardOhms).toBe(330)
    expect(r.actualMa).toBeCloseTo(9.09, 2)
    expect(r.actualMa).toBeLessThanOrEqual(10)
    expect(r.ratingLabel).toBe('1/4 W')
  })

  it('5 V, 파랑 LED(3.0 V), 20 mA → 100 Ω', () => {
    expect(selectSeriesResistor(5, 3.0, 20)!.standardOhms).toBe(100)
  })

  it('공급 전압이 Vf 이하이면 null', () => {
    expect(selectSeriesResistor(3.0, 3.0, 10)).toBeNull()
  })

  it('formatOhms', () => {
    expect(formatOhms(330)).toBe('330 Ω')
    expect(formatOhms(1200)).toBe('1.2 kΩ')
  })
})
