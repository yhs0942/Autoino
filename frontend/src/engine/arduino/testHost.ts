import type { Host, I2cSlaveHandlers, Machine, PinModeName, SerialPort } from './machine'

// 테스트용 가짜 보드: 핀 상태와 시리얼 출력을 기록한다

export class FakePort implements SerialPort {
  out: number[] = []
  inbox: { at: number; b: number }[] = []
  baud = 0
  begin(baud: number) {
    this.baud = baud
  }
  write(bytes: number[]) {
    this.out.push(...bytes)
  }
  available(us: number) {
    return this.inbox.filter((x) => x.at <= us).length
  }
  read(us: number) {
    const i = this.inbox.findIndex((x) => x.at <= us)
    if (i < 0) return -1
    return this.inbox.splice(i, 1)[0].b
  }
  peek(us: number) {
    return this.inbox.find((x) => x.at <= us)?.b ?? -1
  }
  nextArrival(us: number) {
    const next = this.inbox.filter((x) => x.at > us).map((x) => x.at)
    return next.length ? Math.min(...next) : Infinity
  }
  text(): string {
    return new TextDecoder().decode(new Uint8Array(this.out))
  }
  send(text: string, at = 0) {
    for (const b of new TextEncoder().encode(text)) this.inbox.push({ at, b })
  }
}

export class FakeHost implements Host {
  boardLabel = '보드 1'
  logicVoltage = 5
  readonly modes = new Map<string, PinModeName>()
  readonly levels = new Map<string, boolean>()
  readonly duty = new Map<string, number>()
  readonly servos = new Map<string, number | null>()
  readonly tones = new Map<string, number | null>()
  /** 핀 쓰기 기록 [시각, 핀, 값] */
  readonly writes: [number, string, boolean][] = []
  readonly inputs = new Map<string, boolean>()
  readonly analog = new Map<string, number>()
  readonly serialPort = new FakePort()
  readonly warnings: string[] = []
  readonly i2c = new Map<number, { regs: number[]; ptr: number }>()
  readonly irqs = new Map<string, { fn: () => void; mode: string }>()
  pendingIrq: (() => void)[] = []
  m: Machine | null = null
  readonly kind: 'avr' | 'esp32'
  constructor(kind: 'avr' | 'esp32' = 'avr') {
    this.kind = kind
    if (kind === 'esp32') this.logicVoltage = 3.3
  }
  pinId(n: number) {
    if (this.kind === 'esp32') return n >= 0 && n <= 39 ? `GPIO${n}` : null
    if (n >= 0 && n <= 13) return `D${n}`
    if (n >= 14 && n <= 21) return `A${n - 14}`
    return null
  }
  analogPinId(n: number) {
    if (this.kind === 'esp32') return this.pinId(n)
    if (n >= 0 && n <= 7) return `A${n}`
    if (n >= 14 && n <= 21) return `A${n - 14}`
    return null
  }
  isPwm(id: string) {
    return ['D3', 'D5', 'D6', 'D9', 'D10', 'D11'].includes(id) || this.kind === 'esp32'
  }
  pinMode(id: string, mode: PinModeName) {
    this.modes.set(id, mode)
  }
  digitalWrite(id: string, high: boolean, us: number) {
    this.levels.set(id, high)
    this.duty.set(id, high ? 1 : 0)
    this.writes.push([us, id, high])
  }
  digitalRead(id: string) {
    if (this.inputs.has(id)) return this.inputs.get(id)!
    if (this.modes.get(id) === 'INPUT_PULLUP') return true
    return this.levels.get(id) ?? false
  }
  analogRead(id: string) {
    return this.analog.get(id) ?? 0
  }
  analogWrite(id: string, duty: number) {
    this.duty.set(id, duty)
    this.levels.set(id, duty > 0)
  }
  servo(id: string, us: number | null) {
    this.servos.set(id, us)
  }
  tone(id: string, hz: number | null) {
    this.tones.set(id, hz)
  }
  pulseIn(_id: string, _high: boolean, timeout: number, us: number) {
    return { width: 1160, end: us + 1160 + 500 + Math.min(0, timeout) }
  }
  attachInterrupt(id: string, fn: () => void, mode: string) {
    this.irqs.set(id, { fn, mode })
  }
  detachInterrupt(id: string) {
    this.irqs.delete(id)
  }
  readonly ports = new Map<string, FakePort>()
  serial(name: string) {
    if (name === 'Serial') return this.serialPort
    if (!this.ports.has(name)) this.ports.set(name, new FakePort())
    return this.ports.get(name)!
  }
  softSerial() {
    return new FakePort()
  }
  i2cBegin(_addr: number | null, _h?: I2cSlaveHandlers) {}
  i2cWrite(addr: number, bytes: number[]) {
    const dev = this.i2c.get(addr)
    if (!dev) return 2
    if (bytes.length) {
      dev.ptr = bytes[0]
      for (let i = 1; i < bytes.length; i++) dev.regs[dev.ptr++] = bytes[i]
    }
    return 0
  }
  i2cRead(addr: number, n: number) {
    const dev = this.i2c.get(addr)
    if (!dev) return []
    return Array.from({ length: n }, () => dev.regs[dev.ptr++] ?? 0)
  }
  spiTransfer(b: number) {
    return b
  }
  spiSlave() {}
  pixels() {
    return null
  }
  seg() {
    return null
  }
  lcd() {
    return null
  }
  oled() {
    return null
  }
  dht() {
    return null
  }
  rfid() {
    return null
  }
  poll() {
    const out = this.pendingIrq
    this.pendingIrq = []
    return out
  }
  nextEvent() {
    return Infinity
  }
  connect(m: Machine) {
    this.m = m
  }
  storage(_name: string, size: number) {
    return Array(size).fill(255)
  }
  random() {
    return 0.5
  }
  warn(message: string) {
    this.warnings.push(message)
  }
  /** 입력 핀을 바꾸고 인터럽트를 일으킨다 */
  setInput(id: string, high: boolean) {
    const before = this.digitalRead(id)
    this.inputs.set(id, high)
    const irq = this.irqs.get(id)
    if (irq && before !== high && (irq.mode === 'CHANGE' || (irq.mode === 'RISING' && high) || (irq.mode === 'FALLING' && !high))) {
      this.pendingIrq.push(irq.fn)
      if (this.m) this.m.irqPending = true
    }
  }
}
