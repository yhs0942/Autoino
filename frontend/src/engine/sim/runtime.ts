import { getModule } from '../../data/modules'
import type { Module, PlacedModule } from '../../types'
import { boardDefOf, hostBoardOf, resolveBoardPin, type Circuit } from '../circuit'
import { activeChannels, endpointKey, isPinConnected, moduleEndpoint, requiredPins } from '../connections'
import { isGpio, supplyPinOf } from '../electrical'
import { motorDriverOf } from '../motorAttach'
import { muxChannelOf, muxUsers } from '../mux'
import { buildNetlist, type Netlist } from '../netlist'
import { routeToBoard } from '../paths'
import { netVoltage, type PowerReport } from '../power'
import { computeLadderResistors, ladderThresholds, shareOf } from '../shares'
import type { Issue } from '../validate'
import { BEHAVIOR, type SimInput } from './behavior'

// 시뮬레이션 실행기
//
// 생성 코드(backend/autoino/codegen.py)의 부품별 예시 동작을 시간에 따라 그대로 돌린다:
// LED 0.5초 깜박임, 릴레이·부저 1초 켜기·끄기, 서보 20 ms 마다 2° 왕복, 모터 2초마다 정방향 → 정지 → 역방향 → 정지,
// 스테퍼 3 ms(ULN2003)·2 ms(STEP/DIR) 마다 한 스텝, NeoPixel 0.1초마다 한 칸, 센서 값 출력 주기 등.
// 보드가 내보내는 핀 신호를 배선(레벨 시프터 등 경유 포함)을 따라 부품에 전달하고, 부품은 전원·GND·배선이
// 올바를 때만 움직인다. 생성 코드와 같은 형식으로 시리얼 모니터 출력을 만든다.

export type { SimInput } from './behavior'

/** 보드 핀이 내보내는 신호 */
export interface PinOut {
  high: boolean
  /** PWM 듀티 (0–1). 디지털이면 0 또는 1 */
  duty: number
  /** 서보 펄스 (각도) */
  servo?: number
  /** STEP 펄스: 지금까지의 스텝 수와 방향 */
  step?: { count: number; forward: boolean }
}

interface ViewBase {
  /** 전원·배선이 맞아 동작하는지 */
  ok: boolean
  /** 동작하지 않는 이유 */
  reason?: string
  /** 동작은 하지만 주의할 점 (전원 용량 초과 등) */
  warn?: string
  /** 카드에 짧게 보일 상태 */
  status: string
}

export type ModuleView = ViewBase &
  (
    | { kind: 'led'; on: boolean; level: number; color: string }
    | { kind: 'button'; pressed: boolean }
    | { kind: 'relay'; on: boolean }
    | { kind: 'buzzer'; on: boolean }
    | { kind: 'servo'; angle: number; spin: number; jitter: boolean }
    | { kind: 'motor'; speed: number; rpm: number; style: 'wheel' | 'fan' | 'pump' | 'vibration' | 'prop' }
    | { kind: 'stepper'; angle: number; rpm: number; forward: boolean }
    | { kind: 'driver'; channels: { label: string; speed: number }[]; leds?: boolean[]; powerLed: boolean }
    | { kind: 'esc'; throttle: number; armed: boolean }
    | { kind: 'lcd'; lines: string[]; backlight: boolean }
    | { kind: 'oled'; lines: string[]; frame?: OledFrame }
    | { kind: 'seg'; text: string; segments?: number[]; brightness?: number }
    | { kind: 'pixels'; colors: string[] }
    | { kind: 'sonar'; cm: number; ping: boolean }
    | { kind: 'gauge'; control: 'value' | 'light' | 'moisture' | 'gas'; fraction: number; raw: number; max: number; led: boolean; heating?: boolean }
    | { kind: 'joystick'; x: number; y: number; pressed: boolean }
    | { kind: 'encoder'; value: number; pressed: boolean }
    | { kind: 'dht'; temperature: number; humidity: number }
    | { kind: 'pir'; motion: boolean; out: boolean }
    | { kind: 'line'; onLine: boolean; out: boolean }
    | { kind: 'imu'; tiltX: number; tiltY: number; raw: [number, number, number] }
    | { kind: 'bt'; connected: boolean; led: boolean; lastTx: string; lastRx: string }
    | { kind: 'rfid'; uid: string; flash: boolean }
    | { kind: 'power'; on: boolean; text: string }
    | { kind: 'mux'; channels: { channel: number; label: string; raw: number }[]; active: number }
    | { kind: 'pass'; text: string; active: boolean[] }
  )

/** OLED 화면 (코드 시뮬레이션) */
export interface OledFrame {
  width: number
  height: number
  pixels: Uint8Array
  texts: { x: number; y: number; size: number; text: string; color: number; bg: number | null }[]
  inverted: boolean
  /** display() 횟수 */
  n: number
}

export interface SerialLine {
  t: number
  board: string
  text: string
}

export interface BoardView {
  instanceId: string
  /** 전원 LED */
  on: boolean
  /** 보드 LED (Uno D13 'L', ESP32 GPIO2) */
  led: boolean
  /** 시리얼 송신 LED */
  tx: boolean
}

export interface SimView {
  t: number
  modules: Map<string, ModuleView>
  boards: BoardView[]
  /** 보드 핀 신호 (보드 인스턴스:핀) */
  pins: Map<string, PinOut>
}

interface Task {
  item: PlacedModule
  module: Module
  board: string
  name: string
  template: string
  /** 코드 역할(또는 핀 ID) → 보드 핀 */
  pins: Record<string, string>
  /** 멀티플렉서로 읽는 축/값: 역할 → 채널 */
  mux?: Record<string, { muxId: string; channel: number }>
  extra: Record<string, unknown>
}

interface Health {
  ok: boolean
  reason?: string
  warn?: string
}

const BASE_NAMES: Record<string, string> = { 'led-5mm': 'led', 'push-button': 'button', 'hc-sr04': 'sonar', sg90: 'servo', 'i2c-lcd-1602': 'lcd' }
const PRIMARY_PIN: Record<string, string> = { 'led-5mm': 'anode', 'push-button': 'pin2a', 'hc-sr04': 'trig', sg90: 'signal', 'i2c-lcd-1602': 'sda' }
const MOTOR_SPEED = 180
const SERVO_MIN_US = 544
const SERVO_MAX_US = 2400
const LOW: PinOut = { high: false, duty: 0 }
const HIGH: PinOut = { high: true, duty: 1 }
const level = (on: boolean): PinOut => (on ? HIGH : LOW)
const tri = (n: number, step: number, top: number) => {
  const pos = (n * step) % (2 * top)
  return pos <= top ? pos : 2 * top - pos
}

function ident(base: string, label: string, used: Set<string>): string {
  const n = label.match(/(\d+)$/)?.[1] ?? '1'
  let name = `${base}${n}`
  while (used.has(name)) name += '_'
  used.add(name)
  return name
}

/** 생성 코드에서 서보 각도 → 서보 라이브러리 펄스(µs) */
const servoUs = (angle: number) => Math.round(SERVO_MIN_US + ((SERVO_MAX_US - SERVO_MIN_US) * angle) / 180)

export class SimRuntime {
  t = 0
  serial: SerialLine[] = []
  protected readonly inputs = new Map<string, SimInput>()
  protected readonly tasks: Task[] = []
  protected readonly health = new Map<string, Health>()
  protected readonly traced: Netlist
  protected readonly netlist: Netlist
  protected readonly last = new Map<string, unknown>()
  protected readonly encoder = new Map<string, number>()
  protected readonly pending = new Map<string, string[]>()
  protected readonly btTx = new Map<string, string>()
  protected readonly btRx = new Map<string, string>()
  protected readonly rfid = new Map<string, { uid: string; t: number }>()
  protected readonly motionUntil = new Map<string, number>()
  protected lastSerial = new Map<string, number>()

  readonly circuit: Circuit

  /** 시리얼 출력이 바뀔 때마다 늘어난다 (모니터 갱신용) */
  serialVersion = 0

  constructor(circuit: Circuit, ctx: { issues: Issue[]; power: PowerReport; demo?: boolean }) {
    this.circuit = circuit
    this.netlist = buildNetlist(circuit)
    this.traced = buildNetlist(circuit, { passThrough: true })
    for (const item of circuit.placed) this.inputs.set(item.instanceId, { ...(BEHAVIOR[item.moduleId]?.defaults ?? {}) })
    this.computeHealth(ctx.issues, ctx.power)
    if (ctx.demo === false) return
    this.buildTasks()
    for (const b of circuit.boards) this.print(b.instanceId, `Autoino: autoino_${b.instanceId.replace(/-/g, '_')}.ino start`)
  }

  // ---------------------------------------------------------------- 입력

  input(instanceId: string): SimInput {
    return this.inputs.get(instanceId) ?? {}
  }

  setInput(instanceId: string, patch: SimInput): void {
    const prev = this.input(instanceId)
    this.inputs.set(instanceId, { ...prev, ...patch })
    if (patch.motion === false && prev.motion) this.motionUntil.set(instanceId, this.t + 3000)
  }

  /** 엔코더 한 칸 돌리기 (+1 시계 방향, −1 반시계) */
  rotate(instanceId: string, dir: 1 | -1): void {
    const task = this.tasks.find((t) => t.item.instanceId === instanceId && t.template === 'encoder')
    const value = (this.encoder.get(instanceId) ?? 0) + dir
    this.encoder.set(instanceId, value)
    if (task && this.healthOf(instanceId).ok) this.print(task.board, `${task.name}: ${value}`)
  }

  /** RFID 카드 대기 */
  tapCard(instanceId: string): void {
    const uid = BEHAVIOR['rc522-rfid'].cardUid!
    this.rfid.set(instanceId, { uid, t: this.t })
    const task = this.tasks.find((t) => t.item.instanceId === instanceId && t.template === 'rc522')
    if (task && this.healthOf(instanceId).ok) this.queue(task, `${task.name} UID: ${uid}`)
  }

  /** 휴대폰에서 블루투스 모듈로 보내기 */
  sendBluetooth(instanceId: string, text: string): void {
    this.btRx.set(instanceId, text)
    const task = this.tasks.find((t) => t.item.instanceId === instanceId && t.template === 'serial-module')
    if (task && this.healthOf(instanceId).ok) this.print(task.board, text)
  }

  // ---------------------------------------------------------------- 시간

  step(dtMs: number): void {
    const from = this.t
    const to = this.t + Math.max(0, dtMs)
    for (const task of this.tasks) {
      const every = POLL[task.template] ?? (task.item.moduleId === 'push-button' ? 20 : task.item.moduleId === 'hc-sr04' ? 200 : 0)
      if (!every) continue
      for (let k = Math.floor(from / every) + 1; k * every <= to; k++) this.poll(task, k * every)
    }
    this.t = to
  }

  protected print(board: string, text: string, t = this.t) {
    this.serialVersion++
    this.serial.push({ t, board, text })
    if (this.serial.length > 300) this.serial.splice(0, this.serial.length - 300)
    this.lastSerial.set(board, t)
  }

  protected queue(task: Task, text: string) {
    this.pending.set(task.item.instanceId, [...(this.pending.get(task.item.instanceId) ?? []), text])
  }

  protected changed(key: string, value: unknown): boolean {
    if (this.last.get(key) === value) return false
    this.last.set(key, value)
    return true
  }

  /** 생성 코드의 every() 주기마다 하는 일 (값 읽기·출력) */
  protected poll(task: Task, t: number) {
    const id = task.item.instanceId
    const ok = this.healthOf(id).ok
    const input = this.input(id)
    const say = (text: string) => this.print(task.board, text, t)
    switch (task.template) {
      case 'button': {
        // 다른 버튼과 입력 공유면 어느 쪽을 눌러도 LOW
        const pressed = ok && (task.extra.members as string[]).some((m) => this.input(m).pressed)
        if (this.changed(`${id}:button`, pressed)) say(`${task.name}: ${pressed ? 'pressed' : 'released'}`)
        break
      }
      case 'ladder': {
        const rungs = task.extra.rungs as { instanceId: string; name: string; ohms: number }[]
        const index = ok ? rungs.findIndex((r) => this.input(r.instanceId).pressed) : -1
        if (this.changed(`${id}:ladder`, index)) say(index < 0 ? `${task.name}: released` : `${rungs[index].name}: pressed`)
        break
      }
      case 'digital-read': {
        const high = ok && this.digitalOut(task.item, t)
        if (this.changed(`${id}:dr`, high)) say(`${task.name}: ${high ? 'HIGH' : 'LOW'}`)
        break
      }
      case 'analog-read':
        say(`${task.name}: ${this.analogRead(task, 'value')}`)
        break
      case 'joystick':
        say(`${task.name} x=${this.analogRead(task, 'x')} y=${this.analogRead(task, 'y')} sw=${ok && input.pressed ? 'down' : 'up'}`)
        break
      case 'dht':
        say(ok ? `${task.name} C=${(input.temperature ?? 24).toFixed(2)} %=${(input.humidity ?? 55).toFixed(2)}` : `${task.name} C=nan %=nan`)
        break
      case 'hc-sr04': {
        const cm = this.sonarCm(id)
        say(`${task.name} cm: ${cm.toFixed(2)}`)
        break
      }
      case 'mpu6050': {
        const [ax, ay, az] = ok ? imuRaw(input) : [-1, -1, -1]
        say(`${task.name} ax=${ax} ay=${ay} az=${az}`)
        break
      }
      case 'serial-module':
        if (ok) this.btTx.set(id, 'hello from Autoino')
        break
      case 'rc522':
        for (const text of this.pending.get(id) ?? []) say(text)
        this.pending.delete(id)
        break
    }
  }

  // ---------------------------------------------------------------- 배선 · 전원

  protected computeHealth(issues: Issue[], power: PowerReport) {
    const { circuit } = this
    for (const item of circuit.placed) {
      const module = getModule(item.moduleId)
      const missing = requiredPins(circuit.connections, item.instanceId, module).filter((p) => !isPinConnected(circuit.connections, item.instanceId, p.id))
      const error = issues.find((i) => i.severity === 'error' && i.instanceId === item.instanceId && !RUNS_ANYWAY.has(i.code))
      const risky = issues.find((i) => i.severity === 'error' && i.instanceId === item.instanceId && RUNS_ANYWAY.has(i.code))
      const unpowered = module.pins.filter((p) => p.role === 'power' && isPinConnected(circuit.connections, item.instanceId, p.id) && netVoltage(circuit, this.netlist, endpointKey(moduleEndpoint(item.instanceId, p.id))) === null)
      let reason: string | undefined
      if (missing.length) reason = `미연결: ${missing.map((p) => (p.role === 'ground' ? `${p.name}→GND` : p.role === 'power' ? `${p.name}→전원` : p.name)).join(', ')}`
      else if (unpowered.length) reason = `${unpowered.map((p) => p.name).join(', ')} 에 전원이 없습니다`
      else if (error) reason = error.message.replace(`${item.label}: `, '').replace(`${item.label} · `, '')
      const overload = power.sources.find((s) => s.status === 'overload' && s.loads.some((l) => l.instanceId === item.instanceId))
      const warning = issues.find((i) => i.severity === 'warning' && i.instanceId === item.instanceId && WARN_CODES.has(i.code))
      const warn = risky
        ? `${risky.message.replace(`${item.label}: `, '')} 돌기는 하지만 뜨거워지고 수명이 줄어듭니다`
        : overload
          ? `${overload.label} 용량 초과: 실제로는 떨리거나 보드가 리셋될 수 있습니다`
          : warning?.message.replace(`${item.label}: `, '')
      this.health.set(item.instanceId, { ok: !reason, reason, warn })
    }
  }

  protected healthOf(instanceId: string): Health {
    return this.health.get(instanceId) ?? { ok: false, reason: '알 수 없는 부품' }
  }

  // ---------------------------------------------------------------- 코드 (작업 목록)

  protected codeBoardOf(item: PlacedModule, module: Module): string | null {
    let pin = PRIMARY_PIN[item.moduleId] ?? (module.code?.pins ? Object.values(module.code.pins)[0] : undefined)
    if (!pin && module.driver) pin = activeChannels(this.circuit.connections, item.instanceId, module)[0]?.inputs[0]
    const route = pin ? routeToBoard(this.circuit, item.instanceId, pin, this.traced) : null
    return route?.boardInstanceId ?? hostBoardOf(this.circuit, item)?.instanceId ?? null
  }

  /** 핀이 이 보드의 GPIO 에 이어져 있으면 그 보드 핀 */
  protected gpioOf(item: PlacedModule, pinId: string, board: string): string | null {
    const route = routeToBoard(this.circuit, item.instanceId, pinId, this.traced)
    if (!route || route.boardInstanceId !== board) return null
    const r = resolveBoardPin(this.circuit, board, route.pinId)
    return r?.pin && isGpio(r.pin) ? route.pinId : null
  }

  protected buildTasks() {
    const { circuit } = this
    const ladder = computeLadderResistors(circuit)
    for (const board of circuit.boards) {
      const used = new Set<string>()
      const hosted = circuit.placed
        .filter((p) => this.codeBoardOf(p, getModule(p.moduleId)) === board.instanceId)
        .sort((a, b) => Number(a.moduleId === 'i2c-lcd-1602') - Number(b.moduleId === 'i2c-lcd-1602'))
      for (const item of hosted) {
        const module = getModule(item.moduleId)
        const spec = module.code
        const template = item.moduleId === 'led-5mm' ? 'led' : item.moduleId === 'push-button' ? 'button' : item.moduleId === 'hc-sr04' ? 'hc-sr04' : item.moduleId === 'i2c-lcd-1602' ? 'lcd' : spec?.template
        const base = BASE_NAMES[item.moduleId] ?? spec?.base
        if (!template || !base || template === 'none' || template === 'mux') continue
        // 핀 공유: 신호 핀이 하나뿐인 부품과 STEP 을 함께 쓰는 스텝 드라이버는 그룹의 첫 부품 코드가 함께 움직인다
        const signals = module.pins.filter((p) => p.role === 'signal').map((p) => p.id)
        const lead = signals.length === 1 ? signals[0] : template === 'step-dir' ? spec?.pins?.step : undefined
        const group = lead ? shareOf(circuit, endpointKey(moduleEndpoint(item.instanceId, lead))) : undefined
        if (group && group.members[0] !== endpointKey(moduleEndpoint(item.instanceId, lead!))) continue
        const name = ident(base, item.label, used)
        const roles: Record<string, string> = spec?.pins ? { ...spec.pins } : {}
        if (template === 'led') roles.anode = 'anode'
        if (template === 'button') roles.value = 'pin2a'
        if (template === 'hc-sr04') Object.assign(roles, { trig: 'trig', echo: 'echo' })
        if (template === 'lcd') Object.assign(roles, { sda: 'sda', scl: 'scl' })
        if (template === 'h-bridge' || template === 'stepper-coils') {
          const channels = template === 'stepper-coils' ? module.driver!.channels.slice(0, 1) : activeChannels(circuit.connections, item.instanceId, module)
          channels.forEach((ch) => ch.inputs.forEach((pid) => (roles[pid] = pid)))
          if (spec?.standbyPin) roles[spec.standbyPin] = spec.standbyPin
        }
        if (template === 'pca9685' || template === 'serial-module' || template === 'rc522') {
          // 버스 장치: 배선이 맞으면 동작한다 (보드 핀 확인만)
        }
        const task: Task = { item, module, board: board.instanceId, name, template, pins: {}, extra: {} }
        // 아날로그 값은 멀티플렉서 채널로도 읽을 수 있다
        for (const role of template === 'analog-read' ? ['value'] : template === 'joystick' ? ['x', 'y'] : []) {
          const ch = muxChannelOf(circuit, endpointKey(moduleEndpoint(item.instanceId, roles[role])))
          if (ch && this.muxReadable(ch.muxId, ch.channel, board.instanceId)) {
            task.mux = { ...task.mux, [role]: ch }
            delete roles[role]
          }
        }
        let complete = true
        for (const [role, pid] of Object.entries(roles)) {
          const bp = this.gpioOf(item, pid, board.instanceId)
          if (!bp) {
            complete = false
            break
          }
          task.pins[role] = bp
        }
        if (!complete) continue
        if (template === 'button') {
          const rungs = ladder.filter((r) => r.boardInstanceId === board.instanceId && r.boardPinId === task.pins.value)
          if (rungs.length) {
            task.template = 'ladder'
            const names = new Set<string>()
            task.extra.rungs = rungs.map((r) => ({ instanceId: r.instanceId, ohms: r.ohms, name: ident('button', circuit.placed.find((p) => p.instanceId === r.instanceId)!.label, names) }))
            task.name = ident('ladder', task.pins.value, used)
            task.extra.limits = ladderThresholds(rungs.length)
          } else task.extra.members = group?.members.map((k) => k.split(':')[1]) ?? [item.instanceId]
        }
        if (template === 'step-dir') {
          // STEP 을 함께 쓰는 드라이버의 따로 있는 DIR 도 같은 방향
          const dirs: string[] = []
          for (const k of group?.members ?? []) {
            const other = circuit.placed.find((p) => k.startsWith(`module:${p.instanceId}:`))
            if (!other || other === item) continue
            const odir = getModule(other.moduleId).code!.pins!.dir
            const bp = this.gpioOf(other, odir, board.instanceId)
            if (bp && bp !== task.pins.dir) dirs.push(bp)
          }
          task.extra.mirrorDirs = dirs
        }
        if (template === 'pca9685') task.extra.servos = this.servosOn(item)
        // 생성 코드의 처음 값: 버튼 Last = HIGH(안 눌림), 디지털 입력 Last = LOW, 사다리 Last = -1
        this.last.set(`${item.instanceId}:button`, false)
        this.last.set(`${item.instanceId}:dr`, false)
        this.last.set(`${item.instanceId}:ladder`, -1)
        if (template === 'lcd') task.extra.sonar = hosted.find((p) => p.moduleId === 'hc-sr04')?.instanceId
        this.tasks.push(task)
      }
    }
  }

  /** 멀티플렉서의 그 채널을 이 보드에서 읽을 수 있는지 (SIG 가 아날로그 핀, 필요한 선택선이 GPIO) */
  protected muxReadable(muxId: string, channel: number, board: string): boolean {
    const mux = this.circuit.placed.find((p) => p.instanceId === muxId)
    const spec = mux && getModule(mux.moduleId).mux
    if (!mux || !spec || !this.healthOf(muxId).ok) return false
    const route = routeToBoard(this.circuit, muxId, spec.common, this.traced)
    const r = route?.boardInstanceId === board ? resolveBoardPin(this.circuit, board, route.pinId) : null
    if (!r?.pin?.capabilities.includes('analog')) return false
    let bits = 0
    while (bits < spec.select.length && this.gpioOf(mux, spec.select[bits], board)) bits++
    return channel < 2 ** bits
  }

  /** 서보 드라이버 채널에 물린 서보 (채널 → 서보) */
  protected servosOn(driver: PlacedModule): Map<number, PlacedModule> {
    const out = new Map<number, PlacedModule>()
    const channels = getModule(driver.moduleId).driver?.channels ?? []
    for (const c of this.circuit.connections)
      for (const [a, b] of [
        [c.from, c.to],
        [c.to, c.from],
      ]) {
        if (a.kind !== 'module' || b.kind !== 'module' || a.instanceId !== driver.instanceId) continue
        const index = channels.findIndex((ch) => ch.outputs.includes(a.pinId) && ch.accepts.includes('servo'))
        const servo = this.circuit.placed.find((p) => p.instanceId === b.instanceId)
        if (index >= 0 && servo && getModule(servo.moduleId).code?.pins?.signal === b.pinId) out.set(index, servo)
      }
    return out
  }

  // ---------------------------------------------------------------- 신호 계산

  /** 서보 템플릿의 각도 (생성 코드: 20 ms 마다 2°, 0°–180° 왕복). 연속 회전은 2초마다 120 → 90 → 60 → 90 */
  protected servoAngle(template: string, t: number): number {
    if (template === 'servo-continuous') {
      const state = Math.floor(t / 2000) % 4
      return state === 1 ? 120 : state === 3 ? 60 : 90
    }
    return tri(Math.floor(t / 20), 2, 180)
  }

  /** 지금 시각의 보드 핀 신호 */
  protected outputs(t: number): Map<string, PinOut> {
    const pins = new Map<string, PinOut>()
    const set = (task: Task, role: string, out: PinOut) => {
      const pin = task.pins[role]
      if (pin) pins.set(`${task.board}:${pin}`, out)
    }
    for (const task of this.tasks) {
      switch (task.template) {
        case 'led':
          set(task, 'anode', level(Math.floor(t / 500) % 2 === 1))
          break
        case 'digital-write': {
          const on = Math.floor(t / 1000) % 2 === 1
          set(task, 'value', level(task.module.code?.activeLow ? !on : on))
          break
        }
        case 'servo':
        case 'servo-continuous': {
          const angle = this.servoAngle(task.template, t)
          set(task, 'signal', { high: true, duty: servoUs(angle) / 20000, servo: angle })
          break
        }
        case 'esc':
          set(task, 'signal', { high: true, duty: 1000 / 20000, servo: 0 })
          break
        case 'h-bridge': {
          const state = Math.floor(t / 2000) % 4
          const speed = state === 1 ? MOTOR_SPEED : state === 3 ? -MOTOR_SPEED : 0
          const spec = task.module.code!
          if (spec.standbyPin) set(task, spec.standbyPin, HIGH)
          for (const ch of activeChannels(this.circuit.connections, task.item.instanceId, task.module)) {
            if (spec.scheme === 'en-in1-in2') {
              set(task, ch.inputs[0], { high: speed !== 0, duty: Math.abs(speed) / 255 })
              set(task, ch.inputs[1], level(speed > 0))
              set(task, ch.inputs[2], level(speed < 0))
            } else {
              set(task, ch.inputs[0], { high: speed > 0, duty: speed > 0 ? speed / 255 : 0 })
              set(task, ch.inputs[1], { high: speed < 0, duty: speed < 0 ? -speed / 255 : 0 })
            }
          }
          break
        }
        case 'stepper-coils': {
          const n = Math.floor(t / 3)
          const phase = n & 3
          task.module.driver!.channels[0].inputs.forEach((pid, i) => set(task, pid, { ...level(i === phase || i === ((phase + 1) & 3)), step: { count: n, forward: true } }))
          break
        }
        case 'step-dir': {
          const n = Math.floor(t / 2)
          const forward = Math.floor(n / 200) % 2 === 0
          set(task, 'step', { high: false, duty: 0, step: { count: n, forward } })
          set(task, 'dir', level(forward))
          for (const pin of task.extra.mirrorDirs as string[]) pins.set(`${task.board}:${pin}`, level(forward))
          break
        }
        case 'hc-sr04':
          set(task, 'trig', LOW)
          break
      }
    }
    return pins
  }

  /** 부품 핀에 들어오는 보드 신호 (배선·레벨 시프터를 따라감). 보드 전원 핀이면 늘 HIGH */
  protected signalAt(pins: Map<string, PinOut>, item: PlacedModule, pinId: string): PinOut | null {
    const route = routeToBoard(this.circuit, item.instanceId, pinId, this.traced)
    if (!route) return null
    const board = boardDefOf(this.circuit, route.boardInstanceId)
    if (board && supplyPinOf(board, route.pinId)) return HIGH
    return pins.get(`${route.boardInstanceId}:${route.pinId}`) ?? LOW
  }

  protected adcMax(task: Task): number {
    return boardDefOf(this.circuit, task.board)?.core === 'arduino-esp32' ? 4095 : 1023
  }

  /** 센서 출력값 (0–1) */
  protected fraction(item: PlacedModule, role: string): number {
    const input = this.input(item.instanceId)
    const id = item.moduleId
    if (id === 'joystick-ky023') return ((role === 'y' ? (input.y ?? 0) : (input.x ?? 0)) + 1) / 2
    if (id === 'ldr-module') return 1 - (input.light ?? 0.5)
    if (id === 'soil-moisture') return 1 - 0.7 * (input.moisture ?? 0.3)
    if (id === 'mq2-gas') return 0.1 + 0.8 * (input.gas ?? 0)
    return input.value ?? 0.5
  }

  protected analogRead(task: Task, role: string): number {
    const max = this.adcMax(task)
    if (!this.healthOf(task.item.instanceId).ok) return 0
    const ch = task.mux?.[role]
    if (ch && !this.healthOf(ch.muxId).ok) return 0
    return Math.round(this.fraction(task.item, role) * max)
  }

  protected digitalOut(item: PlacedModule, t: number): boolean {
    const input = this.input(item.instanceId)
    if (item.moduleId === 'pir-hc-sr501') return !!input.motion || (this.motionUntil.get(item.instanceId) ?? -1) > t
    if (item.moduleId === 'line-tracker') return !!input.onLine
    return false
  }

  protected sonarCm(instanceId: string): number {
    const cm = this.input(instanceId).distance ?? 30
    return this.healthOf(instanceId).ok && cm >= 2 && cm <= 400 ? cm : -1
  }

  // ---------------------------------------------------------------- 화면

  view(): SimView {
    const t = this.t
    const pins = this.outputs(t)
    const modules = new Map<string, ModuleView>()
    for (const item of this.circuit.placed) modules.set(item.instanceId, this.viewOf(item, pins, t))
    const boards = this.circuit.boards.map((b) => {
      const def = boardDefOf(this.circuit, b.instanceId)
      const ledPin = def?.core === 'arduino-esp32' ? 'GPIO2' : 'D13'
      return { instanceId: b.instanceId, on: true, led: !!pins.get(`${b.instanceId}:${ledPin}`)?.high, tx: t - (this.lastSerial.get(b.instanceId) ?? -1e9) < 80 }
    })
    return { t, modules, boards, pins }
  }

  protected viewOf(item: PlacedModule, pins: Map<string, PinOut>, t: number): ModuleView {
    const module = getModule(item.moduleId)
    const health = this.healthOf(item.instanceId)
    const { ok, reason, warn } = health
    const input = this.input(item.instanceId)
    const task = this.tasks.find((x) => x.item.instanceId === item.instanceId)
    const base = { ok, reason, warn }
    const noCode = ok && !task && !!module.code && module.code.template !== 'none' && module.code.template !== 'mux'
    // 신호선은 이어졌지만 코드가 이 부품을 다루지 않는 경우 (핀이 GPIO 가 아님 등)
    const codeReason = noCode && !this.mirrored(item) ? '코드가 이 부품을 다루지 않습니다 (신호 핀이 보드 GPIO 에 연결되지 않음)' : undefined
    const sig = (pinId: string) => this.signalAt(pins, item, pinId)
    const behavior = BEHAVIOR[item.moduleId]

    switch (item.moduleId) {
      case 'led-5mm': {
        const s = sig('anode')
        const on = ok && !!s?.high
        const color = module.parameters?.find((p) => p.id === 'color')?.options.find((o) => o.value === (item.params.color ?? 'red'))?.value ?? 'red'
        return { ...base, kind: 'led', on, level: on ? s!.duty || 1 : 0, color, status: ok ? (on ? '켜짐' : '꺼짐') : '동작 안 함' }
      }
      case 'push-button':
        return { ...base, kind: 'button', pressed: !!input.pressed, status: input.pressed ? '눌림' : '눌러 보세요' }
      case 'relay-1ch': {
        const s = sig('in')
        const on = ok && !!s && !s.high && !!this.tasksDriving(item, 'in', pins)
        return { ...base, reason: reason ?? codeReason, ok: ok && !codeReason, kind: 'relay', on, status: on ? '붙음 (COM–NO 연결)' : '떨어짐 (COM–NC 연결)' }
      }
      case 'active-buzzer': {
        const on = ok && !!sig('sig')?.high
        return { ...base, reason: reason ?? codeReason, ok: ok && !codeReason, kind: 'buzzer', on, status: on ? '삐— (약 2.3 kHz)' : '조용함' }
      }
      case 'sg90':
      case 'mg90s':
      case 'mg996r':
      case 'fs90r': {
        const fromDriver = this.servoFromDriver(item, t)
        const s = fromDriver ?? sig('signal')
        const angle = ok && s?.servo !== undefined ? s.servo : 90
        const continuous = module.code?.template === 'servo-continuous'
        const spin = continuous && ok && s?.servo !== undefined ? (s.servo - 90) / 90 : 0
        const moving = ok && s?.servo !== undefined
        return {
          ...base,
          reason: reason ?? (moving ? undefined : codeReason),
          ok: ok && moving,
          kind: 'servo',
          angle: continuous ? 90 : angle,
          spin,
          jitter: !!warn,
          status: !moving ? '신호 없음' : continuous ? (spin > 0 ? '정방향 회전' : spin < 0 ? '역방향 회전' : '정지') : `각도 ${angle}°`,
        }
      }
      case 'dc-motor-130':
      case 'dc-gear-tt':
      case 'dc-gear-n20':
      case 'dc-gear-25ga370':
      case 'vibration-motor':
      case 'dc-pump-mini':
      case 'bldc-a2212':
        return this.motorView(item, module, pins, base)
      case 'stepper-28byj48':
      case 'stepper-nema17':
        return this.stepperView(item, pins, base)
      case 'l298n':
      case 'tb6612fng':
      case 'l9110s':
      case 'drv8833':
      case 'uln2003':
      case 'a4988':
      case 'drv8825':
      case 'pca9685': {
        const channels = (module.driver?.channels ?? []).filter((ch) => this.circuit.connections.some((c) => [c.from, c.to].some((e) => e.kind === 'module' && e.instanceId === item.instanceId && ch.outputs.includes(e.pinId))))
        const speeds = channels.map((ch) => ({ label: ch.label, speed: ok ? this.channelSpeed(item, module, ch, pins) : 0 }))
        const leds = item.moduleId === 'uln2003' ? module.driver!.channels[0].inputs.map((pid) => ok && !!sig(pid)?.high) : undefined
        const running = speeds.filter((c) => c.speed !== 0)
        return {
          ...base,
          kind: 'driver',
          channels: speeds,
          leds,
          powerLed: ok || isPinConnected(this.circuit.connections, item.instanceId, module.driver?.supplyPin ?? ''),
          status: !ok ? '동작 안 함' : running.length ? `${running.map((c) => `${c.label} ${c.speed > 0 ? '정' : '역'}방향`).join(' · ')}` : channels.length ? '대기' : '연결된 모터 없음',
        }
      }
      case 'esc-30a': {
        const s = sig('sig')
        const throttle = ok && s?.servo !== undefined ? s.servo / 180 : 0
        return { ...base, kind: 'esc', throttle, armed: ok && s?.servo !== undefined, status: ok && s?.servo !== undefined ? '시동 준비됨 (스로틀 최소)' : '신호 없음' }
      }
      case 'i2c-lcd-1602': {
        const on = ok && !!task
        const sonar = task?.extra.sonar as string | undefined
        const second = t >= 500 ? (sonar ? `dist ${this.sonarCm(sonar).toFixed(1)} cm` : `up ${Math.floor(t / 1000)} s`) : ''
        return { ...base, reason: reason ?? codeReason, ok: on, kind: 'lcd', lines: on ? ['Autoino', second] : ['', ''], backlight: ok, status: on ? 'Autoino 표시 중' : '표시 없음' }
      }
      case 'oled-ssd1306': {
        const on = ok && !!task && t >= 500
        return { ...base, reason: reason ?? codeReason, ok: ok && !!task, kind: 'oled', lines: on ? ['Autoino', String(Math.floor(t / 1000))] : [], status: on ? `${Math.floor(t / 1000)} s` : '표시 없음' }
      }
      case 'tm1637-display': {
        const on = ok && !!task && t >= 1000
        const text = on ? String(Math.floor(t / 1000) % 10000) : ''
        return { ...base, reason: reason ?? codeReason, ok: ok && !!task, kind: 'seg', text, status: on ? `${text} 표시` : '표시 없음' }
      }
      case 'neopixel-strip': {
        const count = Number(item.params.count ?? '8')
        const m = Math.floor(t / 100)
        const lit = ok && task && m >= 1 ? (m - 1) % count : -1
        const colors = Array.from({ length: count }, (_, i) => (i === lit ? 'rgb(0, 0, 255)' : 'off'))
        return { ...base, reason: reason ?? codeReason, ok: ok && !!task, kind: 'pixels', colors, status: lit >= 0 ? `${lit + 1}번 LED 파랑` : '꺼짐' }
      }
      case 'hc-sr04': {
        const cm = this.sonarCm(item.instanceId)
        return { ...base, reason: reason ?? codeReason, ok: ok && !!task, kind: 'sonar', cm, ping: ok && !!task && t % 200 < 60, status: cm < 0 ? '응답 없음' : `거리 ${cm.toFixed(0)} cm` }
      }
      case 'potentiometer':
      case 'ldr-module':
      case 'soil-moisture':
      case 'mq2-gas': {
        const control = behavior!.control as 'value' | 'light' | 'moisture' | 'gas'
        const max = task ? this.adcMax(task) : 1023
        const raw = task ? this.analogRead(task, 'value') : 0
        const amount = control === 'value' ? (input.value ?? 0.5) : control === 'light' ? (input.light ?? 0.5) : control === 'moisture' ? (input.moisture ?? 0.3) : (input.gas ?? 0)
        const heating = item.moduleId === 'mq2-gas' && ok && t < 20000
        return {
          ...base,
          reason: reason ?? codeReason,
          ok: ok && !!task,
          kind: 'gauge',
          control,
          fraction: amount,
          raw,
          max,
          led: ok && control !== 'value' && amount > 0.5,
          heating,
          status: `${heating ? '예열 중 · ' : ''}${task ? `analogRead ${raw}` : '값 읽기 없음'}`,
        }
      }
      case 'joystick-ky023':
        return { ...base, reason: reason ?? codeReason, ok: ok && !!task, kind: 'joystick', x: input.x ?? 0, y: input.y ?? 0, pressed: !!input.pressed, status: task ? `x=${this.analogRead(task, 'x')} y=${this.analogRead(task, 'y')}` : '값 읽기 없음' }
      case 'rotary-encoder':
        return { ...base, reason: reason ?? codeReason, ok: ok && !!task, kind: 'encoder', value: this.encoder.get(item.instanceId) ?? 0, pressed: !!input.pressed, status: `값 ${this.encoder.get(item.instanceId) ?? 0}` }
      case 'dht-sensor':
        return { ...base, reason: reason ?? codeReason, ok: ok && !!task, kind: 'dht', temperature: input.temperature ?? 24, humidity: input.humidity ?? 55, status: `${input.temperature ?? 24} °C · ${input.humidity ?? 55} %` }
      case 'pir-hc-sr501': {
        const out = ok && this.digitalOut(item, t)
        return { ...base, reason: reason ?? codeReason, ok: ok && !!task, kind: 'pir', motion: !!input.motion, out, status: out ? '감지 (OUT HIGH)' : '대기 (OUT LOW)' }
      }
      case 'line-tracker': {
        const out = ok && !!input.onLine
        return { ...base, reason: reason ?? codeReason, ok: ok && !!task, kind: 'line', onLine: !!input.onLine, out, status: input.onLine ? '검은 선 위 (OUT HIGH)' : '흰 바닥 (OUT LOW)' }
      }
      case 'mpu6050':
        return { ...base, reason: reason ?? codeReason, ok: ok && !!task, kind: 'imu', tiltX: input.tiltX ?? 0, tiltY: input.tiltY ?? 0, raw: imuRaw(input), status: `기울기 ${input.tiltX ?? 0}° / ${input.tiltY ?? 0}°` }
      case 'hc-05': {
        const connected = !!input.connected
        const led = ok && (connected ? t % 2000 < 100 || (t % 2000 > 200 && t % 2000 < 300) : t % 200 < 100)
        return { ...base, reason: reason ?? codeReason, ok: ok && !!task, kind: 'bt', connected, led, lastTx: this.btTx.get(item.instanceId) ?? '', lastRx: this.btRx.get(item.instanceId) ?? '', status: connected ? '휴대폰 연결됨' : '연결 대기 (LED 빠르게 깜박임)' }
      }
      case 'rc522-rfid': {
        const tap = this.rfid.get(item.instanceId)
        return { ...base, reason: reason ?? codeReason, ok: ok && !!task, kind: 'rfid', uid: tap?.uid ?? '', flash: !!tap && t - tap.t < 400, status: tap ? `UID ${tap.uid}` : '카드 대기' }
      }
      case 'external-power':
      case 'buck-lm2596':
      case 'mb102-power': {
        const pin = module.pins.find((p) => p.role === 'source')
        const v = pin ? netVoltage(this.circuit, this.netlist, endpointKey(moduleEndpoint(item.instanceId, pin.id))) : null
        const on = item.moduleId === 'external-power' ? true : ok
        return { ...base, ok: on && ok, kind: 'power', on, text: v !== null ? `${v} V` : '', status: on ? (v !== null ? `${v} V 출력` : '출력') : '입력 없음' }
      }
      case 'cd74hc4067': {
        const users = muxUsers(this.circuit, item.instanceId)
        const channels = users.map((u) => {
          const owner = this.circuit.placed.find((p) => u.key.startsWith(`module:${p.instanceId}:`))!
          const role = owner.moduleId === 'joystick-ky023' ? (u.key.endsWith(':vry') ? 'y' : 'x') : 'value'
          const reader = this.tasks.find((x) => x.item === owner)
          return { channel: u.channel, label: owner.label, raw: reader ? this.analogRead(reader, role) : 0 }
        })
        const active = channels.length ? channels[Math.floor(t / 100) % channels.length].channel : -1
        return { ...base, kind: 'mux', channels, active, status: channels.length ? `채널 ${channels.length}개 읽는 중` : '연결된 센서 없음' }
      }
      case 'level-shifter-4ch': {
        const active = [1, 2, 3, 4].map((i) => {
          const s = this.signalAt(pins, item, `lv${i}`) ?? this.signalAt(pins, item, `hv${i}`)
          return ok && !!s?.high
        })
        return { ...base, kind: 'pass', text: 'LV ↔ HV', active, status: ok ? '변환 중' : '동작 안 함' }
      }
      case 'voltage-divider': {
        const [top, bottom] = (item.params.ratio ?? '1k-2k').split('-').map(ohms)
        const vin = this.inputVoltage(item, pins)
        const out = vin === null ? null : Math.round(((vin * bottom) / (top + bottom)) * 100) / 100
        return { ...base, kind: 'pass', text: out === null ? 'IN 없음' : `${vin} V → ${out} V`, active: [vin !== null && vin > 0], status: out === null ? '입력 없음' : `OUT ${out} V` }
      }
    }
    return { ...base, kind: 'power', on: ok, text: '', status: ok ? '동작' : '동작 안 함' }
  }

  /** 핀 공유로 다른 부품 코드를 따라가는 부품인지 */
  protected mirrored(item: PlacedModule): boolean {
    return getModule(item.moduleId)
      .pins.filter((p) => p.role === 'signal')
      .some((p) => !!shareOf(this.circuit, endpointKey(moduleEndpoint(item.instanceId, p.id))))
  }

  protected tasksDriving(item: PlacedModule, pinId: string, pins: Map<string, PinOut>): boolean {
    const route = routeToBoard(this.circuit, item.instanceId, pinId, this.traced)
    return !!route && pins.has(`${route.boardInstanceId}:${route.pinId}`)
  }

  protected inputVoltage(item: PlacedModule, pins: Map<string, PinOut>): number | null {
    const v = netVoltage(this.circuit, this.netlist, endpointKey(moduleEndpoint(item.instanceId, 'in')))
    if (v !== null) return v
    const s = this.signalAt(pins, item, 'in')
    const route = routeToBoard(this.circuit, item.instanceId, 'in', this.traced)
    const board = route && boardDefOf(this.circuit, route.boardInstanceId)
    return s && board ? (s.high ? board.logicVoltage : 0) : null
  }

  /** 서보가 서보 드라이버 채널에 물려 있으면 그 채널의 펄스 */
  protected servoFromDriver(servo: PlacedModule, t: number): PinOut | null {
    for (const task of this.tasks) {
      if (task.template !== 'pca9685') continue
      for (const [, s] of task.extra.servos as Map<number, PlacedModule>) {
        if (s !== servo || !this.healthOf(task.item.instanceId).ok) continue
        const template = getModule(s.moduleId).code?.template ?? 'servo'
        return { high: true, duty: 0, servo: this.servoAngle(template, t) }
      }
    }
    return null
  }

  /** 드라이버 채널 출력 (−1 역방향 … 1 정방향). 입력 핀 신호로 진리표를 따른다 */
  protected channelSpeed(driver: PlacedModule, module: Module, ch: NonNullable<Module['driver']>['channels'][number], pins: Map<string, PinOut>): number {
    const sig = (pinId: string) => this.signalAt(pins, driver, pinId)
    const spec = module.code
    if (spec?.template === 'h-bridge') {
      if (spec.standbyPin && !sig(spec.standbyPin)?.high) return 0
      if (spec.scheme === 'en-in1-in2') {
        const [en, a, b] = ch.inputs.map(sig)
        const duty = en ? en.duty : 0
        return a?.high && !b?.high ? duty : !a?.high && b?.high ? -duty : 0
      }
      const [a, b] = ch.inputs.map(sig)
      return (a?.duty ?? 0) - (b?.duty ?? 0)
    }
    if (spec?.template === 'stepper-coils') return ch.inputs.some((pid) => sig(pid)?.high) ? 1 : 0
    if (spec?.template === 'step-dir') {
      const step = sig(spec.pins!.step)?.step
      return step ? (sig(spec.pins!.dir)?.high ? 1 : -1) : 0
    }
    return 0
  }

  protected motorView(item: PlacedModule, module: Module, pins: Map<string, PinOut>, base: Health): ModuleView {
    const behavior = BEHAVIOR[item.moduleId]
    const style = behavior?.style ?? 'wheel'
    const link = motorDriverOf(this.circuit, item)
    const stop = (reason?: string): ModuleView => ({ ...base, ok: !reason && base.ok, reason: reason ?? base.reason, kind: 'motor', speed: 0, rpm: 0, style, status: reason ? '멈춤' : '정지' })
    if (!base.ok) return stop(base.reason)
    if (!link) return stop('모터 드라이버에 연결되지 않았습니다')
    const dh = this.healthOf(link.driver.instanceId)
    if (!dh.ok) return stop(`${link.driver.label}: ${dh.reason}`)
    const dmod = getModule(link.driver.moduleId)
    const supply = netVoltage(this.circuit, this.netlist, endpointKey(moduleEndpoint(link.driver.instanceId, dmod.driver!.supplyPin)))
    if (supply === null) return stop(`${link.driver.label} 모터 전원(${dmod.driver!.supplyPin.toUpperCase()})이 없습니다`)
    let speed: number
    if (item.moduleId === 'bldc-a2212') {
      const s = this.signalAt(pins, link.driver, dmod.code?.pins?.signal ?? 'sig')
      speed = s?.servo !== undefined ? s.servo / 180 : 0
    } else speed = this.channelSpeed(link.driver, dmod, link.channel, pins)
    const volts = Math.max(0, supply - (dmod.driver?.dropVoltage ?? 0)) * Math.abs(speed)
    const rpm = Math.round(((behavior?.rpm ?? 100) * volts) / (behavior?.ratedVolts ?? module.motor?.nominalVoltage ?? 6))
    const status = speed === 0 ? (item.moduleId === 'bldc-a2212' ? '정지 (스로틀 최소)' : '정지') : `${speed > 0 ? '정방향' : '역방향'} · ${style === 'pump' ? `약 ${Math.round((behavior?.flow ?? 1) * (volts / (module.motor?.nominalVoltage ?? 5)) * 10) / 10} L/분` : `약 ${rpm} rpm`}`
    return { ...base, kind: 'motor', speed, rpm, style, status }
  }

  protected stepperView(item: PlacedModule, pins: Map<string, PinOut>, base: Health): ModuleView {
    const behavior = BEHAVIOR[item.moduleId]!
    const link = motorDriverOf(this.circuit, item)
    const idle = (reason?: string): ModuleView => ({ ...base, ok: !reason && base.ok, reason: reason ?? base.reason, kind: 'stepper', angle: 0, rpm: 0, forward: true, status: '멈춤' })
    if (!base.ok) return idle(base.reason)
    if (!link) return idle('스테퍼 드라이버에 연결되지 않았습니다')
    const dh = this.healthOf(link.driver.instanceId)
    if (!dh.ok) return idle(`${link.driver.label}: ${dh.reason}`)
    const dmod = getModule(link.driver.moduleId)
    if (netVoltage(this.circuit, this.netlist, endpointKey(moduleEndpoint(link.driver.instanceId, dmod.driver!.supplyPin))) === null) return idle(`${link.driver.label} 모터 전원이 없습니다`)
    const steps = behavior.stepsPerRev!
    if (dmod.code?.template === 'stepper-coils') {
      const s = this.signalAt(pins, link.driver, dmod.driver!.channels[0].inputs[0])
      const n = s?.step?.count ?? 0
      return { ...base, kind: 'stepper', angle: ((n % steps) * 360) / steps, rpm: s?.step ? Math.round((((1000 / 3) * 60) / steps) * 10) / 10 : 0, forward: true, status: s?.step ? `정방향 · 약 ${Math.round(((1000 / 3) * 60) / steps)} rpm` : '정지' }
    }
    const s = this.signalAt(pins, link.driver, dmod.code!.pins!.step)
    const n = s?.step?.count ?? 0
    const segment = Math.floor(n / 200)
    const r = n % 200
    const position = segment % 2 === 0 ? r : 200 - r
    const forward = s?.step?.forward ?? true
    return { ...base, kind: 'stepper', angle: (position * 360) / steps, rpm: s?.step ? Math.round((500 * 60) / steps) : 0, forward, status: s?.step ? `${forward ? '정방향' : '역방향'} · ${Math.round((500 * 60) / steps)} rpm (200 스텝마다 전환)` : '정지' }
  }
}

const POLL: Record<string, number> = {
  button: 20,
  ladder: 20,
  'digital-read': 50,
  'analog-read': 500,
  joystick: 200,
  dht: 2000,
  'hc-sr04': 200,
  mpu6050: 200,
  'serial-module': 2000,
  rc522: 200,
}

/** 오류지만 실물은 일단 돌아가는 것 (과전압·과전류): 시뮬레이션에서는 움직이며 경고한다 */
export const RUNS_ANYWAY = new Set(['motor-overvoltage', 'driver-overcurrent', 'driver-peak'])

/** 경고 중 카드에 보여 줄 것 */
const WARN_CODES = new Set(['board-power-warning', 'undervoltage-supply', 'usb-budget', 'pin-shared-current', 'motor-undervoltage', 'driver-undervoltage'])

export function ohms(text: string): number {
  const m = text.match(/^(\d+)([kKmM]?)(\d*)$/)
  if (!m) return 1
  const mult = m[2] === '' ? 1 : m[2].toLowerCase() === 'k' ? 1e3 : 1e6
  return Number(`${m[1]}.${m[3] || 0}`) * mult
}

/** MPU-6050 가속도 원시값 (±2 g, 16384 LSB/g) */
export function imuRaw(input: SimInput): [number, number, number] {
  const x = ((input.tiltX ?? 0) * Math.PI) / 180
  const y = ((input.tiltY ?? 0) * Math.PI) / 180
  return [Math.round(16384 * Math.sin(y)), Math.round(16384 * Math.sin(x)), Math.round(16384 * Math.cos(x) * Math.cos(y))]
}
