import { describe, expect, it } from 'vitest'
import { MODULES } from '../data/modules'
import { filterModules } from './moduleFilter'

const ids = (query: string, category: Parameters<typeof filterModules>[2] = 'all') =>
  filterModules(MODULES, query, category).map((m) => m.id)

describe('filterModules', () => {
  it('빈 검색어는 전체를 반환한다', () => {
    expect(ids('')).toHaveLength(MODULES.length)
  })

  it('한글·영문·태그로 검색한다', () => {
    expect(ids('초음파')).toEqual(['hc-sr04'])
    expect(ids('servo')).toEqual(['sg90', 'mg90s', 'mg996r', 'fs90r', 'pca9685']) // 서보 드라이버도 함께 찾는다
    expect(ids('HC SR04')).toContain('hc-sr04') // 전압 분배기 설명에도 HC-SR04 가 나온다
    expect(ids('l298')).toEqual(['l298n'])
    expect(ids('스테퍼')).toEqual(expect.arrayContaining(['stepper-nema17', 'stepper-28byj48', 'a4988']))
  })

  it('i2c 와 I²C 표기를 동일하게 취급한다', () => {
    expect(ids('i2c')).toContain('i2c-lcd-1602')
    expect(ids('I²C')).toContain('i2c-lcd-1602')
  })

  it('카테고리 필터와 검색어를 함께 적용한다', () => {
    expect(ids('', 'sensor')).toContain('hc-sr04')
    expect(ids('', 'motor')).toEqual(expect.arrayContaining(['sg90', 'dc-gear-tt', 'stepper-nema17', 'bldc-a2212']))
    expect(ids('', 'driver')).toEqual(expect.arrayContaining(['l298n', 'tb6612fng', 'a4988']))
    expect(ids('', 'power')).toEqual(['external-power', 'buck-lm2596', 'mb102-power'])
    expect(ids('led', 'display')).toEqual(['oled-ssd1306'])
    expect(ids('pwm', 'output')).toEqual(['led-5mm'])
  })
})
