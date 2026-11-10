import { convert, wrapInt, type CType } from './ctypes'

// 실행 중의 값: 포인터, C 문자열(char 배열), Arduino Print 의 숫자 표기, sprintf

export class RuntimeErr extends Error {}

/** 포인터 = 그릇(배열·전역 슬롯·지역 프레임·구조체)과 그 안의 자리. 산술은 배열 안에서만 */
export class Ptr {
  a: unknown[] | Record<string, unknown>
  i: number | string
  t: CType
  constructor(a: unknown[] | Record<string, unknown>, i: number | string, t: CType) {
    this.a = a
    this.i = i
    this.t = t
  }
  get(): unknown {
    return (this.a as Record<string | number, unknown>)[this.i]
  }
  set(v: unknown) {
    ;(this.a as Record<string | number, unknown>)[this.i] = convert(v, this.t)
  }
  offset(n: number): Ptr {
    if (typeof this.i !== 'number') throw new RuntimeErr('배열이 아닌 변수의 포인터는 더하거나 뺄 수 없습니다')
    return new Ptr(this.a, this.i + n, this.t)
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const utf8 = (s: string): number[] => Array.from(encoder.encode(s))
export const fromUtf8 = (bytes: number[]): string => decoder.decode(new Uint8Array(bytes.map((b) => b & 255)))

/** char* / char[] / String 값 → 글자 */
export function cstrText(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return bytesToText(v, 0)
  if (v instanceof Ptr) {
    if (Array.isArray(v.a) && typeof v.i === 'number') return bytesToText(v.a as number[], v.i)
    const x = v.get()
    return typeof x === 'string' ? x : String.fromCharCode(Number(x) & 255)
  }
  if (v === null || v === undefined) return ''
  return String(v)
}

function bytesToText(arr: unknown[], start: number): string {
  const bytes: number[] = []
  for (let i = start; i < arr.length; i++) {
    const b = Number(arr[i]) & 255
    if (b === 0) break
    bytes.push(b)
  }
  return fromUtf8(bytes)
}

/** char 배열에 글자를 쓴다 (끝에 0). 넘치면 실행 오류 */
export function writeCstr(dest: unknown, text: string, limit?: number): void {
  const bytes = utf8(text)
  let arr: unknown[]
  let at = 0
  if (Array.isArray(dest)) arr = dest
  else if (dest instanceof Ptr && Array.isArray(dest.a) && typeof dest.i === 'number') {
    arr = dest.a
    at = dest.i
  } else throw new RuntimeErr('글자를 쓸 char 배열이 필요합니다')
  const n = limit === undefined ? bytes.length : Math.min(bytes.length, Math.max(0, limit - 1))
  if (at + n + 1 > arr.length) throw new RuntimeErr(`버퍼 넘침: 크기 ${arr.length - at} 인 char 배열에 ${bytes.length + 1} 바이트를 쓰려고 합니다`)
  for (let i = 0; i < n; i++) arr[at + i] = bytes[i] > 127 ? bytes[i] - 256 : bytes[i]
  arr[at + n] = 0
}

/** 바이트 배열 길이 (0 전까지) */
export function cstrLen(v: unknown): number {
  if (typeof v === 'string') return utf8(v).length
  return utf8(cstrText(v)).length
}

// ------------------------------------------------------------ 숫자 표기 (Arduino Print)

export const DEC = 10
export const HEX = 16
export const OCT = 8
export const BIN = 2

/** Print::print(정수, 진법). 10진수가 아니면 부호 없는 32비트로 */
export function formatInt(v: number, t: CType, base = DEC): string {
  if (base === DEC || base < 2 || base > 36) return String(v)
  const bits = t.k === 'int' && t.bits === 64 ? 64 : 32
  const u = bits === 64 ? BigInt.asUintN(64, BigInt(Math.trunc(v))) : BigInt(wrapInt(v, 32, false))
  return u.toString(base).toUpperCase()
}

/** Print::printFloat (기본 소수 둘째 자리, nan · inf · ovf) */
export function formatFloat(v: number, digits = 2): string {
  if (Number.isNaN(v)) return 'nan'
  if (!Number.isFinite(v)) return 'inf'
  if (v > 4294967040.0 || v < -4294967040.0) return 'ovf'
  let out = ''
  let n = v
  if (n < 0) {
    out = '-'
    n = -n
  }
  let rounding = 0.5
  for (let i = 0; i < digits; i++) rounding /= 10
  n += rounding
  const whole = Math.floor(n)
  let rest = n - whole
  out += String(whole)
  if (digits > 0) out += '.'
  for (let i = 0; i < digits; i++) {
    rest *= 10
    const d = Math.floor(rest)
    out += String(d)
    rest -= d
  }
  return out
}

/** Serial.print(x[, fmt]) 의 글자 */
export function printText(v: unknown, t: CType, fmt?: number): string {
  if (t.k === 'int') {
    if (t.char && fmt === undefined) return String.fromCharCode(Number(v) & 255)
    if (t.bool && fmt === undefined) return v ? '1' : '0'
    // print(unsigned char) 는 숫자로 출력한다
    return formatInt(Number(v), t, fmt ?? DEC)
  }
  if (t.k === 'float') return formatFloat(Number(v), fmt ?? 2)
  if (t.k === 'String') return String(v)
  if (t.k === 'ptr' || t.k === 'array') {
    const el = t.k === 'ptr' ? t.to : t.of
    if (el.k === 'int' && el.bits === 8) return cstrText(v)
    return '0x0'
  }
  if (t.k === 'any') return typeof v === 'number' ? String(v) : cstrText(v)
  return ''
}

/** String(값[, 진법·자릿수]) */
export function toArduinoString(v: unknown, t: CType, arg?: number): string {
  if (t.k === 'int') {
    if (t.char && arg === undefined) return String.fromCharCode(Number(v) & 255)
    const n = Number(v)
    const base = arg ?? DEC
    if (base === DEC) return String(n)
    // itoa / ultoa: 10진수가 아니면 부호 없는 값으로, 소문자
    const bits = t.bits === 64 ? 64 : t.bits <= 16 ? 16 : 32
    const u = n < 0 ? (bits === 64 ? BigInt.asUintN(64, BigInt(n)) : BigInt(wrapInt(n, bits === 16 && t.signed ? 16 : 32, false))) : BigInt(n)
    return u.toString(base)
  }
  if (t.k === 'float') return formatFloat(Number(v), arg ?? 2)
  if (t.k === 'String') return String(v)
  return cstrText(v)
}

// ------------------------------------------------------------ sprintf

/** printf 형식 (AVR 은 %f 를 지원하지 않아 '?' 를 쓴다) */
export function sprintf(fmt: string, args: unknown[], types: CType[], avr: boolean, onFloatOnAvr?: () => void): string {
  let out = ''
  let ai = 0
  const take = () => {
    const v = args[ai]
    const t = types[ai]
    ai++
    return { v, t }
  }
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i]
    if (c !== '%') {
      out += c
      continue
    }
    const m = /^%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?(hh|h|ll|l|L|z|j|t)?([diuxXoscfFeEgGp%])/.exec(fmt.slice(i))
    if (!m) {
      out += c
      continue
    }
    i += m[0].length - 1
    const [, flags, w, prec, len, conv] = m
    if (conv === '%') {
      out += '%'
      continue
    }
    const width = w === '*' ? Number(take().v) : w ? Number(w) : 0
    const precision = prec === '*' ? Number(take().v) : prec !== undefined ? Number(prec) : undefined
    const { v, t } = take()
    let body: string
    let numeric = true
    switch (conv) {
      case 'd':
      case 'i': {
        const bits = len === 'l' ? 32 : len === 'll' ? 64 : len === 'h' ? 16 : len === 'hh' ? 8 : avr ? 16 : 32
        const n = wrapInt(Number(v ?? 0), bits, true)
        body = String(Math.abs(n))
        if (precision !== undefined) body = body.padStart(precision, '0')
        body = (n < 0 ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '') + body
        break
      }
      case 'u':
      case 'x':
      case 'X':
      case 'o': {
        const bits = len === 'l' ? 32 : len === 'll' ? 64 : len === 'h' ? 16 : len === 'hh' ? 8 : avr ? 16 : 32
        const n = bits === 64 ? BigInt.asUintN(64, BigInt(Math.trunc(Number(v ?? 0)))) : BigInt(wrapInt(Number(v ?? 0), bits, false))
        body = n.toString(conv === 'u' ? 10 : conv === 'o' ? 8 : 16)
        if (conv === 'X') body = body.toUpperCase()
        if (precision !== undefined) body = body.padStart(precision, '0')
        if (flags.includes('#') && n !== 0n && conv !== 'u') body = (conv === 'o' ? '0' : conv === 'x' ? '0x' : '0X') + body
        break
      }
      case 'c':
        body = String.fromCharCode(Number(v) & 255)
        numeric = false
        break
      case 's':
        body = cstrText(v)
        if (precision !== undefined) body = body.slice(0, precision)
        numeric = false
        break
      case 'p':
        body = '0x0'
        break
      default: {
        // 실수
        if (avr) {
          onFloatOnAvr?.()
          body = '?'
          numeric = false
          break
        }
        const n = Number(v)
        const p = precision ?? 6
        if (!Number.isFinite(n)) body = Number.isNaN(n) ? 'nan' : n < 0 ? '-inf' : 'inf'
        else if (conv === 'f' || conv === 'F') body = n.toFixed(p)
        else if (conv === 'e' || conv === 'E') body = n.toExponential(p).replace(/e([+-])(\d)$/, 'e$10$2')
        else body = String(Number(n.toPrecision(p || 1)))
        if (conv === 'E' || conv === 'G') body = body.toUpperCase()
        if (n >= 0 && flags.includes('+')) body = `+${body}`
        void t
      }
    }
    if (body.length < width) {
      if (flags.includes('-')) body = body.padEnd(width, ' ')
      else if (flags.includes('0') && numeric && precision === undefined) {
        const sign = /^[-+ ]/.test(body) ? body[0] : ''
        body = sign + body.slice(sign.length).padStart(width - sign.length, '0')
      } else body = body.padStart(width, ' ')
    }
    out += body
  }
  return out
}

/** dtostrf(값, 너비, 소수 자릿수) */
export function dtostrf(v: number, width: number, prec: number): string {
  let s = Number.isNaN(v) ? 'nan' : !Number.isFinite(v) ? (v < 0 ? '-inf' : 'inf') : v.toFixed(Math.max(0, prec))
  const w = Math.abs(width)
  if (s.length < w) s = width < 0 ? s.padEnd(w, ' ') : s.padStart(w, ' ')
  return s
}

/** 글자를 정수로 (String.toInt, atoi: 앞 공백·부호·숫자만) */
export function parseLeadingInt(s: string): number {
  const m = /^\s*([+-]?\d+)/.exec(s)
  return m ? Number(m[1]) : 0
}

export function parseLeadingFloat(s: string): number {
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(s)
  return m ? Number(m[1]) : 0
}
