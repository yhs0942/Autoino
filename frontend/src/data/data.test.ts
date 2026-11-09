import { describe, expect, it } from 'vitest'
import { BOARDS, getBoard } from './boards'
import { validateBoards, validateModules } from './validate'
import { MODULES } from './modules'

describe('보드 데이터', () => {
  it.each([
    ['arduino-uno-r3', 14, 6, 6, 2],
    ['arduino-mega-2560', 54, 16, 15, 6],
    ['arduino-nano', 14, 8, 6, 2],
  ])('%s 사양이 공식 수치와 일치한다', (id, digital, analog, pwm, interrupts) => {
    const board = getBoard(id)
    expect(board.digitalIoCount).toBe(digital)
    expect(board.analogInputCount).toBe(analog)
    expect(board.pwmPins).toHaveLength(pwm)
    expect(board.interruptPins).toHaveLength(interrupts)
    // 요약 수치와 핀 목록이 서로 어긋나지 않는지 확인
    expect(board.pins.filter((p) => p.group === 'digital')).toHaveLength(digital)
    expect(board.pins.filter((p) => p.group === 'analog')).toHaveLength(analog)
  })

  it('버스에 사용된 핀이 모두 보드 핀 목록에 존재한다', () => {
    for (const board of BOARDS) {
      const ids = new Set(board.pins.map((p) => p.id))
      for (const bus of board.buses) for (const pin of bus.pins) expect(ids.has(pin.pinId)).toBe(true)
    }
  })

  it('Nano 의 A6, A7 은 디지털 기능이 없다', () => {
    const nano = getBoard('arduino-nano')
    expect(nano.pins.find((p) => p.id === 'A6')?.capabilities).not.toContain('digital')
    expect(nano.pins.find((p) => p.id === 'A5')?.capabilities).toContain('digital')
  })
})

describe('모듈 데이터', () => {
  it('모듈 ID 와 모듈 내 핀 ID 가 고유하다', () => {
    expect(new Set(MODULES.map((m) => m.id)).size).toBe(MODULES.length)
    for (const m of MODULES) expect(new Set(m.pins.map((p) => p.id)).size).toBe(m.pins.length)
  })

  it('필수 정보를 모두 가진다', () => {
    for (const m of MODULES) {
      expect(m.name).toBeTruthy()
      expect(m.icon).toMatch(/^icons\/.+\.svg$/)
      expect(m.description).toBeTruthy()
      expect(m.pins.length).toBeGreaterThan(0)
      expect(m.electrical.length).toBeGreaterThan(0)
    }
  })

  it('JSON 으로 직렬화 후에도 동일하다 (JSON 데이터베이스 분리 가능)', () => {
    expect(JSON.parse(JSON.stringify(MODULES))).toEqual(MODULES)
    expect(JSON.parse(JSON.stringify(BOARDS))).toEqual(BOARDS)
  })
})

describe('JSON 데이터 검증기', () => {
  it('잘못된 핀 기능을 거부한다', () => {
    const broken = JSON.parse(JSON.stringify(BOARDS))
    broken[0].pins[0].capabilities.push('teleport')
    expect(() => validateBoards(broken)).toThrow(/teleport/)
  })

  it('옵션에 없는 파라미터 기본값을 거부한다', () => {
    const broken = JSON.parse(JSON.stringify(MODULES))
    broken[0].parameters[0].defaultValue = 'purple'
    expect(() => validateModules(broken)).toThrow(/기본값/)
  })

  it('중복 ID 를 거부한다', () => {
    expect(() => validateModules([...MODULES, MODULES[0]])).toThrow(/중복/)
  })
})

describe('ESP32 DevKit V1 데이터', () => {
  const esp = getBoard('esp32-devkit-v1')
  const gpio = (n: number) => esp.pins.find((p) => p.gpio === n)
  const kinds = (n: number) => (gpio(n)?.restrictions ?? []).map((r) => r.kind)

  it('30핀 헤더에 GPIO 25개, 출력(PWM) 21개, ADC 15개', () => {
    expect(esp.pins).toHaveLength(30)
    expect(esp.digitalIoCount).toBe(25)
    expect(esp.pins.filter((p) => p.group === 'digital')).toHaveLength(25)
    expect(esp.pwmPins).toHaveLength(21)
    expect(esp.analogInputCount).toBe(15)
    expect(esp.headers!.flatMap((h) => h.pinIds)).toHaveLength(30)
    expect(esp.logicVoltage).toBe(3.3)
  })

  it('노출된 GPIO 번호가 DevKit V1 30핀 보드와 일치한다', () => {
    const numbers = esp.pins.map((p) => p.gpio).filter((n) => n !== undefined).sort((a, b) => a! - b!)
    expect(numbers).toEqual([1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39])
  })

  it('GPIO34–39 는 입력 전용: 출력 기능 없음, 내부 풀업 없음', () => {
    for (const n of [34, 35, 36, 39]) {
      expect(kinds(n)).toContain('input-only')
      expect(kinds(n)).toContain('no-internal-pull')
      expect(gpio(n)!.capabilities).not.toContain('pwm')
      expect(gpio(n)!.capabilities).toContain('analog')
    }
    expect(esp.pins.filter((p) => p.restrictions?.some((r) => r.kind === 'input-only')).map((p) => p.gpio).sort()).toEqual([34, 35, 36, 39])
  })

  it('플래시용 GPIO6–11 과 GPIO0 은 사용 가능한 핀이 아니라 예약 핀이다', () => {
    const reserved = esp.reservedPins!.map((r) => r.id)
    for (const n of [0, 6, 7, 8, 9, 10, 11]) {
      expect(gpio(n)).toBeUndefined()
      expect(reserved).toContain(`GPIO${n}`)
    }
  })

  it('스트래핑 핀 2, 5, 12, 15 와 내장 LED(GPIO2)', () => {
    for (const n of [2, 5, 12, 15]) expect(kinds(n)).toContain('strapping')
    expect(esp.pins.filter((p) => p.restrictions?.some((r) => r.kind === 'strapping'))).toHaveLength(4)
    expect(kinds(2)).toContain('onboard-led')
  })

  it('기본 통신 핀: I²C 21/22, VSPI 5/23/19/18, UART0 1/3, UART2 16/17', () => {
    const bus = (name: string) => Object.fromEntries(esp.buses.find((b) => b.name === name)!.pins.map((p) => [p.role, p.pinId]))
    expect(bus('Wire')).toEqual({ SDA: 'GPIO21', SCL: 'GPIO22' })
    expect(bus('SPI (VSPI)')).toEqual({ SS: 'GPIO5', MOSI: 'GPIO23', MISO: 'GPIO19', SCK: 'GPIO18' })
    expect(bus('Serial (UART0)')).toEqual({ RX: 'GPIO3', TX: 'GPIO1' })
    expect(bus('Serial2 (UART2)')).toEqual({ RX: 'GPIO16', TX: 'GPIO17' })
    expect(gpio(21)!.capabilities).toContain('i2c-sda')
    expect(gpio(25)!.capabilities).toContain('dac')
    expect(gpio(26)!.capabilities).toContain('dac')
  })

  it('ADC2 핀에는 Wi-Fi 제약이 있고 ADC1 핀에는 없다', () => {
    for (const n of [4, 2, 15, 13, 12, 14, 27, 25, 26]) expect(kinds(n)).toContain('adc2-wifi')
    for (const n of [32, 33, 34, 35, 36, 39]) expect(kinds(n)).not.toContain('adc2-wifi')
  })

  it('전원: 3V3(3.3 V), VIN(5 V), GND 2개', () => {
    expect(esp.supplyPins!.map((s) => [s.pinId, s.voltage])).toEqual([
      ['3V3', 3.3],
      ['VIN', 5],
    ])
    expect(esp.groundPins).toEqual(['GND', 'GND2'])
    expect(esp.gpioMaxInputVoltage).toBe(3.6)
  })
})

describe('보드 데이터 검증기 (ESP32 필드)', () => {
  it('입력 전용 핀에 PWM 을 지정하면 거부한다', () => {
    const broken = JSON.parse(JSON.stringify(BOARDS))
    broken[3].pins.find((p: { gpio?: number }) => p.gpio === 34).capabilities.push('pwm')
    expect(() => validateBoards(broken)).toThrow(/입력 전용/)
  })

  it('헤더에 빠진 핀이 있으면 거부한다', () => {
    const broken = JSON.parse(JSON.stringify(BOARDS))
    broken[3].headers[0].pinIds.pop()
    expect(() => validateBoards(broken)).toThrow(/헤더에 없는 핀/)
  })

  it('예약 핀이 사용 가능한 핀과 겹치면 거부한다', () => {
    const broken = JSON.parse(JSON.stringify(BOARDS))
    broken[3].reservedPins.push({ id: 'GPIO4', label: 'x', reason: 'x' })
    expect(() => validateBoards(broken)).toThrow(/중복/)
  })
})
