import { getModule } from '../../data/modules'
import type { Board, Module, PlacedModule } from '../../types'
import { boardKindOf, analogNumbers, type BoardKind } from '../arduino/core'
import type { DhtDevice, Host, I2cSlaveHandlers, LcdDevice, Machine, OledDevice, PinModeName, PixelDevice, RfidDevice, SegDevice, SerialPort } from '../arduino/machine'
import { boardDefOf, type Circuit } from '../circuit'
import { endpointKey, moduleEndpoint, parseEndpointKey } from '../connections'
import { isGroundPin } from '../electrical'
import { muxChannelOf } from '../mux'
import type { Netlist } from '../netlist'
import { routeToBoard } from '../paths'
import { netVoltage } from '../power'
import { computeLadderResistors } from '../shares'
import { BEHAVIOR, type SimInput } from './behavior'

// 코드 시뮬레이션의 하드웨어: 보드 핀 상태, 배선을 따라 부품이 보드 핀에 주는 신호,
// UART · I²C · SPI 버스, 라이브러리가 쓰는 장치(LCD·OLED·NeoPixel …)를 만든다.

/** 신호원: 전압과 내부 저항 (0 이면 강하게 끌어 줌) */
export interface Drive {
  v: number
  r: number
}

export interface PinState {
  mode: PinModeName | null
  out: boolean
  /** analogWrite 듀티 (0–1) */
  pwm: number | null
  /** 서보 펄스 (µs) */
  servoUs: number | null
  toneHz: number | null
  changedAt: number
}

export interface Health {
  ok: boolean
  reason?: string
  warn?: string
}

const PULLUP_OHMS = 35000
const STRONG = 25

/** 엔코더: 사람이 한 칸 돌리면 CLK·DT 가 차례로 바뀐다 */
interface EncoderModel {
  phase: number
  queue: { at: number; phase: number }[]
  detents: number
}

/** 초음파: 트리거 뒤 에코가 HIGH 인 구간 */
interface SonarModel {
  windows: { start: number; end: number }[]
  triggerHighAt: number | null
  lastPing: number
}

/** 스테퍼 회전자 */
export interface StepperModel {
  /** 전기각(°) 누적 */
  elec: number
  /** 코일에 처음 전류가 흐르기 전 (회전자가 첫 자기장 쪽으로 붙는다) */
  fresh: boolean
  /** 아직 반영하지 않은 코일 상태 (핀을 하나씩 바꾸는 중간 상태는 건너뛴다) */
  pending: { phi: number | null; at: number } | null
  /** STEP/DIR 스텝 수 */
  steps: number
  lastStepAt: number
  recent: number[]
  forward: boolean
  shakeAt: number
  stallAt: number
}

export interface UartLink {
  board: BoardHw
  port: UartPort
}

export class UartPort implements SerialPort {
  baud = 0
  begun = false
  readonly rx: { at: number; b: number }[] = []
  readonly name: string
  rxPin: string | null
  txPin: string | null
  readonly usb: boolean
  private readonly board: BoardHw
  constructor(board: BoardHw, name: string, rxPin: string | null, txPin: string | null, usb: boolean) {
    this.board = board
    this.name = name
    this.rxPin = rxPin
    this.txPin = txPin
    this.usb = usb
  }
  begin(baud: number, _us: number, pins?: { rx: string | null; tx: string | null }) {
    this.baud = baud
    this.begun = true
    if (pins) {
      if (pins.rx) this.rxPin = pins.rx
      if (pins.tx) this.txPin = pins.tx
    }
  }
  write(bytes: number[], us: number) {
    this.board.hw.uartSend(this.board, this, bytes, us)
  }
  available(us: number) {
    let n = 0
    for (const x of this.rx) if (x.at <= us) n++
    return Math.min(n, 64)
  }
  read(us: number) {
    const x = this.rx[0]
    if (!x || x.at > us) return -1
    this.rx.shift()
    return x.b
  }
  peek(us: number) {
    const x = this.rx[0]
    return x && x.at <= us ? x.b : -1
  }
  nextArrival(us: number) {
    const x = this.rx.find((r) => r.at > us)
    return x ? x.at : Infinity
  }
  /** 바이트 받기 (보율이 다르면 깨진 글자) */
  receive(bytes: number[], baud: number, at: number) {
    const per = baud > 0 ? 10_000_000 / baud : 100
    bytes.forEach((b, i) => this.rx.push({ at: at + per * (i + 1), b: this.baud && baud && Math.abs(this.baud - baud) / this.baud > 0.05 ? garble(b) : b }))
    if (this.rx.length > 256) this.rx.splice(0, this.rx.length - 256)
  }
}

/** 보율이 맞지 않을 때 받는 엉뚱한 바이트 */
function garble(b: number): number {
  return ((b * 37 + 91) & 0x7f) | 0x80
}

/** 보드 하나 (스케치가 보는 하드웨어) */
export class BoardHw implements Host {
  readonly instanceId: string
  readonly def: Board
  readonly kind: BoardKind
  readonly boardLabel: string
  readonly logicVoltage: number
  readonly hw: CircuitHw
  readonly pins = new Map<string, PinState>()
  /** 코드가 건드린 핀 */
  readonly touched = new Set<string>()
  readonly ports = new Map<string, UartPort>()
  readonly softPorts: UartPort[] = []
  readonly warnings: { line: number; message: string }[] = []
  readonly irqs = new Map<string, { fn: () => void; mode: string; last: boolean }>()
  i2cSlaveAddress: number | null = null
  i2cHandlers: I2cSlaveHandlers | null = null
  spiHandler: ((b: number) => number) | null = null
  m: Machine | null = null
  /** 마지막으로 시리얼 송신한 시각 (µs) */
  lastTx = -1e12
  private readonly numToId = new Map<number, string>()
  private readonly analogToId = new Map<number, string>()

  constructor(hw: CircuitHw, instanceId: string, def: Board, label: string) {
    this.hw = hw
    this.instanceId = instanceId
    this.def = def
    this.boardLabel = label
    this.kind = boardKindOf(def.id)
    this.logicVoltage = def.logicVoltage
    for (const pin of def.pins) {
      if (pin.group !== 'digital' && pin.group !== 'analog') continue
      if (this.kind === 'esp32') {
        if (pin.gpio !== undefined) {
          this.numToId.set(pin.gpio, pin.id)
          if (pin.capabilities.includes('analog')) this.analogToId.set(pin.gpio, pin.id)
        }
        continue
      }
      const d = /^D(\d+)$/.exec(pin.id)
      if (d) this.numToId.set(Number(d[1]), pin.id)
    }
    if (this.kind !== 'esp32') {
      for (const [name, n] of Object.entries(analogNumbers(this.kind))) {
        if (!def.pins.some((p) => p.id === name)) continue
        this.numToId.set(n, name)
        this.analogToId.set(n, name)
        this.analogToId.set(Number(name.slice(1)), name)
      }
    }
    for (const bus of def.buses) {
      if (bus.kind !== 'UART') continue
      const name = bus.name.split(' ')[0]
      const rx = bus.pins.find((p) => p.role === 'RX')?.pinId ?? null
      const tx = bus.pins.find((p) => p.role === 'TX')?.pinId ?? null
      this.ports.set(name, new UartPort(this, name, rx, tx, name === 'Serial'))
    }
    if (this.kind === 'esp32' && !this.ports.has('Serial1')) this.ports.set('Serial1', new UartPort(this, 'Serial1', null, null, false))
  }

  state(pinId: string): PinState {
    let s = this.pins.get(pinId)
    if (!s) {
      s = { mode: null, out: false, pwm: null, servoUs: null, toneHz: null, changedAt: 0 }
      this.pins.set(pinId, s)
    }
    return s
  }

  // ---------------------------------------------------------- Host: 핀

  pinId(n: number): string | null {
    return this.numToId.get(n) ?? null
  }
  analogPinId(n: number): string | null {
    return this.analogToId.get(n) ?? null
  }
  isPwm(pinId: string): boolean {
    if (!this.def.pwmPins.includes(pinId) && this.kind !== 'esp32') return false
    if (this.m?.state.servoAttached && this.def.servoPwmConflictPins.includes(pinId)) {
      this.m.warn(`Servo 라이브러리를 쓰는 동안 ${pinId} 에서는 analogWrite(PWM) 가 동작하지 않습니다`)
      return false
    }
    return true
  }
  pinMode(pinId: string, mode: PinModeName, us: number) {
    this.touched.add(pinId)
    const pin = this.def.pins.find((p) => p.id === pinId)
    if (mode === 'OUTPUT' && pin?.restrictions?.some((r) => r.kind === 'input-only')) this.m?.warn(`${pinId} 은(는) 입력 전용 핀이라 OUTPUT 으로 쓸 수 없습니다`)
    const s = this.state(pinId)
    s.mode = mode
    s.changedAt = us
    this.hw.pinChanged(this, pinId, us)
  }
  digitalWrite(pinId: string, high: boolean, us: number) {
    this.touched.add(pinId)
    const s = this.state(pinId)
    s.pwm = null
    if (s.mode !== 'OUTPUT' && this.kind !== 'esp32') {
      // AVR: 입력 모드에서 HIGH 를 쓰면 내부 풀업이 켜진다
      if (s.mode === null || s.mode === 'INPUT' || s.mode === 'INPUT_PULLUP') s.mode = high ? 'INPUT_PULLUP' : 'INPUT'
      if (high) this.m?.warn(`pinMode(${pinId.replace(/^D/, '')}, OUTPUT) 없이 digitalWrite 했습니다. 내부 풀업만 켜져 LED 가 아주 흐리게 켜집니다`)
    }
    if (s.out === high) return
    s.out = high
    s.changedAt = us
    this.hw.pinChanged(this, pinId, us)
  }
  digitalRead(pinId: string, us: number): boolean {
    this.touched.add(pinId)
    return this.hw.levelAt(this, pinId, us)
  }
  analogRead(pinId: string, us: number): number {
    this.touched.add(pinId)
    return this.hw.voltsAt(this, pinId, us)
  }
  analogWrite(pinId: string, duty: number, us: number) {
    this.touched.add(pinId)
    const s = this.state(pinId)
    s.mode = 'OUTPUT'
    const before = s.pwm
    s.pwm = duty <= 0 ? null : duty >= 1 ? null : duty
    const high = duty > 0
    if (s.out !== high || before !== s.pwm) {
      s.out = high
      s.changedAt = us
      this.hw.pinChanged(this, pinId, us)
    }
  }
  servo(pinId: string, pulseUs: number | null, us: number) {
    this.touched.add(pinId)
    const s = this.state(pinId)
    s.servoUs = pulseUs
    s.mode = 'OUTPUT'
    s.changedAt = us
  }
  tone(pinId: string, hz: number | null, us: number) {
    this.touched.add(pinId)
    const s = this.state(pinId)
    s.toneHz = hz
    s.changedAt = us
  }
  pulseIn(pinId: string, high: boolean, timeoutUs: number, us: number) {
    this.touched.add(pinId)
    return this.hw.pulseIn(this, pinId, high, timeoutUs, us)
  }
  attachInterrupt(pinId: string, fn: () => void, mode: string) {
    this.touched.add(pinId)
    this.irqs.set(pinId, { fn, mode, last: this.hw.levelAt(this, pinId, this.m?.us ?? 0) })
  }
  detachInterrupt(pinId: string) {
    this.irqs.delete(pinId)
  }
  poll(us: number): (() => void)[] {
    const out: (() => void)[] = []
    for (const [pinId, irq] of this.irqs) {
      const level = this.hw.levelAt(this, pinId, us)
      if (level === irq.last) continue
      irq.last = level
      if (irq.mode === 'CHANGE' || (irq.mode === 'RISING' && level) || (irq.mode === 'FALLING' && !level) || (irq.mode === 'LOW' && !level) || (irq.mode === 'HIGH' && level)) out.push(irq.fn)
    }
    return out
  }
  nextEvent(us: number): number {
    let next = Infinity
    for (const pinId of this.irqs.keys()) next = Math.min(next, this.hw.nextEdge(this, pinId, us))
    return next
  }
  connect(m: Machine) {
    this.m = m
  }

  // ---------------------------------------------------------- Host: 시리얼

  serial(name: string): SerialPort | null {
    return this.ports.get(name) ?? null
  }
  softSerial(rx: string | null, tx: string | null): SerialPort {
    if (rx) this.touched.add(rx)
    if (tx) this.touched.add(tx)
    const p = new UartPort(this, 'SoftwareSerial', rx, tx, false)
    this.softPorts.push(p)
    return p
  }

  // ---------------------------------------------------------- Host: I²C · SPI

  i2cBegin(slaveAddress: number | null, handlers?: I2cSlaveHandlers) {
    for (const id of this.busPins('I2C')) this.touched.add(id)
    this.i2cSlaveAddress = slaveAddress
    this.i2cHandlers = slaveAddress !== null ? (handlers ?? null) : null
  }
  i2cWrite(address: number, bytes: number[], us: number): number {
    const dev = this.hw.i2cDevice(this, address)
    if (!dev) return 2
    dev.write(bytes, us)
    return 0
  }
  i2cRead(address: number, count: number, us: number): number[] {
    const dev = this.hw.i2cDevice(this, address)
    if (!dev) return []
    return dev.read(count, us)
  }
  spiTransfer(byte: number, us: number): number {
    for (const id of this.busPins('SPI')) this.touched.add(id)
    return this.hw.spiTransfer(this, byte, us)
  }
  spiSlave(handler: ((byte: number) => number) | null) {
    this.spiHandler = handler
  }

  /** 버스의 보드 핀 (I2C: SDA, SCL / SPI: SS, MOSI, MISO, SCK) */
  busPins(kind: 'I2C' | 'SPI'): string[] {
    const bus = this.def.buses.find((b) => b.kind === kind)
    return bus ? bus.pins.map((p) => p.pinId) : []
  }
  busPin(kind: 'I2C' | 'SPI', role: string): string | null {
    return this.def.buses.find((b) => b.kind === kind)?.pins.find((p) => p.role === role)?.pinId ?? null
  }

  // ---------------------------------------------------------- Host: 장치

  pixels(pinId: string): PixelDevice | null {
    this.touched.add(pinId)
    return this.hw.pixelsOn(this, pinId)
  }
  seg(clk: string, dio: string): SegDevice | null {
    this.touched.add(clk)
    this.touched.add(dio)
    return this.hw.segOn(this, clk, dio)
  }
  lcd(address: number): LcdDevice | null {
    for (const id of this.busPins('I2C')) this.touched.add(id)
    return this.hw.lcdAt(this, address)
  }
  oled(address: number): OledDevice | null {
    for (const id of this.busPins('I2C')) this.touched.add(id)
    return this.hw.oledAt(this, address)
  }
  dht(pinId: string): DhtDevice | null {
    this.touched.add(pinId)
    return this.hw.dhtOn(this, pinId)
  }
  rfid(ss: string): RfidDevice | null {
    this.touched.add(ss)
    for (const id of this.busPins('SPI')) this.touched.add(id)
    return this.hw.rfidOn(this, ss)
  }
  storage(name: string, size: number): number[] {
    return this.hw.storage(`${this.instanceId}:${name}`, size)
  }
  random() {
    return Math.random()
  }
  warn(message: string, line: number) {
    if (this.warnings.some((w) => w.message === message)) return
    this.warnings.push({ line, message })
    if (this.warnings.length > 40) this.warnings.shift()
  }

  /** 보드 핀이 지금 내보내는 신호 (보드 쪽만) */
  ownDrive(pinId: string): Drive | null {
    const s = this.pins.get(pinId)
    if (!s) return null
    if (s.mode === 'OUTPUT') return { v: s.out ? this.logicVoltage : 0, r: STRONG }
    if (s.mode === 'INPUT_PULLUP') return { v: this.logicVoltage, r: PULLUP_OHMS }
    if (s.mode === 'INPUT_PULLDOWN') return { v: 0, r: PULLUP_OHMS }
    return null
  }
}

/** I²C 장치 */
interface I2cDev {
  write(bytes: number[], us: number): void
  read(count: number, us: number): number[]
}

/** 회로 전체의 하드웨어 */
export class CircuitHw {
  readonly circuit: Circuit
  readonly netlist: Netlist
  readonly traced: Netlist
  readonly boards = new Map<string, BoardHw>()
  readonly inputs: Map<string, SimInput>
  readonly health: Map<string, Health>
  /** 보드 핀 → 그 핀에 신호를 주는 부품 핀 */
  private readonly drivers = new Map<string, { item: PlacedModule; module: Module; pinId: string }[]>()
  /** 보드 핀 → 같은 넷의 다른 보드 핀 */
  private readonly boardPeers = new Map<string, { board: string; pinId: string }[]>()
  /** 보드 핀 → 핀이 바뀔 때 할 일 (스테퍼·초음파 트리거) */
  private readonly watchers = new Map<string, ((us: number) => void)[]>()
  readonly encoders = new Map<string, EncoderModel>()
  readonly sonars = new Map<string, SonarModel>()
  readonly steppers = new Map<string, StepperModel>()
  readonly lcds = new Map<string, LcdDevice>()
  readonly oleds = new Map<string, OledDevice>()
  readonly pixelColors = new Map<string, string[]>()
  readonly segs = new Map<string, { segments: number[]; brightness: number; on: boolean }>()
  readonly pca = new Map<string, { regs: number[]; ptr: number }>()
  readonly mpuRegs = new Map<string, { regs: number[]; ptr: number }>()
  readonly rfidTaps = new Map<string, { uid: number[]; consumed: boolean; at: number }>()
  /** 휴대폰 ↔ 블루투스 모듈 */
  readonly btTx = new Map<string, string>()
  readonly btRx = new Map<string, string>()
  readonly motionUntil = new Map<string, number>()
  private readonly ladder: ReturnType<typeof computeLadderResistors>
  private readonly saved = new Map<string, number[]>()
  /** 시리얼 모니터로 나가는 바이트 */
  onMonitor: (board: string, bytes: number[], us: number) => void = () => {}
  /** 지금 시각 (µs, 사람 입력의 기준) */
  now = 0

  constructor(circuit: Circuit, netlist: Netlist, traced: Netlist, inputs: Map<string, SimInput>, health: Map<string, Health>, saved?: Map<string, number[]>) {
    this.circuit = circuit
    this.netlist = netlist
    this.traced = traced
    this.inputs = inputs
    this.health = health
    this.ladder = computeLadderResistors(circuit)
    if (saved) this.saved = saved
    for (const b of circuit.boards) {
      const def = boardDefOf(circuit, b.instanceId)
      if (def) this.boards.set(b.instanceId, new BoardHw(this, b.instanceId, def, b.label))
    }
    // 부품 핀 → 보드 핀
    for (const item of circuit.placed) {
      const module = getModule(item.moduleId)
      for (const pin of module.pins) {
        if (pin.role !== 'signal' && pin.role !== 'passive') continue
        const route = routeToBoard(circuit, item.instanceId, pin.id, traced)
        if (!route) continue
        const key = `${route.boardInstanceId}:${route.pinId}`
        const list = this.drivers.get(key) ?? []
        list.push({ item, module, pinId: pin.id })
        this.drivers.set(key, list)
      }
      if (item.moduleId === 'rotary-encoder') this.encoders.set(item.instanceId, { phase: 0, queue: [], detents: 0 })
      if (item.moduleId === 'hc-sr04') {
        this.sonars.set(item.instanceId, { windows: [], triggerHighAt: null, lastPing: -1e12 })
        this.watchModulePin(item, 'trig', (us) => this.sonarTrigger(item, us))
      }
      if (item.moduleId === 'mpu6050') this.mpuRegs.set(item.instanceId, { regs: mpuDefaults(), ptr: 0 })
      if (item.moduleId === 'pca9685') this.pca.set(item.instanceId, { regs: pcaDefaults(), ptr: 0 })
    }
    // 보드 핀끼리 (보드 간 배선)
    for (const members of traced.members.values()) {
      const boardPins = members.map(parseEndpointKey).filter((e): e is Extract<NonNullable<ReturnType<typeof parseEndpointKey>>, { kind: 'board' }> => e?.kind === 'board')
      if (boardPins.length < 2) continue
      for (const a of boardPins) {
        const key = `${a.boardInstanceId}:${a.pinId}`
        this.boardPeers.set(
          key,
          boardPins.filter((b) => b !== a).map((b) => ({ board: b.boardInstanceId, pinId: b.pinId })),
        )
      }
    }
  }

  healthOf(id: string): Health {
    return this.health.get(id) ?? { ok: false }
  }

  input(id: string): SimInput {
    return this.inputs.get(id) ?? {}
  }

  storage(key: string, size: number): number[] {
    let s = this.saved.get(key)
    if (!s || s.length !== size) {
      s = Array(size).fill(255)
      this.saved.set(key, s)
    }
    return s
  }

  /** 부품 핀이 이어진 보드 핀 */
  routeOf(item: PlacedModule, pinId: string): { board: BoardHw; pinId: string } | null {
    const r = routeToBoard(this.circuit, item.instanceId, pinId, this.traced)
    const board = r && this.boards.get(r.boardInstanceId)
    return board ? { board, pinId: r.pinId } : null
  }

  private watchModulePin(item: PlacedModule, pinId: string, fn: (us: number) => void) {
    const r = this.routeOf(item, pinId)
    if (!r) return
    const key = `${r.board.instanceId}:${r.pinId}`
    this.watchers.set(key, [...(this.watchers.get(key) ?? []), fn])
  }

  /** 스테퍼가 따라갈 보드 핀을 등록 (CodeRuntime 이 부른다) */
  watch(item: PlacedModule, pinId: string, fn: (us: number) => void) {
    this.watchModulePin(item, pinId, fn)
  }

  // ---------------------------------------------------------- 신호

  /** 보드 핀이 바뀌었을 때: 감시자 실행, 다른 보드의 인터럽트 확인 */
  pinChanged(board: BoardHw, pinId: string, us: number) {
    for (const fn of this.watchers.get(`${board.instanceId}:${pinId}`) ?? []) fn(us)
    for (const peer of this.boardPeers.get(`${board.instanceId}:${pinId}`) ?? []) {
      const other = this.boards.get(peer.board)
      if (other?.irqs.has(peer.pinId) && other.m) other.m.irqPending = true
    }
  }

  /** 부품이 신호를 바꿨을 때 (사람 입력): 그 부품이 이어진 보드의 인터럽트 확인 */
  moduleChanged(instanceId: string) {
    for (const [key, list] of this.drivers) {
      if (!list.some((d) => d.item.instanceId === instanceId)) continue
      const [boardId, pinId] = splitKey(key)
      const board = this.boards.get(boardId)
      if (board?.irqs.has(pinId) && board.m) board.m.irqPending = true
    }
  }

  /** 보드 핀마다의 신호원 목록 (자주 읽으므로 보드별로 캐시) */
  private readonly pinCache = new Map<BoardHw, Map<string, { drivers: { item: PlacedModule; module: Module; pinId: string }[]; peers: { board: string; pinId: string }[] }>>()
  private sourcesOf(board: BoardHw, pinId: string) {
    let byPin = this.pinCache.get(board)
    if (!byPin) {
      byPin = new Map()
      this.pinCache.set(board, byPin)
    }
    let x = byPin.get(pinId)
    if (!x) {
      const key = `${board.instanceId}:${pinId}`
      x = { drivers: this.drivers.get(key) ?? [], peers: this.boardPeers.get(key) ?? [] }
      byPin.set(pinId, x)
    }
    return x
  }

  /** 보드 핀의 전압 (V) */
  voltsAt(board: BoardHw, pinId: string, us: number): number {
    const drives: Drive[] = []
    const own = board.ownDrive(pinId)
    if (own) drives.push(own)
    const src = this.sourcesOf(board, pinId)
    for (const d of src.drivers) {
      const x = this.moduleDrive(d.item, d.module, d.pinId, us, board, pinId)
      if (x) drives.push(x)
    }
    for (const peer of src.peers) {
      const x = this.boards.get(peer.board)?.ownDrive(peer.pinId)
      if (x && x.r === STRONG) drives.push(x)
    }
    if (!drives.length) return floating(us, pinId) * board.logicVoltage
    // 강한 신호원이 있으면 그것들만, 아니면 저항 분배
    const strong = drives.filter((d) => d.r <= STRONG)
    const used = strong.length ? strong : drives
    let g = 0
    let i = 0
    for (const d of used) {
      const gi = 1 / Math.max(d.r, 1)
      g += gi
      i += d.v * gi
    }
    return i / g
  }

  levelAt(board: BoardHw, pinId: string, us: number): boolean {
    const s = board.pins.get(pinId)
    if (s?.mode === 'OUTPUT') return s.out
    return this.voltsAt(board, pinId, us) >= board.logicVoltage * 0.5
  }

  /** 부품 핀이 보드 쪽으로 주는 신호 */
  private moduleDrive(item: PlacedModule, module: Module, pinId: string, us: number, board: BoardHw, boardPin: string): Drive | null {
    const h = this.healthOf(item.instanceId)
    const input = this.input(item.instanceId)
    const vcc = this.supplyOf(item, module)
    const id = item.moduleId
    if (id === 'push-button') return this.buttonDrive(item, pinId, board, boardPin)
    if (!h.ok) return null
    const level = (high: boolean): Drive => ({ v: high ? vcc : 0, r: 100 })
    const analog = (fraction: number): Drive => ({ v: Math.max(0, Math.min(1, fraction)) * vcc, r: 1000 })
    switch (id) {
      case 'potentiometer':
        return pinId === 'wiper' ? { v: (input.value ?? 0.5) * vcc, r: 2500 } : null
      case 'ldr-module':
        return pinId === 'ao' ? analog(1 - (input.light ?? 0.5)) : pinId === 'do' ? level((input.light ?? 0.5) < 0.5) : null
      case 'soil-moisture':
        return pinId === 'ao' ? analog(1 - 0.7 * (input.moisture ?? 0.3)) : pinId === 'do' ? level((input.moisture ?? 0.3) < 0.5) : null
      case 'mq2-gas':
        return pinId === 'ao' ? analog(0.1 + 0.8 * (input.gas ?? 0)) : pinId === 'do' ? level((input.gas ?? 0) <= 0.5) : null
      case 'joystick-ky023':
        if (pinId === 'vrx') return analog(((input.x ?? 0) + 1) / 2)
        if (pinId === 'vry') return analog(((input.y ?? 0) + 1) / 2)
        if (pinId === 'sw') return input.pressed ? { v: 0, r: 0 } : null
        return null
      case 'rotary-encoder': {
        if (pinId === 'sw') return input.pressed ? { v: 0, r: 0 } : null
        const phase = this.encoderPhase(item.instanceId, us)
        // 위상 0: CLK=1 DT=1 → 시계 방향은 CLK 가 먼저 떨어진다
        const clk = phase === 0 || phase === 3
        const dt = phase === 0 || phase === 1
        return { v: (pinId === 'clk' ? clk : dt) ? vcc : 0, r: (pinId === 'clk' ? clk : dt) ? 10000 : 0 }
      }
      case 'pir-hc-sr501':
        return pinId === 'out' ? level(!!input.motion || (this.motionUntil.get(item.instanceId) ?? -1) > us / 1000) : null
      case 'line-tracker':
        return pinId === 'out' ? level(!!input.onLine) : pinId === 'ao' ? analog(input.onLine ? 0.85 : 0.15) : null
      case 'hc-sr04':
        return pinId === 'echo' ? level(this.echoHigh(item.instanceId, us)) : null
      case 'dht-sensor':
        return pinId === 'data' ? { v: vcc, r: 10000 } : null
      case 'hc-05':
        if (pinId === 'txd') return { v: vcc >= 3.3 ? 3.3 : vcc, r: 100 }
        if (pinId === 'state') return level(!!input.connected)
        return null
      case 'cd74hc4067':
        return pinId === 'sig' ? this.muxDrive(item, module, us) : null
    }
    return null
  }

  private readonly supplyCache = new Map<string, number>()
  /** 부품 전원 전압 (전원이 없으면 5 V 로 본다) */
  private supplyOf(item: PlacedModule, module: Module): number {
    let v = this.supplyCache.get(item.instanceId)
    if (v === undefined) {
      const pin = module.pins.find((p) => p.role === 'power')
      v = (pin ? netVoltage(this.circuit, this.netlist, endpointKey(moduleEndpoint(item.instanceId, pin.id))) : null) ?? 5
      this.supplyCache.set(item.instanceId, v)
    }
    return v
  }

  /** 버튼: 누르면 반대쪽 단자의 넷(GND·전원·사다리 저항)이 보드 핀으로 이어진다 */
  private buttonDrive(item: PlacedModule, pinId: string, board: BoardHw, boardPin: string): Drive | null {
    if (!this.input(item.instanceId).pressed) return null
    const side1 = pinId === 'pin1a' || pinId === 'pin1b'
    const other = side1 ? ['pin2a', 'pin2b'] : ['pin1a', 'pin1b']
    const rung = this.ladder.find((l) => l.instanceId === item.instanceId && l.boardInstanceId === board.instanceId && l.boardPinId === boardPin)
    for (const p of other) {
      const key = endpointKey(moduleEndpoint(item.instanceId, p))
      const members = this.netlist.members.get(this.netlist.netOf(key)) ?? []
      if (members.some((k) => this.isGroundKey(k))) return { v: 0, r: rung?.ohms ?? 0 }
      const v = netVoltage(this.circuit, this.netlist, key)
      if (v !== null) return { v, r: rung?.ohms ?? 0 }
      // 다른 보드 핀
      for (const k of members) {
        const e = parseEndpointKey(k)
        if (e?.kind !== 'board') continue
        const d = this.boards.get(e.boardInstanceId)?.ownDrive(e.pinId)
        if (d) return d
      }
    }
    return null
  }

  private isGroundKey(key: string): boolean {
    const e = parseEndpointKey(key)
    if (!e) return false
    if (e.kind === 'board') {
      const def = boardDefOf(this.circuit, e.boardInstanceId)
      return !!def && isGroundPin(def, e.pinId)
    }
    const item = this.circuit.placed.find((p) => p.instanceId === e.instanceId)
    return !!item && getModule(item.moduleId).pins.find((p) => p.id === e.pinId)?.role === 'ground'
  }

  /** 멀티플렉서: 선택선으로 고른 채널의 신호가 SIG 로 나간다 */
  private muxDrive(mux: PlacedModule, module: Module, us: number): Drive | null {
    const spec = module.mux!
    let channel = 0
    spec.select.forEach((pin, bit) => {
      const r = this.routeOf(mux, pin)
      if (r && this.levelAt(r.board, r.pinId, us)) channel |= 1 << bit
    })
    const enRoute = this.routeOf(mux, 'en')
    if (enRoute && this.levelAt(enRoute.board, enRoute.pinId, us)) return null
    const chPin = spec.channels[channel]
    const key = endpointKey(moduleEndpoint(mux.instanceId, chPin))
    const members = this.netlist.members.get(this.netlist.netOf(key)) ?? []
    for (const k of members) {
      const e = parseEndpointKey(k)
      if (e?.kind !== 'module' || e.instanceId === mux.instanceId) continue
      const item = this.circuit.placed.find((p) => p.instanceId === e.instanceId)
      if (!item) continue
      const d = this.moduleDrive(item, getModule(item.moduleId), e.pinId, us, this.boards.values().next().value!, '')
      if (d) return { v: d.v, r: d.r + 70 }
    }
    return null
  }

  /** 지금 멀티플렉서가 고른 채널 */
  muxChannel(mux: PlacedModule, us: number): number {
    const spec = getModule(mux.moduleId).mux!
    let channel = 0
    spec.select.forEach((pin, bit) => {
      const r = this.routeOf(mux, pin)
      if (r && this.levelAt(r.board, r.pinId, us)) channel |= 1 << bit
    })
    return channel
  }

  // ---------------------------------------------------------- 엔코더

  rotate(instanceId: string, dir: 1 | -1) {
    const enc = this.encoders.get(instanceId)
    if (!enc) return
    const last = enc.queue.at(-1)?.at ?? this.now
    let at = Math.max(this.now, last)
    let phase = enc.queue.at(-1)?.phase ?? enc.phase
    for (let i = 0; i < 4; i++) {
      at += 1500
      phase = (phase + (dir > 0 ? 1 : 3)) & 3
      enc.queue.push({ at, phase })
    }
    enc.detents += dir
    this.moduleChanged(instanceId)
  }

  private encoderPhase(instanceId: string, us: number): number {
    const enc = this.encoders.get(instanceId)
    if (!enc) return 0
    while (enc.queue.length && enc.queue[0].at <= us) enc.phase = enc.queue.shift()!.phase
    return enc.phase
  }

  // ---------------------------------------------------------- 초음파

  private sonarTrigger(item: PlacedModule, us: number) {
    const s = this.sonars.get(item.instanceId)!
    const r = this.routeOf(item, 'trig')
    if (!r) return
    const high = r.board.pins.get(r.pinId)?.out ?? false
    if (high) {
      s.triggerHighAt = us
      return
    }
    if (s.triggerHighAt === null) return
    const width = us - s.triggerHighAt
    s.triggerHighAt = null
    if (width < 8 || !this.healthOf(item.instanceId).ok) return
    if (s.windows.some((w) => w.end > us)) return // 측정 중에는 새 트리거를 무시
    const cm = this.input(item.instanceId).distance ?? 30
    const echo = cm >= 2 && cm <= 400 ? Math.round(cm * 58.3) : 38000
    const start = us + 460
    s.windows.push({ start, end: start + echo })
    s.lastPing = us
    if (s.windows.length > 8) s.windows.shift()
  }

  private echoHigh(instanceId: string, us: number): boolean {
    const s = this.sonars.get(instanceId)
    return !!s?.windows.some((w) => w.start <= us && us < w.end)
  }

  pulseIn(board: BoardHw, pinId: string, high: boolean, timeout: number, us: number): { width: number; end: number } {
    const deadline = us + timeout
    const sonar = (this.drivers.get(`${board.instanceId}:${pinId}`) ?? []).find((d) => d.item.moduleId === 'hc-sr04' && d.pinId === 'echo')
    if (sonar && high) {
      const s = this.sonars.get(sonar.item.instanceId)!
      const w = s.windows.find((x) => x.start >= us)
      if (!w || w.start > deadline) return { width: 0, end: deadline }
      return { width: w.end - w.start, end: w.end + 2 }
    }
    // 바뀌는 신호가 없으면 제한 시간까지 기다린다
    return { width: 0, end: deadline }
  }

  nextEdge(board: BoardHw, pinId: string, us: number): number {
    let next = Infinity
    for (const d of this.drivers.get(`${board.instanceId}:${pinId}`) ?? []) {
      if (d.item.moduleId === 'rotary-encoder') {
        const enc = this.encoders.get(d.item.instanceId)
        const at = enc?.queue.find((q) => q.at > us)?.at
        if (at !== undefined) next = Math.min(next, at)
      }
      if (d.item.moduleId === 'hc-sr04') {
        const s = this.sonars.get(d.item.instanceId)
        for (const w of s?.windows ?? []) for (const t of [w.start, w.end]) if (t > us) next = Math.min(next, t)
      }
    }
    return next
  }

  // ---------------------------------------------------------- UART

  /** 보드 TX 핀에서 나간 바이트를 받는 곳 (모니터, 블루투스 모듈, 다른 보드) */
  uartSend(board: BoardHw, port: UartPort, bytes: number[], us: number) {
    if (!port.begun && port.usb) board.m?.warn(`${port.name}.begin(속도) 를 먼저 불러야 시리얼로 보낼 수 있습니다`)
    board.lastTx = us
    if (port.usb) this.onMonitor(board.instanceId, bytes, us)
    if (!port.txPin) return
    for (const d of this.drivers.get(`${board.instanceId}:${port.txPin}`) ?? []) {
      if (d.item.moduleId === 'hc-05' && d.pinId === 'rxd' && this.healthOf(d.item.instanceId).ok) {
        const text = port.baud && Math.abs(port.baud - 9600) / 9600 > 0.05 ? bytes.map(garble) : bytes
        const prev = this.btTx.get(d.item.instanceId) ?? ''
        this.btTx.set(d.item.instanceId, (prev + new TextDecoder().decode(new Uint8Array(text))).slice(-200))
        if (port.baud && Math.abs(port.baud - 9600) / 9600 > 0.05) board.m?.warn(`HC-05 의 기본 통신 속도는 9600 baud 입니다 (코드는 ${port.baud})`)
      }
    }
    for (const peer of this.boardPeers.get(`${board.instanceId}:${port.txPin}`) ?? []) {
      const other = this.boards.get(peer.board)
      if (!other) continue
      for (const p of [...other.ports.values(), ...other.softPorts]) if (p.rxPin === peer.pinId && p.begun) p.receive(bytes, port.baud, us)
    }
  }

  /** 휴대폰에서 블루투스 모듈로 보낸 글자 → 모듈 TXD 가 이어진 보드 포트 */
  sendBluetooth(instanceId: string, text: string) {
    const item = this.circuit.placed.find((p) => p.instanceId === instanceId)
    if (!item || !this.healthOf(instanceId).ok || !this.input(instanceId).connected) return
    this.btRx.set(instanceId, text)
    const r = this.routeOf(item, 'txd')
    if (!r) return
    const bytes = Array.from(new TextEncoder().encode(`${text}\n`))
    for (const p of [...r.board.ports.values(), ...r.board.softPorts]) if (p.rxPin === r.pinId) p.receive(bytes, 9600, r.board.m?.us ?? this.now)
  }

  /** 시리얼 모니터에서 보드로 */
  sendSerial(boardId: string, text: string) {
    const b = this.boards.get(boardId)
    const port = b?.ports.get('Serial')
    if (port) port.receive(Array.from(new TextEncoder().encode(text)), port.baud || 9600, b!.m?.us ?? this.now)
  }

  // ---------------------------------------------------------- I²C

  /** 이 보드의 I²C 버스에 있는 모듈 */
  i2cModules(board: BoardHw): PlacedModule[] {
    const sda = board.busPin('I2C', 'SDA')
    const scl = board.busPin('I2C', 'SCL')
    if (!sda || !scl) return []
    // 버스는 넷으로 본다: 다른 보드와 함께 쓰는 I²C 선에 물린 장치도 이 보드에서 보인다
    const onNet = (item: PlacedModule, pin: string, boardPin: string) => this.traced.netOf(endpointKey(moduleEndpoint(item.instanceId, pin))) === this.traced.netOf(`board:${board.instanceId}:${boardPin}`)
    return this.circuit.placed.filter((item) => !!getModule(item.moduleId).i2cAddress && onNet(item, 'sda', sda) && onNet(item, 'scl', scl))
  }

  i2cDevice(board: BoardHw, address: number): I2cDev | null {
    for (const item of this.i2cModules(board)) {
      const module = getModule(item.moduleId)
      if (parseInt(module.i2cAddress!, 16) !== address || !this.healthOf(item.instanceId).ok) continue
      const regs = item.moduleId === 'mpu6050' ? this.mpuRegs.get(item.instanceId) : item.moduleId === 'pca9685' ? this.pca.get(item.instanceId) : undefined
      if (item.moduleId === 'mpu6050' && regs) this.updateMpu(item, regs.regs)
      if (!regs) return { write: () => undefined, read: (n) => Array(n).fill(0) }
      return {
        write: (bytes) => {
          if (!bytes.length) return
          regs.ptr = bytes[0]
          for (let i = 1; i < bytes.length; i++) regs.regs[regs.ptr++ & 0xff] = bytes[i] & 0xff
        },
        read: (n) => Array.from({ length: n }, () => regs.regs[regs.ptr++ & 0xff] ?? 0),
      }
    }
    // 다른 보드 (I²C 주변장치)
    const sda = board.busPin('I2C', 'SDA')
    for (const peer of sda ? (this.boardPeers.get(`${board.instanceId}:${sda}`) ?? []) : []) {
      const other = this.boards.get(peer.board)
      if (!other || other.i2cSlaveAddress !== address || !other.i2cHandlers || other.busPin('I2C', 'SDA') !== peer.pinId) continue
      const handlers = other.i2cHandlers
      return {
        write: (bytes) => handlers.receive(bytes),
        read: (n) => {
          const reply = handlers.request()
          return Array.from({ length: n }, (_, i) => reply[i] ?? 0xff)
        },
      }
    }
    return null
  }

  private updateMpu(item: PlacedModule, regs: number[]) {
    const input = this.input(item.instanceId)
    const sleeping = (regs[0x6b] & 0x40) !== 0
    const range = (regs[0x1c] >> 3) & 3
    const lsb = [16384, 8192, 4096, 2048][range]
    const x = ((input.tiltX ?? 0) * Math.PI) / 180
    const y = ((input.tiltY ?? 0) * Math.PI) / 180
    const vals = sleeping ? [0, 0, 0, 0, 0, 0, 0] : [Math.round(lsb * Math.sin(y)), Math.round(lsb * Math.sin(x)), Math.round(lsb * Math.cos(x) * Math.cos(y)), Math.round((25 - 36.53) * 340), 0, 0, 0]
    vals.forEach((v, i) => {
      const u = v < 0 ? v + 0x10000 : v
      regs[0x3b + 2 * i] = (u >> 8) & 0xff
      regs[0x3b + 2 * i + 1] = u & 0xff
    })
  }

  /** PCA9685 채널의 펄스 폭 (µs). 꺼져 있으면 null */
  pcaPulse(item: PlacedModule, channel: number): number | null {
    const dev = this.pca.get(item.instanceId)
    if (!dev || !this.healthOf(item.instanceId).ok) return null
    const r = dev.regs
    if (r[0] & 0x10) return null
    const base = 0x06 + 4 * channel
    const on = r[base] | ((r[base + 1] & 0x1f) << 8)
    const off = r[base + 2] | ((r[base + 3] & 0x1f) << 8)
    if (off & 0x1000) return null
    const period = ((r[0xfe] + 1) * 4096) / 25 // µs (내부 25 MHz)
    const ticks = on & 0x1000 ? 4096 : (off - on + 4096) % 4096
    return (ticks / 4096) * period
  }

  /** 같은 주소의 장치가 여러 개면 모두 같은 명령을 받는다 (같은 화면) */
  private sharedDevice<T>(board: BoardHw, moduleId: string, address: number, store: Map<string, T>, make: () => T): T | null {
    const items = this.i2cModules(board).filter((i) => i.moduleId === moduleId && parseInt(getModule(i.moduleId).i2cAddress!, 16) === address && this.healthOf(i.instanceId).ok)
    if (!items.length) return null
    const dev = items.map((i) => store.get(i.instanceId)).find((d) => d !== undefined) ?? make()
    for (const i of items) store.set(i.instanceId, dev)
    return dev
  }

  lcdAt(board: BoardHw, address: number): LcdDevice | null {
    return this.sharedDevice(board, 'i2c-lcd-1602', address, this.lcds, () => ({ cols: 16, rows: 2, chars: [Array(16).fill(' '), Array(16).fill(' ')], backlight: false, on: false }))
  }

  oledAt(board: BoardHw, address: number): OledDevice | null {
    return this.sharedDevice(board, 'oled-ssd1306', address, this.oleds, () => ({ width: 128, height: 64, pixels: new Uint8Array(128 * 64), texts: [], inverted: false, on: false, frame: 0 }))
  }

  // ---------------------------------------------------------- SPI

  spiTransfer(board: BoardHw, byte: number, us: number): number {
    const mosi = board.busPin('SPI', 'MOSI')
    for (const peer of mosi ? (this.boardPeers.get(`${board.instanceId}:${mosi}`) ?? []) : []) {
      const other = this.boards.get(peer.board)
      if (!other?.spiHandler) continue
      const ss = other.busPin('SPI', 'SS')
      if (!ss || this.levelAt(other, ss, us)) continue // 선택되지 않음 (SS HIGH)
      return other.spiHandler(byte)
    }
    return 0
  }

  rfidOn(board: BoardHw, ss: string): RfidDevice | null {
    const item = (this.drivers.get(`${board.instanceId}:${ss}`) ?? []).find((d) => d.item.moduleId === 'rc522-rfid' && d.pinId === 'sda')?.item
    if (!item || !this.healthOf(item.instanceId).ok) return null
    const spiOk = (['sck', 'mosi', 'miso'] as const).every((p) => this.routeOf(item, p)?.pinId === board.busPin('SPI', p.toUpperCase()))
    if (!spiOk) {
      board.m?.warn('RC522 의 SCK·MOSI·MISO 가 보드의 SPI 핀에 이어져 있지 않습니다')
      return null
    }
    return {
      newCard: () => {
        const tap = this.rfidTaps.get(item.instanceId)
        if (!tap || tap.consumed) return null
        tap.consumed = true
        return tap.uid
      },
      halt: () => undefined,
      version: () => 0x92,
    }
  }

  tapCard(instanceId: string, uid: number[]) {
    this.rfidTaps.set(instanceId, { uid, consumed: false, at: this.now })
  }

  // ---------------------------------------------------------- 단일 선 장치

  pixelsOn(board: BoardHw, pinId: string): PixelDevice | null {
    const items = (this.drivers.get(`${board.instanceId}:${pinId}`) ?? []).filter((d) => d.item.moduleId === 'neopixel-strip' && d.pinId === 'din').map((d) => d.item)
    if (!items.length) return null
    return {
      show: (colors) => {
        for (const item of items) {
          if (!this.healthOf(item.instanceId).ok) continue
          const count = Number(item.params.count ?? '8')
          const prev = this.pixelColors.get(item.instanceId) ?? Array(count).fill('off')
          const next = prev.slice(0, count)
          for (let i = 0; i < count && i < colors.length; i++) {
            const c = colors[i]
            const r = (c >> 16) & 255
            const g = (c >> 8) & 255
            const b = c & 255
            next[i] = r || g || b ? `rgb(${r}, ${g}, ${b})` : 'off'
          }
          this.pixelColors.set(item.instanceId, next)
        }
      },
    }
  }

  segOn(board: BoardHw, clk: string, dio: string): SegDevice | null {
    const items = (this.drivers.get(`${board.instanceId}:${clk}`) ?? []).filter((d) => d.item.moduleId === 'tm1637-display' && d.pinId === 'clk').map((d) => d.item)
    const item = items.find((i) => this.routeOf(i, 'dio')?.pinId === dio)
    if (!item) {
      if (items.length) board.m?.warn('TM1637 의 CLK·DIO 핀 번호가 배선과 반대이거나 다릅니다')
      return null
    }
    return {
      show: (segments, brightness, on) => {
        if (this.healthOf(item.instanceId).ok) this.segs.set(item.instanceId, { segments, brightness, on })
      },
    }
  }

  dhtOn(board: BoardHw, pinId: string): DhtDevice | null {
    const item = (this.drivers.get(`${board.instanceId}:${pinId}`) ?? []).find((d) => d.item.moduleId === 'dht-sensor')?.item
    if (!item) return null
    const kind = item.params.model === 'DHT22' ? 22 : 11
    const dev: DhtDevice & { kind: number } = {
      kind,
      read: () => {
        if (!this.healthOf(item.instanceId).ok) return null
        const input = this.input(item.instanceId)
        return { temperature: input.temperature ?? 24, humidity: input.humidity ?? 55 }
      },
    }
    return dev
  }
}

function splitKey(key: string): [string, string] {
  const i = key.lastIndexOf(':')
  return [key.slice(0, i), key.slice(i + 1)]
}

/** 떠 있는 입력: 천천히 흔들리는 값 (0–1) */
function floating(us: number, pinId: string): number {
  let h = 0
  for (const c of pinId) h = (h * 31 + c.charCodeAt(0)) | 0
  const t = us / 1000
  return 0.45 + 0.35 * Math.sin(t / 37 + h) * Math.sin(t / 11 + h * 0.7)
}

function mpuDefaults(): number[] {
  const r = Array(256).fill(0)
  r[0x75] = 0x68
  r[0x6b] = 0x40
  return r
}

function pcaDefaults(): number[] {
  const r = Array(256).fill(0)
  r[0x00] = 0x11
  r[0xfe] = 0x1e
  return r
}

export { BEHAVIOR, muxChannelOf }
