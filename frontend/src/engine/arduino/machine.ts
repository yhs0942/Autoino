import type { CType, Platform } from './ctypes'

// 실행 기계: 가상 시간·실행 예산과, 하드웨어(보드 핀·버스·장치)와의 접점

export type PinModeName = 'INPUT' | 'OUTPUT' | 'INPUT_PULLUP' | 'INPUT_PULLDOWN'

/** 시리얼 포트 (USB 시리얼, 하드웨어 UART, SoftwareSerial) */
export interface SerialPort {
  begin(baud: number, us: number, pins?: { rx: string | null; tx: string | null }): void
  write(bytes: number[], us: number): void
  available(us: number): number
  read(us: number): number
  peek(us: number): number
  /** 다음 바이트가 도착하는 시각 (없으면 Infinity) */
  nextArrival(us: number): number
}

export interface LcdDevice {
  cols: number
  rows: number
  chars: string[][]
  backlight: boolean
  on: boolean
}

export interface OledText {
  x: number
  y: number
  size: number
  text: string
  color: number
  bg: number | null
}

export interface OledDevice {
  width: number
  height: number
  /** 화면 버퍼 (1 = 켜진 픽셀) */
  pixels: Uint8Array
  texts: OledText[]
  inverted: boolean
  on: boolean
  /** display() 할 때마다 늘어난다 */
  frame: number
}

export interface PixelDevice {
  /** 테이프가 실제로 보여 주는 색 0xRRGGBB (밝기·색 순서 반영) */
  show(colors: number[], us: number): void
}

export interface SegDevice {
  show(segments: number[], brightness: number, on: boolean): void
}

export interface DhtDevice {
  read(us: number): { temperature: number; humidity: number } | null
}

export interface RfidDevice {
  /** 새로 댄 카드의 UID (없으면 null) */
  newCard(us: number): number[] | null
  /** 지금 대고 있는 카드 (PICC_HaltA 후에도 다시 읽을 수 있는지) */
  halt(): void
  version(): number
}

export interface I2cSlaveHandlers {
  receive: (bytes: number[]) => void
  request: () => number[]
}

export interface Host {
  boardLabel: string
  /** 숫자 핀 번호 → 보드 핀 ID */
  pinId(n: number): string | null
  /** analogRead(n) 의 n → 보드 핀 ID (AVR 은 0–7 을 A0–A7 로 본다) */
  analogPinId(n: number): string | null
  isPwm(pinId: string): boolean
  pinMode(pinId: string, mode: PinModeName, us: number): void
  digitalWrite(pinId: string, high: boolean, us: number): void
  digitalRead(pinId: string, us: number): boolean
  /** 핀 전압 (V) */
  analogRead(pinId: string, us: number): number
  /** 보드 로직 전압 (ADC 기본 기준 전압) */
  logicVoltage: number
  analogWrite(pinId: string, duty: number, us: number): void
  servo(pinId: string, pulseUs: number | null, us: number): void
  tone(pinId: string, hz: number | null, us: number): void
  /** level 이 될 때까지 기다렸다가 그 펄스 길이(µs). 제한 시간 안에 없으면 width 0 */
  pulseIn(pinId: string, high: boolean, timeoutUs: number, us: number): { width: number; end: number }
  attachInterrupt(pinId: string, fn: () => void, mode: 'RISING' | 'FALLING' | 'CHANGE' | 'LOW' | 'HIGH'): void
  detachInterrupt(pinId: string): void
  serial(name: string): SerialPort | null
  softSerial(rx: string | null, tx: string | null): SerialPort
  i2cBegin(slaveAddress: number | null, handlers?: I2cSlaveHandlers): void
  i2cWrite(address: number, bytes: number[], us: number): number
  i2cRead(address: number, count: number, us: number): number[]
  spiTransfer(byte: number, us: number): number
  spiSlave(handler: ((byte: number) => number) | null): void
  pixels(pinId: string): PixelDevice | null
  seg(clkPinId: string, dioPinId: string): SegDevice | null
  lcd(address: number): LcdDevice | null
  oled(address: number): OledDevice | null
  dht(pinId: string): DhtDevice | null
  rfid(ssPinId: string): RfidDevice | null
  /** 이 시각까지 생긴 인터럽트 (엔코더 펄스·버튼 등) */
  poll(us: number): (() => void)[]
  /** 다음 하드웨어 사건 시각 (없으면 Infinity) */
  nextEvent(us: number): number
  /** 이 프로그램을 돌리는 기계 (인터럽트 알림용) */
  connect(m: Machine): void
  /** 보드에 남는 저장 공간 (EEPROM) */
  storage(name: string, size: number): number[]
  /** 0–1 난수 */
  random(): number
  warn(message: string, line: number): void
}

export class Machine {
  /** 가상 시간 (µs) */
  us = 0
  /** 이번에 이 시각까지 돌린다 */
  target = 0
  /** 이번에 실행할 문장 수 */
  budget = 0
  /** 문장 하나에 드는 가상 시간 (µs) */
  cost: number
  /** 다음 하드웨어 사건 시각 (엔코더 펄스 등) */
  nextEvent = Infinity
  /** 처리할 인터럽트가 있는지 */
  irqPending = false
  irqEnabled = true
  inIsr = false
  /** 인터럽트·콜백 함수 이름 → 실행 (Program 이 정한다) */
  callbacks = new Map<unknown, (args?: unknown[]) => void>()
  /** 함수 반환값 */
  rv: unknown = undefined
  /** 위치 계산의 키 (배열 첨자·구조체 멤버 이름) */
  lk: number | string = 0
  /** 지금 실행 중인 줄 */
  line = 0
  readonly host: Host
  readonly p: Platform
  /** 인터럽트 처리 (Program 이 정한다) */
  service: () => void = () => {}
  /** 정해진 시각에 할 일 (tone 지속 시간 등) */
  readonly timers: { at: number; fn: () => void }[] = []
  /** 보드별 상태 (analogReadResolution, randomSeed 등) */
  readonly state: Record<string, unknown> = {}
  private readonly warned = new Set<string>()

  constructor(host: Host, p: Platform) {
    this.host = host
    this.p = p
    this.cost = p.core === 'avr' ? 1 : 0.5
  }

  after(at: number, fn: () => void): void {
    this.timers.push({ at, fn })
    if (at < this.nextEvent) this.nextEvent = at
  }

  warn(message: string): void {
    if (this.warned.has(message)) return
    this.warned.add(message)
    this.host.warn(message, this.line)
  }

  /** 반복·대기 지점: 예산을 다 썼거나 목표 시각이면 양보, 인터럽트 처리 */
  shouldYield(): boolean {
    if (this.irqPending || this.us >= this.nextEvent) this.service()
    return !this.inIsr && (this.us >= this.target || this.budget <= 0)
  }
}

export type Gen<T = unknown> = Generator<number, T, void>

/** 내장 함수 */
export interface BuiltinFn {
  ret: CType | ((args: CType[], p: Platform) => CType)
  min?: number
  max?: number
  call?: (m: Machine, args: unknown[], types: CType[]) => unknown
  /** 기다리는 함수 (delay 등) */
  gen?: (m: Machine, args: unknown[], types: CType[]) => Gen
  /** 이 보드 코어에서만 */
  core?: 'avr' | 'esp32'
  /** 값을 바꾸는 인자: 위치(주소)로 넘긴다 */
  refArgs?: number[]
  /** 인자 개수가 맞지 않을 때 알려 줄 예 */
  usage?: string
}

export interface MethodDef extends Omit<BuiltinFn, 'call' | 'gen'> {
  call?: (m: Machine, self: unknown, args: unknown[], types: CType[]) => unknown
  gen?: (m: Machine, self: unknown, args: unknown[], types: CType[]) => Gen
}

export interface ClassDef {
  name: string
  /** 이 클래스를 쓰려면 필요한 헤더 */
  header: string
  ctorMin?: number
  ctorMax?: number
  construct: (m: Machine, args: unknown[], types: CType[]) => object
  methods: Record<string, MethodDef>
  /** 객체의 멤버 변수 (예: mfrc522.uid) */
  fields?: Record<string, CType>
  /** 클래스 범위 상수 (예: AccelStepper::DRIVER) */
  statics?: Record<string, { t: CType; v: unknown }>
  /** 클래스 범위 형 (예: MFRC522::PICC_Type) */
  types?: Record<string, CType>
  /** obj[i] (예: EEPROM[0]) */
  index?: { t: CType; container: (self: unknown) => unknown[] }
}

export interface Registry {
  functions: Map<string, BuiltinFn>
  constants: Map<string, { t: CType; v: unknown }>
  classes: Map<string, ClassDef>
  /** 미리 있는 객체 (Serial, Wire …) */
  objects: Map<string, { cls: string; make: (m: Machine) => object }>
  /** 형 이름 별칭 (예: sensors_event_t → 구조체) */
  types: Map<string, CType>
  /** 미리 있는 전역 변수 (AVR 레지스터 SPDR 등) */
  globals?: Map<string, { t: CType; v: unknown }>
}
