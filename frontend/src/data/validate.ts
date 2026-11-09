import type {
  Board,
  BoardPinGroup,
  Module,
  ModuleCategory,
  ModulePinRole,
  MotorKind,
  PinCapability,
  PinRestrictionKind,
  PowerSupply,
  SpecConfidence,
  SupplyKind,
} from '../types'

// data/*.json 은 타입 검사 대상이 아니므로 앱 시작 시 구조를 검증한다.
// 잘못된 데이터는 화면 대신 콘솔/테스트에서 즉시 드러나도록 예외를 던진다.

const CAPABILITIES: readonly PinCapability[] = [
  'digital', 'analog', 'pwm', 'interrupt', 'i2c-sda', 'i2c-scl',
  'spi-mosi', 'spi-miso', 'spi-sck', 'spi-ss', 'uart-rx', 'uart-tx', 'dac', 'touch',
]
const PIN_GROUPS: readonly BoardPinGroup[] = ['digital', 'analog', 'power', 'control']
const RESTRICTIONS: readonly PinRestrictionKind[] = [
  'input-only', 'no-internal-pull', 'strapping', 'jtag', 'usb-serial', 'adc2-wifi', 'onboard-led', 'interrupt-caveat',
]
const DIRECTIONS = ['out', 'in', 'inout'] as const
const CONFIDENCES: readonly SpecConfidence[] = ['official', 'typical', 'varies']
const CATEGORIES: readonly ModuleCategory[] = ['output', 'input', 'sensor', 'motor', 'driver', 'power', 'actuator', 'display', 'comm', 'interface']
const CORES = ['arduino-avr', 'arduino-esp32'] as const
const ROLES: readonly ModulePinRole[] = ['power', 'ground', 'signal', 'passive', 'source', 'load', 'drive']
const MOTOR_KINDS: readonly MotorKind[] = ['dc', 'stepper-bipolar', 'stepper-unipolar', 'bldc']
const SUPPLY_KINDS: readonly SupplyKind[] = ['adapter', 'battery', 'usb']

class DataError extends Error {}

function fail(path: string, message: string): never {
  throw new DataError(`데이터 오류 (${path}): ${message}`)
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, '객체가 아닙니다')
  return v as Record<string, unknown>
}
function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, '배열이 아닙니다')
  return v
}
function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || v === '') fail(path, '비어 있지 않은 문자열이어야 합니다')
  return v
}
function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, '숫자여야 합니다')
  return v
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
  if (!allowed.includes(v as T)) fail(path, `허용되지 않은 값 ${JSON.stringify(v)}`)
  return v as T
}
function unique(ids: string[], path: string) {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) fail(path, `ID 중복: ${id}`)
    seen.add(id)
  }
}

function checkElectrical(v: unknown, path: string) {
  arr(v, path).forEach((e, i) => {
    const o = obj(e, `${path}[${i}]`)
    str(o.label, `${path}[${i}].label`)
    str(o.value, `${path}[${i}].value`)
    oneOf(o.confidence, CONFIDENCES, `${path}[${i}].confidence`)
  })
}

export function validateBoards(data: unknown): Board[] {
  const boards = arr(data, 'boards')
  boards.forEach((b, bi) => {
    const p = `boards[${bi}]`
    const o = obj(b, p)
    for (const key of ['id', 'name', 'microcontroller', 'clockSpeed', 'sourceUrl']) str(o[key], `${p}.${key}`)
    oneOf(o.core, CORES, `${p}.core`)
    for (const key of ['logicVoltage', 'ioPinCurrentLimitMa', 'totalCurrentLimitMa', 'digitalIoCount', 'analogInputCount', 'gpioInputHighMinVoltage'])
      num(o[key], `${p}.${key}`)
    const pins = arr(o.pins, `${p}.pins`).map((pin, i) => {
      const po = obj(pin, `${p}.pins[${i}]`)
      str(po.label, `${p}.pins[${i}].label`)
      oneOf(po.group, PIN_GROUPS, `${p}.pins[${i}].group`)
      const caps = arr(po.capabilities, `${p}.pins[${i}].capabilities`).map((c, ci) =>
        oneOf(c, CAPABILITIES, `${p}.pins[${i}].capabilities[${ci}]`),
      )
      if (po.gpio !== undefined) num(po.gpio, `${p}.pins[${i}].gpio`)
      if (po.restrictions !== undefined) {
        const kinds = arr(po.restrictions, `${p}.pins[${i}].restrictions`).map((r, ri) => {
          const ro = obj(r, `${p}.pins[${i}].restrictions[${ri}]`)
          str(ro.description, `${p}.pins[${i}].restrictions[${ri}].description`)
          return oneOf(ro.kind, RESTRICTIONS, `${p}.pins[${i}].restrictions[${ri}].kind`)
        })
        // 입력 전용 핀에 출력 기능이 적혀 있으면 데이터 모순
        if (kinds.includes('input-only') && caps.some((c) => c === 'pwm' || c === 'dac' || c.endsWith('-tx')))
          fail(`${p}.pins[${i}]`, '입력 전용 핀에 출력 기능이 지정되어 있습니다')
      }
      return str(po.id, `${p}.pins[${i}].id`)
    })
    unique(pins, `${p}.pins`)
    const pinSet = new Set(pins)
    const pinRef = (id: unknown, path: string) => {
      if (!pinSet.has(str(id, path))) fail(path, `존재하지 않는 핀 ${String(id)}`)
      return id as string
    }
    for (const key of ['pwmPins', 'interruptPins', 'servoPwmConflictPins'])
      arr(o[key], `${p}.${key}`).forEach((id, i) => {
        if (!pinSet.has(str(id, `${p}.${key}[${i}]`))) fail(`${p}.${key}[${i}]`, `존재하지 않는 핀 ${String(id)}`)
      })
    arr(o.buses, `${p}.buses`).forEach((bus, i) =>
      arr(obj(bus, `${p}.buses[${i}]`).pins, `${p}.buses[${i}].pins`).forEach((bp, j) => {
        const id = str(obj(bp, `${p}.buses[${i}].pins[${j}]`).pinId, `${p}.buses[${i}].pins[${j}].pinId`)
        if (!pinSet.has(id)) fail(`${p}.buses[${i}].pins[${j}]`, `존재하지 않는 핀 ${id}`)
      }),
    )
    if (o.gpioMaxInputVoltage !== undefined) num(o.gpioMaxInputVoltage, `${p}.gpioMaxInputVoltage`)
    if (o.powerInput !== undefined) {
      const pi = obj(o.powerInput, `${p}.powerInput`)
      pinRef(pi.pinId, `${p}.powerInput.pinId`)
      if (num(pi.minVoltage, `${p}.powerInput.minVoltage`) >= num(pi.maxVoltage, `${p}.powerInput.maxVoltage`))
        fail(`${p}.powerInput`, '전압 범위가 잘못되었습니다')
    }
    // 전원·GND 핀: 지정하지 않으면 5V/3.3V/GND 를 기본으로 사용한다 (engine/electrical.ts 와 동일 규칙)
    const supplies = o.supplyPins === undefined
      ? ['5V', '3.3V'].filter((id) => pinSet.has(id))
      : arr(o.supplyPins, `${p}.supplyPins`).map((sp, i) => {
          const so = obj(sp, `${p}.supplyPins[${i}]`)
          num(so.voltage, `${p}.supplyPins[${i}].voltage`)
          return pinRef(so.pinId, `${p}.supplyPins[${i}].pinId`)
        })
    const grounds = o.groundPins === undefined
      ? ['GND'].filter((id) => pinSet.has(id))
      : arr(o.groundPins, `${p}.groundPins`).map((id, i) => pinRef(id, `${p}.groundPins[${i}]`))
    if (supplies.length === 0 || grounds.length === 0) fail(`${p}.pins`, '전원 공급 핀과 GND 핀이 하나 이상 필요합니다')
    if (o.reservedPins !== undefined)
      arr(o.reservedPins, `${p}.reservedPins`).forEach((rp, i) => {
        const ro = obj(rp, `${p}.reservedPins[${i}]`)
        if (pinSet.has(str(ro.id, `${p}.reservedPins[${i}].id`))) fail(`${p}.reservedPins[${i}]`, '사용 가능한 핀 목록과 중복됩니다')
        str(ro.reason, `${p}.reservedPins[${i}].reason`)
      })
    if (o.headers !== undefined) {
      const placedOnHeader = arr(o.headers, `${p}.headers`).flatMap((h, i) => {
        const ho = obj(h, `${p}.headers[${i}]`)
        oneOf(ho.side, ['top', 'bottom'] as const, `${p}.headers[${i}].side`)
        return arr(ho.pinIds, `${p}.headers[${i}].pinIds`).map((id, j) => pinRef(id, `${p}.headers[${i}].pinIds[${j}]`))
      })
      unique(placedOnHeader, `${p}.headers`)
      const missing = pins.filter((id) => !placedOnHeader.includes(id))
      if (missing.length) fail(`${p}.headers`, `헤더에 없는 핀: ${missing.join(', ')}`)
    }
    checkElectrical(o.electrical, `${p}.electrical`)
    obj(o.footprint, `${p}.footprint`)
    arr(o.notes, `${p}.notes`)
  })
  unique(boards.map((b) => (b as Board).id), 'boards')
  return boards as Board[]
}

export function validateModules(data: unknown): Module[] {
  const modules = arr(data, 'modules')
  modules.forEach((m, mi) => {
    const p = `modules[${mi}]`
    const o = obj(m, p)
    for (const key of ['id', 'name', 'nameEn', 'icon', 'description']) str(o[key], `${p}.${key}`)
    oneOf(o.category, CATEGORIES, `${p}.category`)
    const pins = arr(o.pins, `${p}.pins`).map((pin, i) => {
      const po = obj(pin, `${p}.pins[${i}]`)
      str(po.name, `${p}.pins[${i}].name`)
      oneOf(po.role, ROLES, `${p}.pins[${i}].role`)
      if (po.direction !== undefined) oneOf(po.direction, DIRECTIONS, `${p}.pins[${i}].direction`)
      if (po.pull !== undefined) oneOf(po.pull, ['up'] as const, `${p}.pins[${i}].pull`)
      if (po.highLevel !== undefined && po.highLevel !== 'supply') {
        const hl = obj(po.highLevel, `${p}.pins[${i}].highLevel`)
        if (hl.powerPin === undefined) {
          str(hl.fromPin, `${p}.pins[${i}].highLevel.fromPin`)
          str(hl.ratioParam, `${p}.pins[${i}].highLevel.ratioParam`)
        } else str(hl.powerPin, `${p}.pins[${i}].highLevel.powerPin`)
      }
      for (const key of ['requires', 'prefers'] as const) {
        if (key === 'prefers' && po[key] === undefined) continue
        arr(po[key], `${p}.pins[${i}].${key}`).forEach((c, ci) =>
          oneOf(c, CAPABILITIES, `${p}.pins[${i}].${key}[${ci}]`),
        )
      }
      return str(po.id, `${p}.pins[${i}].id`)
    })
    if (pins.length === 0) fail(`${p}.pins`, '핀이 하나 이상 필요합니다')
    unique(pins, `${p}.pins`)
    // 핀 쌍·참조가 실제 핀을 가리키는지 확인
    const modPin = (id: unknown, path: string) => {
      if (!pins.includes(str(id, path))) fail(path, `존재하지 않는 핀 ${String(id)}`)
    }
    for (const key of ['internalConnections', 'passThrough'] as const)
      if (o[key] !== undefined)
        arr(o[key], `${p}.${key}`).forEach((pair, i) => {
          const pr = arr(pair, `${p}.${key}[${i}]`)
          if (pr.length !== 2) fail(`${p}.${key}[${i}]`, '핀 두 개의 쌍이어야 합니다')
          pr.forEach((id, j) => modPin(id, `${p}.${key}[${i}][${j}]`))
        })
    arr(o.pins, `${p}.pins`).forEach((pin, i) => {
      const hl = (pin as { highLevel?: unknown }).highLevel
      if (hl && typeof hl === 'object') {
        const h = hl as { powerPin?: unknown; fromPin?: unknown }
        modPin(h.powerPin ?? h.fromPin, `${p}.pins[${i}].highLevel`)
      }
    })
    const paramIds = new Set(o.parameters === undefined ? [] : arr(o.parameters, `${p}.parameters`).map((x) => (x as { id: string }).id))
    arr(o.pins, `${p}.pins`).forEach((pin, i) => {
      const po = pin as Record<string, unknown>
      if (po.minVoltage !== undefined && po.maxVoltage !== undefined && num(po.minVoltage, `${p}.pins[${i}].minVoltage`) > num(po.maxVoltage, `${p}.pins[${i}].maxVoltage`))
        fail(`${p}.pins[${i}]`, '전압 범위가 잘못되었습니다')
      if (po.role === 'source' && po.voltageParam === undefined && po.supplyVoltage === undefined)
        fail(`${p}.pins[${i}]`, '전원 출력 핀에는 출력 전압이 필요합니다')
      for (const key of ['voltageParam', 'currentParam', 'scaleParam'])
        if (po[key] !== undefined && !paramIds.has(str(po[key], `${p}.pins[${i}].${key}`)))
          fail(`${p}.pins[${i}].${key}`, `존재하지 않는 파라미터 ${String(po[key])}`)
    })
    if (o.motor !== undefined) {
      const mo = obj(o.motor, `${p}.motor`)
      oneOf(mo.kind, MOTOR_KINDS, `${p}.motor.kind`)
      for (const key of ['minVoltage', 'maxVoltage', 'nominalVoltage', 'typicalMa', 'peakMa']) num(mo[key], `${p}.motor.${key}`)
    }
    if (o.driver !== undefined) {
      const dr = obj(o.driver, `${p}.driver`)
      modPin(dr.supplyPin, `${p}.driver.supplyPin`)
      for (const key of ['dropVoltage', 'channelMa', 'channelPeakMa']) num(dr[key], `${p}.driver.${key}`)
      arr(dr.channels, `${p}.driver.channels`).forEach((ch, i) => {
        const co = obj(ch, `${p}.driver.channels[${i}]`)
        for (const key of ['outputs', 'inputs'])
          arr(co[key], `${p}.driver.channels[${i}].${key}`).forEach((id, j) => modPin(id, `${p}.driver.channels[${i}].${key}[${j}]`))
        arr(co.accepts, `${p}.driver.channels[${i}].accepts`).forEach((k, j) => oneOf(k, MOTOR_KINDS, `${p}.driver.channels[${i}].accepts[${j}]`))
      })
    }
    if (o.regulator !== undefined) {
      const re = obj(o.regulator, `${p}.regulator`)
      modPin(re.inputPin, `${p}.regulator.inputPin`)
      num(re.dropVoltage, `${p}.regulator.dropVoltage`)
    }
    if (o.code !== undefined) {
      const co = obj(o.code, `${p}.code`)
      str(co.template, `${p}.code.template`)
      if (co.pins !== undefined) Object.values(obj(co.pins, `${p}.code.pins`)).forEach((id, i) => modPin(id, `${p}.code.pins[${i}]`))
      if (co.standbyPin !== undefined) modPin(co.standbyPin, `${p}.code.standbyPin`)
    }
    if (o.libraryByCore !== undefined)
      Object.keys(obj(o.libraryByCore, `${p}.libraryByCore`)).forEach((k) => oneOf(k, CORES, `${p}.libraryByCore`))
    if (o.parameters !== undefined)
      arr(o.parameters, `${p}.parameters`).forEach((param, i) => {
        const po = obj(param, `${p}.parameters[${i}]`)
        str(po.id, `${p}.parameters[${i}].id`)
        const values = arr(po.options, `${p}.parameters[${i}].options`).map((opt, j) =>
          str(obj(opt, `${p}.parameters[${i}].options[${j}]`).value, `${p}.parameters[${i}].options[${j}].value`),
        )
        if (!values.includes(str(po.defaultValue, `${p}.parameters[${i}].defaultValue`)))
          fail(`${p}.parameters[${i}].defaultValue`, '옵션에 없는 기본값입니다')
      })
    checkElectrical(o.electrical, `${p}.electrical`)
    arr(o.tags, `${p}.tags`)
    arr(o.notes, `${p}.notes`)
  })
  unique(modules.map((m) => (m as Module).id), 'modules')
  return modules as Module[]
}

export function validateSupplies(data: unknown): PowerSupply[] {
  const supplies = arr(data, 'supplies')
  supplies.forEach((item, i) => {
    const p = `supplies[${i}]`
    const o = obj(item, p)
    for (const key of ['id', 'name', 'note']) str(o[key], `${p}.${key}`)
    oneOf(o.kind, SUPPLY_KINDS, `${p}.kind`)
    num(o.voltage, `${p}.voltage`)
    num(o.maxCurrentMa, `${p}.maxCurrentMa`)
    if (o.capacityMah !== undefined) num(o.capacityMah, `${p}.capacityMah`)
  })
  unique(supplies.map((s) => (s as PowerSupply).id), 'supplies')
  return supplies as PowerSupply[]
}
