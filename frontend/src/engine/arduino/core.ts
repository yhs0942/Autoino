import {
  BOOL,
  CHAR,
  CSTR,
  F32,
  I32,
  STRING,
  U32,
  U8,
  VOID,
  common,
  convert,
  doubleOf,
  intOf,
  longOf,
  promote,
  truthy,
  wrapInt,
  type CType,
  type Platform,
} from './ctypes'
import type { BuiltinFn, ClassDef, Gen, Machine, MethodDef, Registry, SerialPort } from './machine'
import { Ptr, RuntimeErr, cstrLen, cstrText, dtostrf, parseLeadingFloat, parseLeadingInt, printText, sprintf, utf8, writeCstr } from './values'

// Arduino 코어: 핀·시간·수학·문자열 함수와 상수, Serial

export type BoardKind = 'uno' | 'nano' | 'mega' | 'esp32'

export interface BoardInfo {
  kind: BoardKind
  core: 'avr' | 'esp32'
}

export function boardKindOf(boardId: string): BoardKind {
  if (boardId.includes('mega')) return 'mega'
  if (boardId.includes('nano')) return 'nano'
  if (boardId.includes('esp32')) return 'esp32'
  return 'uno'
}

/** 보드별 아날로그 핀 번호 (A0 …) */
export function analogNumbers(kind: BoardKind): Record<string, number> {
  const out: Record<string, number> = {}
  if (kind === 'esp32') {
    const map: [string, number][] = [['A0', 36], ['A3', 39], ['A4', 32], ['A5', 33], ['A6', 34], ['A7', 35], ['A10', 4], ['A11', 0], ['A12', 2], ['A13', 15], ['A14', 13], ['A15', 12], ['A16', 14], ['A17', 27], ['A18', 25], ['A19', 26]]
    for (const [k, v] of map) out[k] = v
    return out
  }
  const base = kind === 'mega' ? 54 : 14
  const count = kind === 'mega' ? 16 : 8
  for (let i = 0; i < count; i++) out[`A${i}`] = base + i
  return out
}

const BUS_PINS: Record<BoardKind, Record<string, number>> = {
  uno: { SDA: 18, SCL: 19, SS: 10, MOSI: 11, MISO: 12, SCK: 13 },
  nano: { SDA: 18, SCL: 19, SS: 10, MOSI: 11, MISO: 12, SCK: 13 },
  mega: { SDA: 20, SCL: 21, SS: 53, MOSI: 51, MISO: 50, SCK: 52 },
  esp32: { SDA: 21, SCL: 22, SS: 5, MOSI: 23, MISO: 19, SCK: 18, TX: 1, RX: 3 },
}

/** AVR 의 인터럽트 번호 → 핀 */
const AVR_INTERRUPTS: Record<string, number[]> = { uno: [2, 3], nano: [2, 3], mega: [2, 3, 21, 20, 19, 18] }

export const MODE = { INPUT: 0, OUTPUT: 1, INPUT_PULLUP: 2, INPUT_PULLDOWN: 3 } as const
const EDGE = { CHANGE: 1, FALLING: 2, RISING: 3 } as const

// ------------------------------------------------------------ 도우미

export function pinOf(m: Machine, n: unknown, what: string): string | null {
  const id = m.host.pinId(Number(n))
  if (id === null) m.warn(`${what}: 보드에 ${Number(n)}번 핀이 없습니다`)
  return id
}

/** 일정 시간 기다리기 (중간에 목표 시각이면 양보) */
export function* waitUntil(m: Machine, end: number): Gen {
  while (m.us < end) {
    const stop = Math.min(end, m.target, m.nextEvent)
    if (stop > m.us) m.us = stop
    if (m.us >= m.nextEvent || m.irqPending) m.service()
    if (m.us < end && m.us >= m.target && !m.inIsr) yield 0
    if (m.inIsr) m.us = end
  }
  return undefined
}

/** 조건이 될 때까지 기다리기 (다음 도착 시각을 알려 주는 함수와 함께) */
export function* waitFor(m: Machine, ready: () => boolean, nextAt: () => number, timeoutUs: number): Gen<boolean> {
  const end = m.us + timeoutUs
  for (;;) {
    if (ready()) return true
    if (m.us >= end) return false
    const stop = Math.min(end, Math.max(m.us, nextAt()), m.target, m.nextEvent)
    m.us = Math.max(m.us, stop)
    if (m.irqPending || m.us >= m.nextEvent) m.service()
    if (m.us >= m.target && !ready() && m.us < end) {
      if (m.inIsr) return false
      yield 0
    }
  }
}

/** print/println 의 바이트 (Print 클래스 공통) */
export function printBytes(args: unknown[], types: CType[], newline: boolean): number[] {
  let text = ''
  if (args.length) {
    const t = types[0]
    const fmt = args.length > 1 ? Number(args[1]) : undefined
    text = printText(args[0], t, fmt)
  }
  if (newline) text += '\r\n'
  return utf8(text)
}

/** write(바이트) / write(문자열) / write(버퍼, 길이) */
export function writeBytes(args: unknown[], types: CType[]): number[] {
  const t = types[0]
  if (args.length >= 2) {
    const buf = args[0]
    const n = Number(args[1])
    const arr = buf instanceof Ptr ? (buf.a as number[]).slice(buf.i as number) : Array.isArray(buf) ? (buf as number[]) : utf8(cstrText(buf))
    return arr.slice(0, n).map((b) => Number(b) & 255)
  }
  if (t.k === 'int' || t.k === 'float') return [Number(args[0]) & 255]
  if (t.k === 'String') return utf8(String(args[0]))
  return utf8(cstrText(args[0]))
}

/** Print 를 상속하는 클래스의 print · println · write · printf */
export function printMethods(sink: (self: unknown, m: Machine, bytes: number[]) => void, opts: { printf?: boolean } = {}): Record<string, MethodDef> {
  const size: CType = U32
  const methods: Record<string, MethodDef> = {
    print: { ret: size, min: 1, max: 2, call: (m, self, a, t) => (sink(self, m, printBytes(a, t, false)), 0) },
    println: { ret: size, min: 0, max: 2, call: (m, self, a, t) => (sink(self, m, printBytes(a, t, true)), 0) },
    write: { ret: size, min: 1, max: 2, call: (m, self, a, t) => (sink(self, m, writeBytes(a, t)), 1) },
  }
  if (opts.printf)
    methods.printf = {
      ret: size,
      min: 1,
      core: 'esp32',
      call: (m, self, a, t) => {
        const text = sprintf(cstrText(a[0]), a.slice(1), t.slice(1), m.p.core === 'avr')
        sink(self, m, utf8(text))
        return text.length
      },
    }
  return methods
}

/** Stream 의 읽기 메서드 (Serial, SoftwareSerial, Wire) */
export function streamMethods(port: (self: unknown) => SerialPort, timeoutOf: (self: unknown) => number, setTimeout: (self: unknown, ms: number) => void): Record<string, MethodDef> {
  const int = (p: Platform) => intOf(p)
  const readTimed = function* (m: Machine, self: unknown): Gen<number> {
    const p = port(self)
    const ok = yield* waitFor(m, () => p.available(m.us) > 0, () => p.nextArrival(m.us), timeoutOf(self) * 1000)
    return ok ? p.read(m.us) : -1
  }
  const peekTimed = function* (m: Machine, self: unknown): Gen<number> {
    const p = port(self)
    const ok = yield* waitFor(m, () => p.available(m.us) > 0, () => p.nextArrival(m.us), timeoutOf(self) * 1000)
    return ok ? p.peek(m.us) : -1
  }
  return {
    available: { ret: (_t, p) => int(p), max: 0, call: (m, self) => port(self).available(m.us) },
    read: { ret: (_t, p) => int(p), max: 0, call: (m, self) => port(self).read(m.us) },
    peek: { ret: (_t, p) => int(p), max: 0, call: (m, self) => port(self).peek(m.us) },
    flush: { ret: VOID, max: 0, call: () => undefined },
    availableForWrite: { ret: (_t, p) => int(p), max: 0, call: () => 63 },
    setTimeout: { ret: VOID, min: 1, max: 1, call: (_m, self, a) => setTimeout(self, Number(a[0])) },
    readString: {
      ret: STRING,
      max: 0,
      gen: function* (m, self) {
        const bytes: number[] = []
        for (;;) {
          const c = yield* readTimed(m, self)
          if (c < 0) break
          bytes.push(c)
        }
        return new TextDecoder().decode(new Uint8Array(bytes))
      },
    },
    readStringUntil: {
      ret: STRING,
      min: 1,
      max: 1,
      gen: function* (m, self, a) {
        const stop = Number(a[0]) & 255
        const bytes: number[] = []
        for (;;) {
          const c = yield* readTimed(m, self)
          if (c < 0 || c === stop) break
          bytes.push(c)
        }
        return new TextDecoder().decode(new Uint8Array(bytes))
      },
    },
    readBytes: {
      ret: U32,
      min: 2,
      max: 2,
      gen: function* (m, self, a) {
        const n = Number(a[1])
        const dest = a[0]
        let i = 0
        for (; i < n; i++) {
          const c = yield* readTimed(m, self)
          if (c < 0) break
          storeByte(dest, i, c)
        }
        return i
      },
    },
    readBytesUntil: {
      ret: U32,
      min: 3,
      max: 3,
      gen: function* (m, self, a) {
        const stop = Number(a[0]) & 255
        const n = Number(a[2])
        let i = 0
        for (; i < n; i++) {
          const c = yield* readTimed(m, self)
          if (c < 0 || c === stop) break
          storeByte(a[1], i, c)
        }
        return i
      },
    },
    parseInt: {
      ret: longOf(),
      max: 1,
      gen: function* (m, self) {
        // 숫자나 - 가 나올 때까지 건너뛰고, 숫자가 끝날 때까지 읽는다
        let c = yield* peekTimed(m, self)
        while (c >= 0 && !(c === 45 || (c >= 48 && c <= 57))) {
          port(self).read(m.us)
          c = yield* peekTimed(m, self)
        }
        if (c < 0) return 0
        let neg = false
        let v = 0
        for (;;) {
          c = yield* peekTimed(m, self)
          if (c === 45 && !neg && v === 0) neg = true
          else if (c >= 48 && c <= 57) v = v * 10 + (c - 48)
          else break
          port(self).read(m.us)
        }
        return wrapInt(neg ? -v : v, 32, true)
      },
    },
    parseFloat: {
      ret: F32,
      max: 1,
      gen: function* (m, self) {
        let c = yield* peekTimed(m, self)
        while (c >= 0 && !(c === 45 || c === 46 || (c >= 48 && c <= 57))) {
          port(self).read(m.us)
          c = yield* peekTimed(m, self)
        }
        let text = ''
        for (;;) {
          c = yield* peekTimed(m, self)
          if (c < 0 || !(c === 45 || c === 46 || (c >= 48 && c <= 57))) break
          text += String.fromCharCode(c)
          port(self).read(m.us)
        }
        return Math.fround(parseLeadingFloat(text))
      },
    },
    find: {
      ret: BOOL,
      min: 1,
      max: 1,
      gen: function* (m, self, a) {
        const target = utf8(cstrText(a[0]))
        let matched = 0
        for (;;) {
          const c = yield* readTimed(m, self)
          if (c < 0) return 0
          matched = c === target[matched] ? matched + 1 : c === target[0] ? 1 : 0
          if (matched === target.length) return 1
        }
      },
    },
  }
}

function storeByte(dest: unknown, i: number, c: number) {
  const v = c > 127 ? c - 256 : c
  if (Array.isArray(dest)) {
    if (i >= dest.length) throw new RuntimeErr('버퍼 넘침: 받은 바이트를 담을 배열이 작습니다')
    dest[i] = v
  } else if (dest instanceof Ptr && Array.isArray(dest.a)) (dest.a as unknown[])[(dest.i as number) + i] = v
}

// ------------------------------------------------------------ Serial

interface SerialObj {
  port: SerialPort
  name: string
  timeout: number
  begun: boolean
}

export const SERIAL_CLASS: ClassDef = {
  name: 'HardwareSerial',
  header: '',
  construct: () => ({}),
  methods: {
    begin: {
      ret: VOID,
      min: 1,
      max: 5,
      call: (m, self, a) => {
        const s = self as SerialObj
        s.begun = true
        const rx = a.length >= 3 && Number(a[2]) >= 0 ? m.host.pinId(Number(a[2])) : null
        const tx = a.length >= 4 && Number(a[3]) >= 0 ? m.host.pinId(Number(a[3])) : null
        s.port.begin(Number(a[0]), m.us, a.length >= 3 ? { rx, tx } : undefined)
      },
    },
    end: { ret: VOID, max: 0, call: () => undefined },
    ...printMethods(
      (self, m, bytes) => {
        const s = self as SerialObj
        s.port.write(bytes, m.us)
      },
      { printf: true },
    ),
    ...streamMethods(
      (self) => (self as SerialObj).port,
      (self) => (self as SerialObj).timeout,
      (self, ms) => ((self as SerialObj).timeout = ms),
    ),
  },
}

function serialObject(name: string) {
  return (m: Machine): object => {
    const port = m.host.serial(name)
    if (!port) throw new RuntimeErr(`이 보드에는 ${name} 이(가) 없습니다`)
    const obj: SerialObj = { port, name, timeout: 1000, begun: false }
    return obj
  }
}

// ------------------------------------------------------------ 난수 (avr-libc random)

function avrRandom(m: Machine): number {
  let x = (m.state.seed as number | undefined) ?? 1
  if (x === 0) x = 123459876
  const hi = Math.trunc(x / 127773)
  const lo = x % 127773
  x = 16807 * lo - 2836 * hi
  if (x < 0) x += 0x7fffffff
  m.state.seed = x
  return x % 0x80000000
}

function nextRandom(m: Machine): number {
  if (m.p.core === 'esp32') return Math.floor(m.host.random() * 0x7fffffff)
  return avrRandom(m)
}

// ------------------------------------------------------------ 함수표

export function coreRegistry(board: BoardInfo, p: Platform): Registry {
  const int = intOf(p)
  const uint = intOf(p, false)
  const long = longOf()
  const ulong = longOf(false)
  const dbl = doubleOf(p)
  const fns = new Map<string, BuiltinFn>()
  const consts = new Map<string, { t: CType; v: unknown }>()
  const def = (name: string, f: BuiltinFn) => fns.set(name, f)
  const num = (name: string, v: number, t: CType = int) => consts.set(name, { t, v })

  // 상수
  num('HIGH', 1)
  num('LOW', 0)
  num('INPUT', MODE.INPUT)
  num('OUTPUT', MODE.OUTPUT)
  num('INPUT_PULLUP', MODE.INPUT_PULLUP)
  if (board.core === 'esp32') num('INPUT_PULLDOWN', MODE.INPUT_PULLDOWN)
  num('CHANGE', EDGE.CHANGE)
  num('FALLING', EDGE.FALLING)
  num('RISING', EDGE.RISING)
  num('LSBFIRST', 0)
  num('MSBFIRST', 1)
  num('DEC', 10)
  num('HEX', 16)
  num('OCT', 8)
  num('BIN', 2)
  num('LED_BUILTIN', board.kind === 'esp32' ? 2 : 13, U8)
  num('NOT_AN_INTERRUPT', -1)
  num('DEFAULT', 1)
  num('INTERNAL', 3)
  num('EXTERNAL', 0)
  if (board.kind === 'mega') {
    num('INTERNAL1V1', 2)
    num('INTERNAL2V56', 3)
  }
  for (const [k, v] of Object.entries(analogNumbers(board.kind))) num(k, v, U8)
  for (const [k, v] of Object.entries(BUS_PINS[board.kind])) num(k, v, U8)
  num('PI', Math.PI, dbl)
  num('HALF_PI', Math.PI / 2, dbl)
  num('TWO_PI', Math.PI * 2, dbl)
  num('DEG_TO_RAD', Math.PI / 180, dbl)
  num('RAD_TO_DEG', 180 / Math.PI, dbl)
  num('EULER', Math.E, dbl)
  num('M_PI', Math.PI, dbl)
  num('SERIAL_8N1', 0x06)
  num('SERIAL_8E1', 0x26)
  num('SERIAL_7E1', 0x24)
  num('RAND_MAX', 0x7fff)
  num('RANDOM_MAX', 0x7fffffff, long)
  num('INT_MAX', p.intBits === 16 ? 32767 : 2147483647)
  num('INT_MIN', p.intBits === 16 ? -32768 : -2147483648)
  num('UINT_MAX', p.intBits === 16 ? 65535 : 4294967295, uint)
  num('LONG_MAX', 2147483647, long)
  num('LONG_MIN', -2147483648, long)
  num('ULONG_MAX', 4294967295, ulong)
  num('UINT8_MAX', 255)
  num('INT16_MAX', 32767)
  num('UINT16_MAX', 65535, uint)
  num('INT32_MAX', 2147483647, long)
  num('UINT32_MAX', 4294967295, ulong)
  num('FLT_MAX', 3.4028235e38, F32)
  consts.set('NULL', { t: { k: 'ptr', to: VOID }, v: null })

  // 디지털 · 아날로그
  def('pinMode', {
    ret: VOID,
    min: 2,
    max: 2,
    usage: 'pinMode(13, OUTPUT)',
    call: (m, a) => {
      const id = pinOf(m, a[0], 'pinMode')
      if (!id) return
      const mode = Number(a[1])
      const name = mode === MODE.OUTPUT ? 'OUTPUT' : mode === MODE.INPUT_PULLUP ? 'INPUT_PULLUP' : mode === MODE.INPUT_PULLDOWN ? 'INPUT_PULLDOWN' : 'INPUT'
      m.host.pinMode(id, name, m.us)
    },
  })
  def('digitalWrite', {
    ret: VOID,
    min: 2,
    max: 2,
    usage: 'digitalWrite(13, HIGH)',
    call: (m, a) => {
      m.us += m.p.core === 'avr' ? 4 : 0.2
      const id = pinOf(m, a[0], 'digitalWrite')
      if (id) m.host.digitalWrite(id, truthy(a[1]), m.us)
    },
  })
  def('digitalRead', {
    ret: int,
    min: 1,
    max: 1,
    call: (m, a) => {
      m.us += m.p.core === 'avr' ? 4 : 0.2
      const id = pinOf(m, a[0], 'digitalRead')
      return id && m.host.digitalRead(id, m.us) ? 1 : 0
    },
  })
  def('analogRead', {
    ret: int,
    min: 1,
    max: 1,
    call: (m, a) => {
      m.us += m.p.core === 'avr' ? 112 : 10
      const id = m.host.analogPinId(Number(a[0]))
      if (!id) {
        m.warn(`analogRead(${Number(a[0])}): 아날로그 입력 핀이 아닙니다`)
        return 0
      }
      const bits = (m.state.adcBits as number | undefined) ?? (m.p.core === 'avr' ? 10 : 12)
      const max = 2 ** bits - 1
      const vref = (m.state.vref as number | undefined) ?? m.host.logicVoltage
      const v = m.host.analogRead(id, m.us)
      return Math.max(0, Math.min(max, Math.round((v / vref) * max)))
    },
  })
  def('analogReference', {
    ret: VOID,
    min: 1,
    max: 1,
    core: 'avr',
    call: (m, a) => {
      const t = Number(a[0])
      m.state.vref = t === 1 ? undefined : t === 3 ? (board.kind === 'mega' ? 2.56 : 1.1) : t === 2 ? 1.1 : undefined
      if (t === 0) m.warn('analogReference(EXTERNAL): AREF 핀 전압은 시뮬레이션에서 5 V 로 봅니다')
    },
  })
  def('analogReadResolution', { ret: VOID, min: 1, max: 1, core: 'esp32', call: (m, a) => void (m.state.adcBits = Math.max(1, Math.min(16, Number(a[0])))) })
  def('analogSetAttenuation', { ret: VOID, min: 1, max: 1, core: 'esp32', call: () => undefined })
  def('analogWrite', {
    ret: VOID,
    min: 2,
    max: 2,
    usage: 'analogWrite(9, 128)',
    call: (m, a) => {
      const id = pinOf(m, a[0], 'analogWrite')
      if (!id) return
      const bits = (m.state.pwmBits as number | undefined) ?? 8
      const max = 2 ** bits - 1
      const v = Math.max(0, Math.min(max, Number(a[1])))
      if (m.p.core === 'avr' && !m.host.isPwm(id)) {
        m.warn(`${id} 은(는) PWM 핀이 아니라 analogWrite(${id.replace('D', '')}, …) 가 켜기(128 이상)/끄기로만 동작합니다`)
        m.host.pinMode(id, 'OUTPUT', m.us)
        m.host.digitalWrite(id, v >= 128, m.us)
        return
      }
      m.host.pinMode(id, 'OUTPUT', m.us)
      m.host.analogWrite(id, v / max, m.us)
    },
  })
  def('analogWriteResolution', { ret: VOID, min: 1, max: 2, core: 'esp32', call: (m, a) => void (m.state.pwmBits = Number(a[a.length - 1])) })
  // ESP32 LEDC (코어 2.x: 채널, 3.x: 핀)
  const ledc = (m: Machine) => ((m.state.ledc ??= { channels: new Map<number, { pins: string[]; bits: number }>(), pins: new Map<string, number>() }) as { channels: Map<number, { pins: string[]; bits: number }>; pins: Map<string, number> })
  def('ledcSetup', { ret: U32, min: 3, max: 3, core: 'esp32', call: (m, a) => (ledc(m).channels.set(Number(a[0]), { pins: [], bits: Number(a[2]) }), Number(a[1])) })
  def('ledcAttachPin', {
    ret: VOID,
    min: 2,
    max: 2,
    core: 'esp32',
    call: (m, a) => {
      const id = pinOf(m, a[0], 'ledcAttachPin')
      const ch = ledc(m).channels.get(Number(a[1])) ?? { pins: [], bits: 8 }
      if (id) ch.pins.push(id)
      ledc(m).channels.set(Number(a[1]), ch)
      if (id) m.host.pinMode(id, 'OUTPUT', m.us)
    },
  })
  def('ledcAttach', {
    ret: BOOL,
    min: 3,
    max: 3,
    core: 'esp32',
    call: (m, a) => {
      const id = pinOf(m, a[0], 'ledcAttach')
      if (id) {
        ledc(m).pins.set(id, Number(a[2]))
        m.host.pinMode(id, 'OUTPUT', m.us)
      }
      return 1
    },
  })
  def('ledcWrite', {
    ret: VOID,
    min: 2,
    max: 2,
    core: 'esp32',
    call: (m, a) => {
      const l = ledc(m)
      const ch = l.channels.get(Number(a[0]))
      if (ch) {
        for (const id of ch.pins) m.host.analogWrite(id, Math.min(1, Number(a[1]) / (2 ** ch.bits - 1)), m.us)
        return
      }
      const id = m.host.pinId(Number(a[0]))
      const bits = id ? l.pins.get(id) : undefined
      if (id && bits !== undefined) m.host.analogWrite(id, Math.min(1, Number(a[1]) / (2 ** bits - 1)), m.us)
      else m.warn(`ledcWrite(${Number(a[0])}, …): ledcAttach 로 연결하지 않은 핀·채널입니다`)
    },
  })
  def('ledcWriteTone', {
    ret: U32,
    min: 2,
    max: 2,
    core: 'esp32',
    call: (m, a) => {
      const ch = ledc(m).channels.get(Number(a[0]))
      const pins = ch ? ch.pins : [m.host.pinId(Number(a[0]))].filter((x): x is string => !!x)
      for (const id of pins) m.host.tone(id, Number(a[1]) > 0 ? Number(a[1]) : null, m.us)
      return Number(a[1])
    },
  })
  def('ledcDetachPin', { ret: VOID, min: 1, max: 1, core: 'esp32', call: () => undefined })
  def('ledcDetach', { ret: BOOL, min: 1, max: 1, core: 'esp32', call: () => 1 })

  // 시간
  def('delay', {
    ret: VOID,
    min: 1,
    max: 1,
    usage: 'delay(1000)',
    gen: function* (m, a) {
      const ms = Number(a[0])
      if (ms > 0) yield* waitUntil(m, m.us + ms * 1000)
      return undefined
    },
  })
  def('delayMicroseconds', {
    ret: VOID,
    min: 1,
    max: 1,
    gen: function* (m, a) {
      const n = Number(a[0])
      if (n > 0) yield* waitUntil(m, m.us + n)
      return undefined
    },
  })
  def('millis', { ret: ulong, max: 0, call: (m) => wrapInt(Math.floor(m.us / 1000), 32, false) })
  def('micros', { ret: ulong, max: 0, call: (m) => wrapInt(m.p.core === 'avr' ? Math.floor(m.us / 4) * 4 : Math.floor(m.us), 32, false) })
  def('yield', { ret: VOID, max: 0, call: () => undefined })
  const pulse = function* (m: Machine, a: unknown[]): Gen {
    const id = pinOf(m, a[0], 'pulseIn')
    if (!id) return 0
    const timeout = a.length > 2 ? Number(a[2]) : 1000000
    const { width, end } = m.host.pulseIn(id, truthy(a[1]), timeout, m.us)
    yield* waitUntil(m, end)
    return width
  }
  def('pulseIn', { ret: ulong, min: 2, max: 3, gen: pulse })
  def('pulseInLong', { ret: ulong, min: 2, max: 3, gen: pulse })
  def('tone', {
    ret: VOID,
    min: 2,
    max: 3,
    call: (m, a) => {
      const id = pinOf(m, a[0], 'tone')
      if (!id) return
      const hz = Number(a[1])
      m.host.pinMode(id, 'OUTPUT', m.us)
      m.host.tone(id, hz > 0 ? hz : null, m.us)
      if (a.length > 2 && Number(a[2]) > 0) {
        const token = {}
        m.state[`tone:${id}`] = token
        m.after(m.us + Number(a[2]) * 1000, () => {
          if (m.state[`tone:${id}`] === token) m.host.tone(id, null, m.us)
        })
      } else m.state[`tone:${id}`] = undefined
    },
  })
  def('noTone', {
    ret: VOID,
    min: 1,
    max: 1,
    call: (m, a) => {
      const id = pinOf(m, a[0], 'noTone')
      if (id) {
        m.state[`tone:${id}`] = undefined
        m.host.tone(id, null, m.us)
      }
    },
  })

  // 인터럽트
  def('digitalPinToInterrupt', {
    ret: int,
    min: 1,
    max: 1,
    call: (m, a) => {
      const pin = Number(a[0])
      if (board.core === 'esp32') return pin
      const idx = AVR_INTERRUPTS[board.kind].indexOf(pin)
      if (idx < 0) m.warn(`${pin}번 핀은 외부 인터럽트를 쓸 수 없습니다 (${AVR_INTERRUPTS[board.kind].join(', ')}번만 가능)`)
      return idx
    },
  })
  const interruptPin = (m: Machine, n: number): string | null => {
    if (board.core === 'esp32') return m.host.pinId(n)
    const pin = AVR_INTERRUPTS[board.kind][n]
    if (pin === undefined) {
      m.warn(`attachInterrupt(${n}, …): 이 보드에 ${n}번 인터럽트가 없습니다. attachInterrupt(digitalPinToInterrupt(핀), …) 처럼 쓰세요`)
      return null
    }
    return m.host.pinId(pin)
  }
  def('attachInterrupt', {
    ret: VOID,
    min: 3,
    max: 3,
    usage: 'attachInterrupt(digitalPinToInterrupt(2), onPress, FALLING)',
    call: (m, a) => {
      const id = interruptPin(m, Number(a[0]))
      const fi = a[1] as { invoke?: () => void; name?: string } | null
      if (!id || !fi?.invoke) return
      const mode = Number(a[2])
      m.host.attachInterrupt(id, fi.invoke, mode === EDGE.RISING ? 'RISING' : mode === EDGE.FALLING ? 'FALLING' : mode === EDGE.CHANGE ? 'CHANGE' : mode === 1 ? 'HIGH' : 'LOW')
    },
  })
  def('detachInterrupt', {
    ret: VOID,
    min: 1,
    max: 1,
    call: (m, a) => {
      const id = interruptPin(m, Number(a[0]))
      if (id) m.host.detachInterrupt(id)
    },
  })
  const setIrq = (on: boolean) => (m: Machine) => {
    m.irqEnabled = on
    if (on) m.service()
  }
  def('interrupts', { ret: VOID, max: 0, call: setIrq(true) })
  def('noInterrupts', { ret: VOID, max: 0, call: setIrq(false) })
  def('sei', { ret: VOID, max: 0, call: setIrq(true) })
  def('cli', { ret: VOID, max: 0, call: setIrq(false) })

  // 시프트 레지스터
  def('shiftOut', {
    ret: VOID,
    min: 4,
    max: 4,
    call: (m, a) => {
      const data = pinOf(m, a[0], 'shiftOut')
      const clock = pinOf(m, a[1], 'shiftOut')
      if (!data || !clock) return
      const v = Number(a[3]) & 255
      for (let i = 0; i < 8; i++) {
        const bit = Number(a[2]) === 0 ? (v >> i) & 1 : (v >> (7 - i)) & 1
        m.host.digitalWrite(data, !!bit, m.us)
        m.host.digitalWrite(clock, true, m.us)
        m.host.digitalWrite(clock, false, m.us)
        m.us += 8
      }
    },
  })
  def('shiftIn', {
    ret: U8,
    min: 3,
    max: 3,
    call: (m, a) => {
      const data = pinOf(m, a[0], 'shiftIn')
      const clock = pinOf(m, a[1], 'shiftIn')
      if (!data || !clock) return 0
      let v = 0
      for (let i = 0; i < 8; i++) {
        m.host.digitalWrite(clock, true, m.us)
        const bit = m.host.digitalRead(data, m.us) ? 1 : 0
        v |= Number(a[2]) === 0 ? bit << i : bit << (7 - i)
        m.host.digitalWrite(clock, false, m.us)
      }
      return v
    },
  })

  // 수학
  const commonOf = (t: CType[]) => t.reduce((x, y) => common(x, y, p))
  def('min', { ret: (t) => commonOf(t), min: 2, max: 2, call: (_m, a, t) => convert(Math.min(Number(a[0]), Number(a[1])), commonOf(t)) })
  def('max', { ret: (t) => commonOf(t), min: 2, max: 2, call: (_m, a, t) => convert(Math.max(Number(a[0]), Number(a[1])), commonOf(t)) })
  def('abs', { ret: (t) => promote(t[0], p), min: 1, max: 1, call: (_m, a, t) => convert(Math.abs(Number(a[0])), promote(t[0], p)) })
  def('constrain', {
    ret: (t) => commonOf(t),
    min: 3,
    max: 3,
    call: (_m, a, t) => {
      const x = Number(a[0])
      const lo = Number(a[1])
      const hi = Number(a[2])
      return convert(x < lo ? lo : x > hi ? hi : x, commonOf(t))
    },
  })
  def('map', {
    ret: long,
    min: 5,
    max: 5,
    usage: 'map(value, 0, 1023, 0, 255)',
    call: (_m, a) => {
      const [x, inMin, inMax, outMin, outMax] = a.map((v) => Math.trunc(Number(v)))
      if (inMax === inMin) throw new RuntimeErr('map(): 입력 범위의 최소·최대가 같아 0 으로 나눴습니다')
      return wrapInt(Math.trunc(((x - inMin) * (outMax - outMin)) / (inMax - inMin)) + outMin, 32, true)
    },
  })
  def('sq', { ret: (t) => promote(t[0], p), min: 1, max: 1, call: (_m, a, t) => convert(Number(a[0]) * Number(a[0]), promote(t[0], p)) })
  const math1 = (name: string, f: (x: number) => number) => def(name, { ret: dbl, min: 1, max: 1, call: (_m, a) => convert(f(Number(a[0])), dbl) })
  const math2 = (name: string, f: (x: number, y: number) => number) => def(name, { ret: dbl, min: 2, max: 2, call: (_m, a) => convert(f(Number(a[0]), Number(a[1])), dbl) })
  math1('sqrt', Math.sqrt)
  math1('sin', Math.sin)
  math1('cos', Math.cos)
  math1('tan', Math.tan)
  math1('asin', Math.asin)
  math1('acos', Math.acos)
  math1('atan', Math.atan)
  math1('exp', Math.exp)
  math1('log', Math.log)
  math1('log10', Math.log10)
  math1('log2', Math.log2)
  math1('floor', Math.floor)
  math1('ceil', Math.ceil)
  math1('fabs', Math.abs)
  math1('trunc', Math.trunc)
  math1('cbrt', Math.cbrt)
  math1('radians', (x) => (x * Math.PI) / 180)
  math1('degrees', (x) => (x * 180) / Math.PI)
  math2('pow', Math.pow)
  math2('atan2', Math.atan2)
  math2('fmod', (x, y) => x % y)
  math2('hypot', Math.hypot)
  math2('fmin', Math.min)
  math2('fmax', Math.max)
  for (const n of ['sqrtf', 'sinf', 'cosf', 'fabsf', 'floorf', 'ceilf', 'roundf']) {
    const base = n.slice(0, -1)
    const f = base === 'round' ? (x: number) => Math.sign(x) * Math.round(Math.abs(x)) : (Math[base as 'sqrt'] as (x: number) => number) ?? Math.abs
    def(n, { ret: F32, min: 1, max: 1, call: (_m, a) => Math.fround(f(Number(a[0]))) })
  }
  const roundHalfAway = (x: number) => (x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5))
  // AVR 의 round() 는 long 을 돌려주는 매크로
  if (p.core === 'avr') def('round', { ret: long, min: 1, max: 1, call: (_m, a) => wrapInt(roundHalfAway(Number(a[0])), 32, true) })
  else math1('round', roundHalfAway)
  def('lround', { ret: long, min: 1, max: 1, call: (_m, a) => wrapInt(roundHalfAway(Number(a[0])), 32, true) })
  def('isnan', { ret: BOOL, min: 1, max: 1, call: (_m, a) => +Number.isNaN(Number(a[0])) })
  def('isinf', { ret: BOOL, min: 1, max: 1, call: (_m, a) => +(!Number.isFinite(Number(a[0])) && !Number.isNaN(Number(a[0]))) })
  def('random', {
    ret: long,
    min: 1,
    max: 2,
    call: (m, a) => {
      const r = nextRandom(m)
      if (a.length === 1) {
        const hi = Number(a[0])
        return hi <= 0 ? 0 : r % hi
      }
      const lo = Number(a[0])
      const hi = Number(a[1])
      return hi <= lo ? lo : (r % (hi - lo)) + lo
    },
  })
  def('randomSeed', { ret: VOID, min: 1, max: 1, call: (m, a) => void (Number(a[0]) !== 0 ? (m.state.seed = wrapInt(Number(a[0]), 32, false)) : undefined) })
  def('rand', { ret: int, max: 0, call: (m) => nextRandom(m) & 0x7fff })
  def('srand', { ret: VOID, min: 1, max: 1, call: (m, a) => void (m.state.seed = Number(a[0])) })
  def('esp_random', { ret: U32, max: 0, core: 'esp32', call: (m) => Math.floor(m.host.random() * 0xffffffff) })

  // 비트
  def('bitRead', { ret: int, min: 2, max: 2, call: (_m, a) => (Math.floor(Number(a[0]) / 2 ** Number(a[1])) & 1) })
  const bitOp = (f: (v: number, b: number, x?: unknown) => number) => (_m: Machine, a: unknown[]) => {
    const ptr = a[0] as Ptr
    const v = f(Number(ptr.get()), Number(a[1]), a[2])
    ptr.set(v)
    return ptr.get()
  }
  def('bitSet', { ret: (t) => t[0], min: 2, max: 2, refArgs: [0], call: bitOp((v, b) => v | (b >= 31 ? 0x80000000 : 1 << b)) })
  def('bitClear', { ret: (t) => t[0], min: 2, max: 2, refArgs: [0], call: bitOp((v, b) => v & ~(1 << b)) })
  def('bitWrite', { ret: (t) => t[0], min: 3, max: 3, refArgs: [0], call: bitOp((v, b, x) => (truthy(x) ? v | (1 << b) : v & ~(1 << b))) })
  def('bit', { ret: ulong, min: 1, max: 1, call: (_m, a) => wrapInt(2 ** Number(a[0]), 32, false) })
  def('lowByte', { ret: U8, min: 1, max: 1, call: (_m, a) => Number(a[0]) & 0xff })
  def('highByte', { ret: U8, min: 1, max: 1, call: (_m, a) => (Number(a[0]) >> 8) & 0xff })
  def('_BV', { ret: int, min: 1, max: 1, call: (_m, a) => 1 << Number(a[0]) })

  // 글자 판별
  const ch = (name: string, f: (c: number) => boolean) => def(name, { ret: BOOL, min: 1, max: 1, call: (_m, a) => +f(Number(a[0]) & 255) })
  const isDigit = (c: number) => c >= 48 && c <= 57
  const isUpper = (c: number) => c >= 65 && c <= 90
  const isLower = (c: number) => c >= 97 && c <= 122
  const isAlpha = (c: number) => isUpper(c) || isLower(c)
  const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13)
  const isPunct = (c: number) => c > 32 && c < 127 && !isAlpha(c) && !isDigit(c)
  const isHex = (c: number) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
  for (const [names, f] of [
    [['isDigit', 'isdigit'], isDigit],
    [['isAlpha', 'isalpha'], isAlpha],
    [['isAlphaNumeric', 'isalnum'], (c: number) => isAlpha(c) || isDigit(c)],
    [['isSpace', 'isspace', 'isWhitespace'], isSpace],
    [['isUpperCase', 'isupper'], isUpper],
    [['isLowerCase', 'islower'], isLower],
    [['isPunct', 'ispunct'], isPunct],
    [['isHexadecimalDigit', 'isxdigit'], isHex],
    [['isPrintable', 'isprint'], (c: number) => c >= 32 && c < 127],
    [['isControl', 'iscntrl'], (c: number) => c < 32 || c === 127],
    [['isAscii', 'isascii'], (c: number) => c < 128],
    [['isGraph', 'isgraph'], (c: number) => c > 32 && c < 127],
  ] as [string[], (c: number) => boolean][])
    for (const n of names) ch(n, f)
  def('toupper', { ret: int, min: 1, max: 1, call: (_m, a) => (isLower(Number(a[0])) ? Number(a[0]) - 32 : Number(a[0])) })
  def('tolower', { ret: int, min: 1, max: 1, call: (_m, a) => (isUpper(Number(a[0])) ? Number(a[0]) + 32 : Number(a[0])) })
  def('toUpperCase', { ret: int, min: 1, max: 1, call: (_m, a) => (isLower(Number(a[0])) ? Number(a[0]) - 32 : Number(a[0])) })
  def('toLowerCase', { ret: int, min: 1, max: 1, call: (_m, a) => (isUpper(Number(a[0])) ? Number(a[0]) + 32 : Number(a[0])) })

  // C 문자열
  const avrFloat = (m: Machine) => () => m.warn('AVR(Uno·Nano·Mega) 의 sprintf 는 %f 를 지원하지 않아 ? 로 나옵니다. dtostrf(값, 너비, 자릿수, 버퍼) 나 String(값, 2) 를 쓰세요')
  def('sprintf', {
    ret: int,
    min: 2,
    call: (m, a, t) => {
      const text = sprintf(cstrText(a[1]), a.slice(2), t.slice(2), m.p.core === 'avr', avrFloat(m))
      writeCstr(a[0], text)
      return text.length
    },
  })
  def('snprintf', {
    ret: int,
    min: 3,
    call: (m, a, t) => {
      const text = sprintf(cstrText(a[2]), a.slice(3), t.slice(3), m.p.core === 'avr', avrFloat(m))
      writeCstr(a[0], text, Number(a[1]))
      return text.length
    },
  })
  fns.set('sprintf_P', fns.get('sprintf')!)
  fns.set('snprintf_P', fns.get('snprintf')!)
  def('dtostrf', {
    ret: CSTR,
    min: 4,
    max: 4,
    call: (_m, a) => {
      writeCstr(a[3], dtostrf(Number(a[0]), Number(a[1]), Number(a[2])))
      return a[3]
    },
  })
  const size = intOf(p, false)
  def('strlen', { ret: size, min: 1, max: 1, call: (_m, a) => cstrLen(a[0]) })
  fns.set('strlen_P', fns.get('strlen')!)
  def('strcmp', { ret: int, min: 2, max: 2, call: (_m, a) => cmpText(cstrText(a[0]), cstrText(a[1])) })
  def('strcasecmp', { ret: int, min: 2, max: 2, call: (_m, a) => cmpText(cstrText(a[0]).toLowerCase(), cstrText(a[1]).toLowerCase()) })
  def('strncmp', { ret: int, min: 3, max: 3, call: (_m, a) => cmpText(cstrText(a[0]).slice(0, Number(a[2])), cstrText(a[1]).slice(0, Number(a[2]))) })
  fns.set('strcmp_P', fns.get('strcmp')!)
  def('strcpy', { ret: CSTR, min: 2, max: 2, call: (_m, a) => (writeCstr(a[0], cstrText(a[1])), a[0]) })
  fns.set('strcpy_P', fns.get('strcpy')!)
  def('strncpy', { ret: CSTR, min: 3, max: 3, call: (_m, a) => (writeCstr(a[0], cstrText(a[1]).slice(0, Number(a[2]))), a[0]) })
  def('strcat', { ret: CSTR, min: 2, max: 2, call: (_m, a) => (writeCstr(a[0], cstrText(a[0]) + cstrText(a[1])), a[0]) })
  def('strncat', { ret: CSTR, min: 3, max: 3, call: (_m, a) => (writeCstr(a[0], cstrText(a[0]) + cstrText(a[1]).slice(0, Number(a[2]))), a[0]) })
  const find = (hay: unknown, idx: number) => {
    if (idx < 0) return null
    if (typeof hay === 'string') return hay.slice(idx)
    if (Array.isArray(hay)) return new Ptr(hay, idx, CHAR)
    if (hay instanceof Ptr) return hay.offset(idx)
    return null
  }
  def('strchr', { ret: CSTR, min: 2, max: 2, call: (_m, a) => find(a[0], cstrText(a[0]).indexOf(String.fromCharCode(Number(a[1]) & 255))) })
  def('strrchr', { ret: CSTR, min: 2, max: 2, call: (_m, a) => find(a[0], cstrText(a[0]).lastIndexOf(String.fromCharCode(Number(a[1]) & 255))) })
  def('strstr', { ret: CSTR, min: 2, max: 2, call: (_m, a) => find(a[0], cstrText(a[0]).indexOf(cstrText(a[1]))) })
  def('atoi', { ret: int, min: 1, max: 1, call: (_m, a) => convert(parseLeadingInt(cstrText(a[0])), int) })
  def('atol', { ret: long, min: 1, max: 1, call: (_m, a) => wrapInt(parseLeadingInt(cstrText(a[0])), 32, true) })
  def('atof', { ret: dbl, min: 1, max: 1, call: (_m, a) => convert(parseLeadingFloat(cstrText(a[0])), dbl) })
  def('strtol', {
    ret: long,
    min: 3,
    max: 3,
    call: (_m, a) => {
      const s = cstrText(a[0]).trim()
      const base = Number(a[2]) || 10
      const v = parseInt(s, base)
      return Number.isNaN(v) ? 0 : wrapInt(v, 32, true)
    },
  })
  def('strtoul', { ret: ulong, min: 3, max: 3, call: (_m, a) => wrapInt(parseInt(cstrText(a[0]).trim(), Number(a[2]) || 10) || 0, 32, false) })
  def('strtod', { ret: dbl, min: 2, max: 2, call: (_m, a) => parseLeadingFloat(cstrText(a[0])) })
  const toa = (name: string, signed: boolean) =>
    def(name, {
      ret: CSTR,
      min: 3,
      max: 3,
      call: (_m, a) => {
        const v = Number(a[0])
        const base = Number(a[2])
        const text = base === 10 && signed ? String(v) : (v < 0 ? wrapInt(v, p.intBits, false) : v).toString(base)
        writeCstr(a[1], text)
        return a[1]
      },
    })
  toa('itoa', true)
  toa('ltoa', true)
  toa('utoa', false)
  toa('ultoa', false)
  def('memset', {
    ret: { k: 'ptr', to: VOID },
    min: 3,
    max: 3,
    call: (_m, a) => {
      const arr = a[0] instanceof Ptr ? (a[0].a as unknown[]) : (a[0] as unknown[])
      const start = a[0] instanceof Ptr ? (a[0].i as number) : 0
      if (!Array.isArray(arr)) throw new RuntimeErr('memset: 배열이 필요합니다')
      const n = Number(a[2])
      for (let i = 0; i < n && start + i < arr.length; i++) if (typeof arr[start + i] === 'number') arr[start + i] = Number(a[1]) & 255
      return a[0]
    },
  })
  def('memcpy', {
    ret: { k: 'ptr', to: VOID },
    min: 3,
    max: 3,
    call: (_m, a) => {
      const dst = a[0] instanceof Ptr ? (a[0].a as unknown[]) : (a[0] as unknown[])
      const src = a[1] instanceof Ptr ? (a[1].a as unknown[]) : typeof a[1] === 'string' ? utf8(a[1]) : (a[1] as unknown[])
      if (!Array.isArray(dst) || !Array.isArray(src)) throw new RuntimeErr('memcpy: 배열이 필요합니다')
      const n = Number(a[2])
      for (let i = 0; i < n && i < dst.length && i < src.length; i++) dst[i] = src[i]
      return a[0]
    },
  })
  fns.set('memcpy_P', fns.get('memcpy')!)
  def('memcmp', {
    ret: int,
    min: 3,
    max: 3,
    call: (_m, a) => {
      const x = Array.isArray(a[0]) ? (a[0] as number[]) : utf8(cstrText(a[0]))
      const y = Array.isArray(a[1]) ? (a[1] as number[]) : utf8(cstrText(a[1]))
      for (let i = 0; i < Number(a[2]); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1
      return 0
    },
  })
  // PROGMEM 읽기 (주소 → 값)
  const pgm = (name: string, t: CType) =>
    def(name, {
      ret: t,
      min: 1,
      max: 1,
      call: (_m, a) => {
        const v = a[0]
        if (v instanceof Ptr) return convert(v.get(), t)
        if (Array.isArray(v)) return convert(v[0], t)
        if (typeof v === 'string') return utf8(v)[0] ?? 0
        return 0
      },
    })
  pgm('pgm_read_byte', U8)
  pgm('pgm_read_byte_near', U8)
  pgm('pgm_read_word', basicType16(p))
  pgm('pgm_read_word_near', basicType16(p))
  pgm('pgm_read_dword', U32)
  pgm('pgm_read_float', F32)
  def('pgm_read_ptr', { ret: { k: 'ptr', to: VOID }, min: 1, max: 1, call: (_m, a) => (a[0] instanceof Ptr ? a[0].get() : a[0]) })

  // 기타
  def('freeMemory', { ret: int, max: 0, call: () => (board.kind === 'mega' ? 7000 : 1500) })
  void I32

  const classes = new Map<string, ClassDef>([['HardwareSerial', SERIAL_CLASS]])
  const objects = new Map<string, { cls: string; make: (m: Machine) => object }>([['Serial', { cls: 'HardwareSerial', make: serialObject('Serial') }]])
  const extra = board.kind === 'mega' ? ['Serial1', 'Serial2', 'Serial3'] : board.kind === 'esp32' ? ['Serial1', 'Serial2'] : []
  for (const name of extra) objects.set(name, { cls: 'HardwareSerial', make: serialObject(name) })
  return { functions: fns, constants: consts, classes, objects, types: new Map() }
}

function basicType16(p: Platform): CType {
  void p
  return { k: 'int', bits: 16, signed: false, name: 'uint16_t' }
}

function cmpText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export { CHAR, STRING }
