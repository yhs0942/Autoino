import { CAPABILITY_LABELS } from '../data/labels'
import type { Board, BoardPin, Module, ModulePin, PinRestrictionKind, PlacedModule, SupplyPin } from '../types'

// 전기적 규칙. 자동 핀 배정과 검증이 같은 규칙을 사용한다.

/** 보드 데이터에 전원 핀 정의가 없을 때의 기본값 (Arduino Uno/Mega/Nano) */
const DEFAULT_SUPPLY_PINS: SupplyPin[] = [
  { pinId: '5V', voltage: 5 },
  { pinId: '3.3V', voltage: 3.3 },
]
const DEFAULT_GROUND_PINS = ['GND']

export function findBoardPin(board: Board, pinId: string): BoardPin | undefined {
  return board.pins.find((p) => p.id === pinId)
}

export function supplyPinsOf(board: Board): SupplyPin[] {
  return (board.supplyPins ?? DEFAULT_SUPPLY_PINS).filter((sp) => findBoardPin(board, sp.pinId))
}

export function groundPinsOf(board: Board): string[] {
  return (board.groundPins ?? DEFAULT_GROUND_PINS).filter((id) => findBoardPin(board, id))
}

export function supplyPinOf(board: Board, pinId: string): SupplyPin | undefined {
  return supplyPinsOf(board).find((sp) => sp.pinId === pinId)
}

export function isGroundPin(board: Board, pinId: string): boolean {
  return groundPinsOf(board).includes(pinId)
}

export function isGpio(pin: BoardPin): boolean {
  return pin.group === 'digital' || pin.group === 'analog'
}

export function hasRestriction(pin: BoardPin, kind: PinRestrictionKind): boolean {
  return pin.restrictions?.some((r) => r.kind === kind) ?? false
}

/** USB 시리얼(업로드·시리얼 모니터)과 공유되는 핀 */
export function isUsbSerialPin(board: Board, pin: BoardPin): boolean {
  return (
    hasRestriction(pin, 'usb-serial') ||
    board.buses.some((b) => b.name === 'Serial' && b.pins.some((p) => p.pinId === pin.id))
  )
}

/** GPIO 에 넣을 수 있는 최대 전압(V) */
export function gpioMaxInputVoltage(board: Board): number {
  return board.gpioMaxInputVoltage ?? board.logicVoltage
}

/** 핀 표시 이름. 실크 라벨이 ID 와 다르면 함께 적는다 (예: GPIO36(VP)). */
export function pinDisplayName(pin: BoardPin): string {
  return pin.label !== pin.id && !pin.id.endsWith(pin.label) ? `${pin.id}(${pin.label})` : pin.id
}

/** 보드 핀이 내보낼 수 있는 전압(V). GPIO 는 HIGH 출력 기준. 알 수 없으면 null */
export function boardPinVoltage(board: Board, pin: BoardPin): number | null {
  const supply = supplyPinOf(board, pin.id)
  if (supply) return supply.voltage
  if (isGroundPin(board, pin.id)) return 0
  if (isGpio(pin) && pin.capabilities.includes('digital') && !hasRestriction(pin, 'input-only')) return board.logicVoltage
  return null
}

/** 요구 전압에 맞는 전원 공급 핀. 없으면 undefined */
export function supplyPinFor(board: Board, voltage: number | undefined): string | undefined {
  const wanted = voltage ?? 5
  return supplyPinsOf(board).find((sp) => sp.voltage === wanted)?.pinId
}

/** 이 전원 핀에 쓸 보드 전원 핀. 로직 전원 부품은 보드 로직 전압을 우선한다 (ESP32 → 3V3) */
export function supplyPinForPin(board: Board, pin: ModulePin): string | undefined {
  const logic = pin.logicSupply ? supplyPinFor(board, board.logicVoltage) : undefined
  return logic ?? supplyPinFor(board, pin.supplyVoltage)
}

/** 전원 출력 핀(source)의 전압(V). 알 수 없으면 null */
export function sourceVoltage(module: Module, placed: PlacedModule | undefined, pin: ModulePin): number | null {
  if (pin.voltageParam) return placed ? paramNumber(module, placed, pin.voltageParam) : null
  return pin.supplyVoltage ?? null
}

/** 전원 출력 핀(source)의 최대 전류(mA). 알 수 없으면 null */
export function sourceLimitMa(module: Module, placed: PlacedModule | undefined, pin: ModulePin): number | null {
  if (pin.currentParam) return placed ? paramNumber(module, placed, pin.currentParam) : null
  return pin.maxCurrentMa ?? null
}

export function paramNumber(module: Module, placed: PlacedModule, paramId: string): number | null {
  const param = module.parameters?.find((p) => p.id === paramId)
  if (!param) return null
  const value = placed.params[paramId] ?? param.defaultValue
  const option = param.options.find((o) => o.value === value) ?? param.options.find((o) => o.value === param.defaultValue)
  return option?.number ?? null
}

export function usesServo(placed: PlacedModule[], getModule: (id: string) => Module): boolean {
  return placed.some((p) => getModule(p.moduleId).library === 'Servo')
}

function capList(caps: string[]) {
  return caps.map((c) => CAPABILITY_LABELS[c as keyof typeof CAPABILITY_LABELS] ?? c).join(', ')
}

/** 이 보드 핀에 연결할 수 있는 핀 목록 (오류 메시지 안내용) */
export function compatiblePins(board: Board, module: Module, pin: ModulePin, placed?: PlacedModule): string[] {
  return board.pins.filter((bp) => linkError(board, module, pin, bp, placed) === null).map((bp) => bp.id)
}

/** 외부 전원 + 를 보드 핀에 연결했을 때의 치명적 오류 */
function sourceLinkError(board: Board, boardPin: BoardPin, volts: number | null): string | null {
  const id = boardPin.id
  if (isGroundPin(board, id)) return '전원 + 를 GND 에 연결하면 단락(쇼트)이 됩니다.'
  const input = board.powerInput
  if (input?.pinId === id) {
    if (volts !== null && volts > input.maxVoltage) return `${id} 입력 범위(${input.minVoltage}–${input.maxVoltage} V)를 넘는 ${volts} V 입니다. 보드가 손상될 수 있습니다.`
    return null
  }
  const supply = supplyPinOf(board, id)
  if (supply) return volts === null || volts === supply.voltage ? null : `${id} 핀은 ${supply.voltage} V 입니다. ${volts} V 를 넣으면 보드가 손상됩니다.`
  return `${id} 에는 외부 전원을 연결할 수 없습니다.${input ? ` 보드에 전원을 넣으려면 ${input.pinId} 에 연결하세요.` : ''}`
}

/**
 * 모듈 핀을 보드 핀에 연결했을 때의 치명적 오류. 문제가 없으면 null.
 * (경고 수준의 문제는 validate.ts 에서 따로 검사한다.)
 */
export function linkError(
  board: Board,
  module: Module,
  pin: ModulePin,
  boardPin: BoardPin | undefined,
  placed?: PlacedModule,
): string | null {
  if (!boardPin) return `${board.name}에 없는 핀입니다.`
  const id = boardPin.id
  const isSupply = supplyPinOf(board, id) !== undefined
  switch (pin.role) {
    case 'power':
      if (isGroundPin(board, id)) return '전원 핀을 GND 에 연결하면 단락(쇼트)이 됩니다.'
      if (isSupply) return null
      if (id === 'VIN') return 'VIN 은 외부 입력 전압(7–12 V)이 그대로 나올 수 있어 부품이 손상될 수 있습니다. 5V 핀을 사용하세요.'
      return `${id} 는 부품 전원 공급용 핀이 아닙니다. ${supplyPinsOf(board).map((sp) => sp.pinId).join(' 또는 ')} 에 연결하세요.`
    case 'ground':
      if (isSupply || id === 'VIN') return 'GND 핀을 전원 핀에 연결하면 단락(쇼트)이 됩니다.'
      if (!isGroundPin(board, id)) return 'GND 핀은 보드의 GND 에 연결해야 합니다.'
      return null
    case 'signal': {
      if (isGroundPin(board, id)) return '신호 핀을 GND 에 직접 연결했습니다.'
      if (!isGpio(boardPin)) {
        // 직렬 저항이 붙는 핀(LED 애노드)은 5V/3.3V 에 연결해 상시 점등할 수 있다(검증에서 안내).
        if (module.seriesResistor?.pinId === pin.id && isSupply) return null
        return `신호 핀을 ${id} 에 직접 연결했습니다. GPIO 핀에 연결하세요.`
      }
      const missing = pin.requires.filter((c) => !boardPin.capabilities.includes(c))
      if (missing.length) return `${id} 는 ${capList(missing)} 기능을 지원하지 않습니다.`
      if (hasRestriction(boardPin, 'input-only') && (pin.direction ?? 'inout') !== 'in')
        return `${pinDisplayName(boardPin)} 는 입력 전용 핀이라 ${pin.name} 신호를 출력할 수 없습니다.`
      return null
    }
    case 'source':
      return sourceLinkError(board, boardPin, sourceVoltage(module, placed, pin))
    case 'load':
      return '모터 단자를 보드 핀에 직접 연결하면 보드가 손상될 수 있습니다. 모터 드라이버 출력에 연결하세요.'
    case 'drive':
      return '모터 드라이버 출력은 보드 핀이 아니라 모터 단자에 연결합니다.'
    case 'passive':
      return null
  }
}

/**
 * 서로 다른 두 보드의 핀을 직접 연결했을 때의 치명적 오류. 문제가 없으면 null.
 * 전압 레벨 차이는 넷 단위 검사(levels.ts)가 따로 판단한다.
 */
export function boardToBoardError(aBoard: Board, aPin: BoardPin | undefined, bBoard: Board, bPin: BoardPin | undefined): string | null {
  if (!aPin) return `${aBoard.name}에 없는 핀입니다.`
  if (!bPin) return `${bBoard.name}에 없는 핀입니다.`
  const kind = (board: Board, pin: BoardPin) => {
    if (isGroundPin(board, pin.id)) return 'ground'
    if (supplyPinOf(board, pin.id)) return 'supply'
    if (isGpio(pin)) return 'gpio'
    if (pin.group === 'control') return 'control'
    return 'other'
  }
  const ka = kind(aBoard, aPin)
  const kb = kind(bBoard, bPin)
  if (ka === 'other' || kb === 'other')
    return `${ka === 'other' ? aPin.id : bPin.id} 는 보드 간 연결에 사용할 수 없는 핀입니다.`
  if (ka === 'ground' && kb === 'ground') return null
  if ((ka === 'ground' && kb === 'supply') || (ka === 'supply' && kb === 'ground'))
    return '전원 핀과 GND 를 연결하면 단락(쇼트)이 됩니다.'
  if (ka === 'supply' && kb === 'supply') {
    const va = supplyPinOf(aBoard, aPin.id)!.voltage
    const vb = supplyPinOf(bBoard, bPin.id)!.voltage
    return va === vb ? null : `전압이 다른 전원(${va} V 와 ${vb} V)을 연결하면 단락됩니다.`
  }
  if (ka === 'gpio' && kb === 'gpio') return null
  if (ka === 'control' || kb === 'control') return ka === 'ground' || kb === 'ground' || ka === 'supply' || kb === 'supply'
    ? '제어 핀(EN 등)을 전원·GND 에 직접 연결하면 보드가 계속 리셋되거나 동작하지 않습니다.'
    : null
  return '신호 핀을 다른 보드의 전원·GND 에 직접 연결했습니다.'
}
