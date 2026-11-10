import { Compiler, type CompiledProgram, type FnInfo } from './compiler'
import { coreRegistry, type BoardInfo } from './core'
import { AVR, ESP32, type Platform } from './ctypes'
import { CompileError, NOOP_HEADERS, preprocess } from './lexer'
import { libraryRegistry } from './libs'
import { Machine, type Gen, type Host, type Registry } from './machine'
import { BASIC_TYPE_NAMES, Parser } from './parser'
import { RuntimeErr } from './values'

// 스케치 하나를 컴파일하고 가상 시간으로 실행한다

export interface Diagnostic {
  line: number
  message: string
}

export type ProgramState = 'ready' | 'running' | 'error' | 'stopped'

function predefined(board: BoardInfo): Record<string, string> {
  if (board.core === 'esp32') return { ARDUINO: '10819', ESP32: '1', ARDUINO_ARCH_ESP32: '1', ARDUINO_ESP32_DEV: '1', ESP_PLATFORM: '1', F_CPU: '240000000L' }
  const common = { ARDUINO: '10819', ARDUINO_ARCH_AVR: '1', __AVR__: '1', F_CPU: '16000000L' }
  if (board.kind === 'mega') return { ...common, ARDUINO_AVR_MEGA2560: '1', __AVR_ATmega2560__: '1' }
  if (board.kind === 'nano') return { ...common, ARDUINO_AVR_NANO: '1', __AVR_ATmega328P__: '1' }
  return { ...common, ARDUINO_AVR_UNO: '1', __AVR_ATmega328P__: '1' }
}

function mergeRegistry(a: Registry, b: Partial<Registry>): Registry {
  if (b.globals) {
    a.globals ??= new Map()
    for (const [k, v] of b.globals) a.globals.set(k, v)
  }
  for (const key of ['functions', 'constants', 'classes', 'objects', 'types'] as const) {
    const src = b[key] as Map<string, never> | undefined
    if (src) for (const [k, v] of src) (a[key] as Map<string, never>).set(k, v)
  }
  return a
}

/** 컴파일만 (오류·경고 확인) */
export interface CompileResult {
  errors: Diagnostic[]
  warnings: Diagnostic[]
  includes: string[]
}

export class Program {
  readonly m: Machine
  readonly errors: Diagnostic[] = []
  readonly warnings: Diagnostic[] = []
  readonly includes: string[] = []
  state: ProgramState = 'ready'
  /** 실행 중 오류 */
  fault: Diagnostic | null = null
  private compiled: CompiledProgram | null = null
  private main: Gen | null = null
  private readonly host: Host

  constructor(source: string, host: Host, board: BoardInfo) {
    const p: Platform = board.core === 'avr' ? AVR : ESP32
    this.host = host
    this.m = new Machine(host, p)
    try {
      const pre = preprocess(source, predefined(board))
      const headers = pre.includes.map((i) => i.name)
      this.includes.push(...headers)
      const reg = coreRegistry(board, p)
      const libs = libraryRegistry(headers, board, p)
      for (const missing of libs.unknown) {
        const at = pre.includes.find((i) => i.name === missing)
        this.errors.push({ line: at?.line ?? 1, message: `시뮬레이터가 지원하지 않는 라이브러리입니다: ${missing}` })
      }
      for (const w of libs.notes) {
        const at = pre.includes.find((i) => i.name === w.header)
        this.warnings.push({ line: at?.line ?? 1, message: w.message })
      }
      if (this.errors.length) {
        this.state = 'error'
        return
      }
      mergeRegistry(reg, libs.registry)
      const typeNames = [...BASIC_TYPE_NAMES, ...reg.classes.keys(), ...reg.types.keys()]
      for (const cls of reg.classes.values()) for (const t of Object.keys(cls.types ?? {})) typeNames.push(`${cls.name}::${t}`)
      const parser = new Parser(pre.tokens, typeNames)
      const tops = parser.program()
      const compiler = new Compiler(this.m, reg)
      this.compiled = compiler.compile(tops)
      this.warnings.push(...compiler.warnings)
      if (!this.compiled.setup) this.errors.push({ line: 1, message: 'void setup() 함수가 없습니다' })
      if (!this.compiled.loop) this.errors.push({ line: 1, message: 'void loop() 함수가 없습니다' })
    } catch (e) {
      if (e instanceof CompileError) this.errors.push({ line: e.line, message: e.message })
      else this.errors.push({ line: 1, message: `코드를 해석하지 못했습니다: ${e instanceof Error ? e.message : String(e)}` })
    }
    if (this.errors.length) {
      this.state = 'error'
      return
    }
    for (const list of this.compiled!.funcs.values()) for (const fi of list) fi.invoke = (args?: unknown[]) => this.runIsr(fi, args ?? [])
    this.m.service = () => this.service()
    host.connect(this.m)
    this.attachSpiSlave()
  }

  /** AVR SPI 주변장치: SPCR 의 SPE 가 켜져 있으면 받은 바이트를 SPDR 에 두고 ISR(SPI_STC_vect) 를 부른다 */
  private attachSpiSlave() {
    const c = this.compiled!
    const spcr = c.slot('SPCR')
    const spdr = c.slot('SPDR')
    const spsr = c.slot('SPSR')
    if (spcr === undefined || spdr === undefined || spsr === undefined) return
    const G = c.globals as number[]
    const isr = c.isrs.get('SPI_STC_vect')
    this.host.spiSlave((byte) => {
      if (!(G[spcr] & 0x40) || G[spcr] & 0x10) return 0xff
      const reply = G[spdr] & 0xff
      G[spdr] = byte & 0xff
      G[spsr] |= 0x80
      if (G[spcr] & 0x80 && isr) this.runIsr(isr, [])
      return reply
    })
  }

  get ok(): boolean {
    return this.errors.length === 0
  }

  /** 정해 둔 시각까지 실행한다 (예산을 다 쓰면 그 전에 멈춘다) */
  run(untilUs: number, budget = 400000): void {
    if (this.state === 'error' || this.state === 'stopped' || !this.compiled) return
    const m = this.m
    if (!this.main) {
      this.main = this.mainLoop()
      this.state = 'running'
    }
    m.target = untilUs
    m.budget = budget
    try {
      this.service()
      if (m.us >= untilUs && !m.irqPending) return
      const r = this.main.next()
      if (r.done) this.state = 'stopped'
    } catch (e) {
      this.state = 'error'
      if (e instanceof RuntimeErr) this.fault = { line: m.line, message: e.message }
      else if (e instanceof RangeError) this.fault = { line: m.line, message: '함수 호출이 너무 깊습니다 (재귀가 끝나지 않거나 스택이 넘침)' }
      else this.fault = { line: m.line, message: `실행 중 오류: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  private *mainLoop(): Gen {
    const c = this.compiled!
    const m = this.m
    yield* c.init()
    yield* this.callFn(c.setup!)
    const loop = c.loop!
    const serialEvent = c.serialEvent
    for (;;) {
      if (loop.isGen) yield* loop.gen!([])
      else loop.sync!([])
      m.us += m.p.core === 'avr' ? 2 : 0.2
      m.budget--
      if (serialEvent && this.host.serial('Serial')?.available(m.us)) yield* this.callFn(serialEvent)
      if (m.shouldYield()) yield 0
    }
  }

  private *callFn(fi: FnInfo): Gen {
    if (fi.isGen) return yield* fi.gen!([])
    return fi.sync!([])
  }

  /** 인터럽트·콜백: 끝까지 한 번에 실행 */
  private runIsr(fi: FnInfo, args: unknown[]) {
    const m = this.m
    if (m.inIsr) return
    const line = m.line
    m.inIsr = true
    try {
      if (fi.isGen) {
        const g = fi.gen!([...args])
        let steps = 0
        while (!g.next().done) if (++steps > 100000) throw new RuntimeErr(`인터럽트 함수 ${fi.name}() 이(가) 끝나지 않습니다`)
      } else fi.sync!([...args])
    } finally {
      m.inIsr = false
      m.line = line
    }
  }

  private service() {
    const m = this.m
    if (m.timers.length && m.us >= m.nextEvent) {
      const due = m.timers.filter((t) => t.at <= m.us)
      for (const t of due) m.timers.splice(m.timers.indexOf(t), 1)
      for (const t of due) t.fn()
    }
    if (m.irqEnabled && !m.inIsr) {
      m.irqPending = false
      for (const fn of this.host.poll(m.us)) fn()
    }
    let next = this.host.nextEvent(m.us)
    for (const t of m.timers) if (t.at < next) next = t.at
    m.nextEvent = next
  }
}

/** 컴파일만 해서 오류를 본다 (편집기에서 바로 알려 주기) */
export function checkSketch(source: string, host: Host, board: BoardInfo): CompileResult {
  const p = new Program(source, host, board)
  return { errors: p.errors, warnings: p.warnings, includes: p.includes }
}

export { NOOP_HEADERS }
