import { getModule, MODULES } from '../data/modules'
import type { DriverChannel, Module, ModulePin, MotorKind, PlacedModule } from '../types'
import type { Circuit } from './circuit'
import { isPinConnected } from './connections'

// 모터 카드를 모터 드라이버 카드에 끌어 놓아 연결할 때의 규칙
//
// - 드라이버 채널마다 받을 수 있는 모터 종류(accepts)가 정해져 있다 (DC / 스테퍼 / BLDC).
// - 한 채널에는 모터 하나만 연결한다. 그래서 드라이버가 받을 수 있는 모터 수 = 그 종류를 받는 채널 수.
// - 서보 모터는 보드의 PWM 핀에 신호선을 바로 연결하거나, 서보 드라이버(PCA9685)의 채널에 연결한다.
//   서보 드라이버에 연결하면 신호선은 채널 출력에, 전원은 드라이버의 서보 전원(V+)에, GND 는 드라이버 GND 에 잇는다.

export const MOTOR_KIND_LABELS: Record<MotorKind, string> = {
  dc: 'DC 모터',
  'stepper-bipolar': '바이폴라 스테퍼 모터',
  'stepper-unipolar': '유니폴라 스테퍼 모터',
  bldc: 'BLDC 모터',
  servo: '서보 모터',
}

export function isServo(module: Module): boolean {
  return module.code?.template === 'servo' || module.code?.template === 'servo-continuous'
}

/** 드라이버 채널에 놓을 때의 모터 종류 (서보는 'servo'). 모터가 아니면 null */
export function motorKindOf(module: Module): MotorKind | null {
  return module.motor?.kind ?? (isServo(module) ? 'servo' : null)
}

/** 드라이버 채널 출력에 이어지는 핀: 모터 단자, 서보는 신호선 */
export function motorPins(module: Module): ModulePin[] {
  return module.pins.filter((p) => (isServo(module) ? p.role === 'signal' : p.role === 'load'))
}

/** 서보 드라이버 채널 출력(drive)과 서보 신호선을 잇는 연결인지 */
export function isServoChannelLink(a: { module: Module; pin: ModulePin }, b: { module: Module; pin: ModulePin }): boolean {
  const servoOut = (x: typeof a) => x.pin.role === 'drive' && !!x.module.driver?.channels.some((ch) => ch.outputs.includes(x.pin.id) && ch.accepts.includes('servo'))
  const servoIn = (x: typeof a) => x.pin.role === 'signal' && isServo(x.module)
  return (servoOut(a) && servoIn(b)) || (servoOut(b) && servoIn(a))
}

/** 드라이버가 다루는 모터 종류와 종류별 최대 개수 */
export function driverCapacity(module: Module): { kind: MotorKind; max: number }[] {
  const counts = new Map<MotorKind, number>()
  for (const ch of module.driver?.channels ?? []) for (const kind of ch.accepts) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  return [...counts].map(([kind, max]) => ({ kind, max }))
}

/** 카드에 표시할 용량 설명 (예: DC 모터 최대 2개) */
export function capacityLabel(module: Module): string {
  return driverCapacity(module)
    .map((c) => `${MOTOR_KIND_LABELS[c.kind]} 최대 ${c.max}개`)
    .join(' · ')
}

const kindsOf = (module: Module) => driverCapacity(module).map((c) => MOTOR_KIND_LABELS[c.kind]).join('·')
const loadPins = motorPins

/** 모터 단자가 이 드라이버의 어느 채널에 물려 있는지 */
export function attachedChannel(circuit: Circuit, motor: PlacedModule, driver: PlacedModule): DriverChannel | null {
  const loads = loadPins(getModule(motor.moduleId)).map((p) => p.id)
  for (const ch of getModule(driver.moduleId).driver?.channels ?? []) {
    const hit = circuit.connections.some((c) =>
      [c.from, c.to].some((e) => e.kind === 'module' && e.instanceId === driver.instanceId && ch.outputs.includes(e.pinId)) &&
      [c.from, c.to].some((e) => e.kind === 'module' && e.instanceId === motor.instanceId && loads.includes(e.pinId)),
    )
    if (hit) return ch
  }
  return null
}

/** 모터가 물려 있는 드라이버와 채널 */
export function motorDriverOf(circuit: Circuit, motor: PlacedModule): { driver: PlacedModule; channel: DriverChannel } | null {
  for (const driver of circuit.placed) {
    if (driver === motor || !getModule(driver.moduleId).driver) continue
    const channel = attachedChannel(circuit, motor, driver)
    if (channel) return { driver, channel }
  }
  return null
}

/** 드라이버 카드에 표시할 사용 현황 (예: DC 모터 1/2) */
export function driverUsage(circuit: Circuit, driver: PlacedModule): string | null {
  const module = getModule(driver.moduleId)
  if (!module.driver) return null
  const [main] = driverCapacity(module)
  const used = module.driver.channels.filter((ch) => ch.outputs.some((id) => isPinConnected(circuit.connections, driver.instanceId, id))).length
  return `${MOTOR_KIND_LABELS[main.kind].replace(' 모터', '')} ${used}/${module.driver.channels.length}`
}

export type AttachPlan = { ok: true; channel: DriverChannel; used: number; max: number } | { ok: false; reason: string }

/** 모터를 드라이버에 연결할 수 있는지와 쓸 채널 */
export function planMotorAttach(circuit: Circuit, motorId: string, driverId: string): AttachPlan {
  const fail = (reason: string): AttachPlan => ({ ok: false, reason })
  const motor = circuit.placed.find((p) => p.instanceId === motorId)
  const driver = circuit.placed.find((p) => p.instanceId === driverId)
  if (!motor || !driver || motor === driver) return fail('연결할 부품을 찾지 못했습니다.')
  const motorModule = getModule(motor.moduleId)
  const driverModule = getModule(driver.moduleId)
  if (!driverModule.driver) return fail(`${driver.label}은(는) 모터 드라이버가 아닙니다.`)
  const kind = motorKindOf(motorModule)
  if (!kind) return fail(`${motor.label}은(는) 모터가 아니라서 ${driver.label}에 연결하지 않습니다.`)
  if (kind === 'servo' && !driverModule.driver.channels.some((ch) => ch.accepts.includes('servo'))) {
    const servoDrivers = MODULES.filter((m) => m.driver?.channels.some((ch) => ch.accepts.includes('servo'))).map((m) => m.name)
    return fail(
      `${motor.label}: 서보 모터는 신호선을 보드의 PWM 핀에 바로 연결하거나 서보 드라이버(${servoDrivers.join(', ')})에 연결합니다. ${driver.label}은(는) ${kindsOf(driverModule)}용입니다.`,
    )
  }
  const loads = loadPins(motorModule)
  const fits = driverModule.driver.channels.filter((ch) => ch.accepts.includes(kind) && ch.outputs.length === loads.length)
  if (!fits.length) {
    const others = MODULES.filter((m) => m.driver?.channels.some((ch) => ch.accepts.includes(kind))).map((m) => m.name)
    return fail(
      `${driver.label}은(는) ${kindsOf(driverModule)}용 드라이버라 ${MOTOR_KIND_LABELS[kind]}(${motor.label})를 연결할 수 없습니다.` +
        (others.length ? ` ${others.join(', ')}를 쓰세요.` : ''),
    )
  }
  const current = attachedChannel(circuit, motor, driver)
  if (current) return fail(`${motor.label}은(는) 이미 ${driver.label} ${current.label}에 연결되어 있습니다.`)
  const busy = (ch: DriverChannel) => ch.outputs.some((id) => isPinConnected(circuit.connections, driver.instanceId, id))
  const free = fits.find((ch) => !busy(ch))
  if (!free) return fail(`${driver.label}에는 ${MOTOR_KIND_LABELS[kind]}를 최대 ${fits.length}개까지 연결할 수 있는데 모두 쓰고 있습니다.`)
  return { ok: true, channel: free, used: fits.filter(busy).length + 1, max: fits.length }
}

/** 모터 종류·전압·전류에 맞는 드라이버 (카탈로그 순서에서 가장 잘 맞는 것) */
export function recommendDriver(motor: Module): Module | null {
  if (!motor.motor) return null
  const spec = motor.motor
  const loads = loadPins(motor).length
  const scored = MODULES.filter((m) => m.driver?.channels.some((ch) => ch.accepts.includes(spec.kind) && ch.outputs.length === loads)).map((m) => {
    const d = m.driver!
    const supply = m.pins.find((p) => p.id === d.supplyPin)
    const voltageOk = !supply || ((supply.minVoltage ?? 0) <= spec.nominalVoltage && spec.nominalVoltage <= (supply.maxVoltage ?? Infinity))
    const score = Number(voltageOk) * 4 + Number(spec.typicalMa <= d.channelMa) * 2 + Number(spec.peakMa <= d.channelPeakMa)
    return { m, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored[0]?.m ?? null
}
