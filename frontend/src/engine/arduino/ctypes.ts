// C 자료형과 값 변환 (AVR: int 16비트·double 32비트, ESP32: int 32비트·double 64비트)

export type CType =
  | { k: 'void' }
  | { k: 'int'; bits: 8 | 16 | 32 | 64; signed: boolean; char?: boolean; bool?: boolean; name: string }
  | { k: 'float'; bits: 32 | 64; name: string }
  | { k: 'String' }
  | { k: 'ptr'; to: CType }
  | { k: 'array'; of: CType; len: number | null }
  | { k: 'struct'; name: string; fields: { name: string; type: CType }[] }
  | { k: 'obj'; cls: string }
  | { k: 'fn'; name?: string }
  | { k: 'any' }

export type IntT = Extract<CType, { k: 'int' }>
export type FloatT = Extract<CType, { k: 'float' }>

export interface Platform {
  core: 'avr' | 'esp32'
  intBits: 16 | 32
  doubleBits: 32 | 64
}

export const AVR: Platform = { core: 'avr', intBits: 16, doubleBits: 32 }
export const ESP32: Platform = { core: 'esp32', intBits: 32, doubleBits: 64 }

export const VOID: CType = { k: 'void' }
export const ANY: CType = { k: 'any' }
export const STRING: CType = { k: 'String' }
export const BOOL: IntT = { k: 'int', bits: 8, signed: false, bool: true, name: 'bool' }
export const CHAR: IntT = { k: 'int', bits: 8, signed: true, char: true, name: 'char' }
export const U8: IntT = { k: 'int', bits: 8, signed: false, name: 'uint8_t' }
export const I8: IntT = { k: 'int', bits: 8, signed: true, name: 'int8_t' }
export const U16: IntT = { k: 'int', bits: 16, signed: false, name: 'uint16_t' }
export const I16: IntT = { k: 'int', bits: 16, signed: true, name: 'int16_t' }
export const U32: IntT = { k: 'int', bits: 32, signed: false, name: 'uint32_t' }
export const I32: IntT = { k: 'int', bits: 32, signed: true, name: 'int32_t' }
export const U64: IntT = { k: 'int', bits: 64, signed: false, name: 'uint64_t' }
export const I64: IntT = { k: 'int', bits: 64, signed: true, name: 'int64_t' }
export const F32: FloatT = { k: 'float', bits: 32, name: 'float' }
export const F64: FloatT = { k: 'float', bits: 64, name: 'double' }
export const CSTR: CType = { k: 'ptr', to: CHAR }
export const FN: CType = { k: 'fn' }

export function intOf(p: Platform, signed = true): IntT {
  return p.intBits === 16 ? (signed ? { ...I16, name: 'int' } : { ...U16, name: 'unsigned int' }) : signed ? { ...I32, name: 'int' } : { ...U32, name: 'unsigned int' }
}
export const longOf = (signed = true): IntT => (signed ? { ...I32, name: 'long' } : { ...U32, name: 'unsigned long' })
export const doubleOf = (p: Platform): CType => (p.doubleBits === 32 ? { ...F32, name: 'double' } : F64)

/** 기본 자료형 이름 → 형 (여러 단어 이름은 공백 하나로 합친 뒤 찾는다) */
export function basicType(name: string, p: Platform): CType | null {
  const int = intOf(p)
  const uint = intOf(p, false)
  switch (name) {
    case 'void':
      return VOID
    case 'bool':
    case 'boolean':
      return BOOL
    case 'char':
    case 'signed char':
      return CHAR
    case 'unsigned char':
    case 'byte':
    case 'uint8_t':
    case 'uint_fast8_t':
    case 'uint_least8_t':
      return { ...U8, name: name === 'byte' ? 'byte' : name }
    case 'int8_t':
      return I8
    case 'short':
    case 'short int':
    case 'signed short':
    case 'int16_t':
      return { ...I16, name }
    case 'unsigned short':
    case 'unsigned short int':
    case 'uint16_t':
    case 'word':
      return { ...U16, name }
    case 'int':
    case 'signed':
    case 'signed int':
      return int
    case 'unsigned':
    case 'unsigned int':
      return uint
    case 'size_t':
      return p.intBits === 16 ? { ...U16, name: 'size_t' } : { ...U32, name: 'size_t' }
    case 'long':
    case 'long int':
    case 'signed long':
    case 'int32_t':
      return { ...I32, name }
    case 'unsigned long':
    case 'unsigned long int':
    case 'uint32_t':
      return { ...U32, name }
    case 'long long':
    case 'long long int':
    case 'int64_t':
      return { ...I64, name }
    case 'unsigned long long':
    case 'uint64_t':
      return { ...U64, name }
    case 'float':
      return F32
    case 'double':
    case 'long double':
      return doubleOf(p)
    case 'String':
      return STRING
  }
  return null
}

export const isInt = (t: CType): t is Extract<CType, { k: 'int' }> => t.k === 'int'
export const isNum = (t: CType) => t.k === 'int' || t.k === 'float'
export const isCharPtr = (t: CType) => (t.k === 'ptr' || t.k === 'array') && (t.k === 'ptr' ? t.to : t.of).k === 'int' && ((t.k === 'ptr' ? t.to : t.of) as { char?: boolean; bits: number }).bits === 8

export function typeName(t: CType): string {
  switch (t.k) {
    case 'int':
    case 'float':
      return t.name
    case 'ptr':
      return `${typeName(t.to)}*`
    case 'array':
      return `${typeName(t.of)}[${t.len ?? ''}]`
    case 'struct':
      return t.name
    case 'obj':
      return t.cls
    case 'fn':
      return '함수'
    default:
      return t.k
  }
}

const P32 = 2 ** 32
const P64 = 2 ** 64

/** 정수형으로 바꾸기 (C 의 잘림·넘침 규칙) */
export function wrapInt(v: number, bits: number, signed: boolean): number {
  if (!Number.isFinite(v)) return 0
  if (bits === 32) return signed ? Math.trunc(v) | 0 : (Math.trunc(v) % P32 + P32) % P32
  if (bits === 64) {
    let x = Math.trunc(v)
    if (Math.abs(x) >= P64) x %= P64
    if (!signed && x < 0) x += P64
    if (signed && x >= 2 ** 63) x -= P64
    return x
  }
  const m = 2 ** bits
  let x = Math.trunc(v) % m
  if (x < 0) x += m
  if (signed && x >= m / 2) x -= m
  return x
}

/** 값을 형에 맞게 바꾼다 (대입·인자 전달·반환) */
export function convert(v: unknown, t: CType): unknown {
  switch (t.k) {
    case 'int':
      if (t.bool) return truthy(v) ? 1 : 0
      return wrapInt(toNumber(v), t.bits, t.signed)
    case 'float':
      return t.bits === 32 ? Math.fround(toNumber(v)) : toNumber(v)
    default:
      return v
  }
}

export function toNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v === null || v === undefined) return 0
  if (typeof v === 'string') return 1 // 포인터 값 (NULL 이 아님)
  return 1
}

export function truthy(v: unknown): boolean {
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v) ? true : Number.isNaN(v)
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return true
  return !!v
}

/** 정수 승격 (int 보다 작은 형 → int) */
export function promote(t: CType, p: Platform): CType {
  if (t.k !== 'int') return t
  if (t.bits < p.intBits || t.bool || (t.bits === p.intBits && t.signed)) return t.bits < p.intBits || t.bool ? intOf(p) : t
  return t
}

/** 이항 산술의 공통 형 (usual arithmetic conversions) */
export function common(a: CType, b: CType, p: Platform): CType {
  if (a.k === 'float' || b.k === 'float') {
    const bits = Math.max(a.k === 'float' ? a.bits : 0, b.k === 'float' ? b.bits : 0)
    return bits === 64 ? F64 : a.k === 'float' && a.bits === 32 && b.k === 'float' && b.bits === 32 ? F32 : a.k === 'float' ? a : b
  }
  if (a.k !== 'int' || b.k !== 'int') return a.k === 'int' ? a : b.k === 'int' ? b : intOf(p)
  const pa = promote(a, p) as Extract<CType, { k: 'int' }>
  const pb = promote(b, p) as Extract<CType, { k: 'int' }>
  if (pa.signed === pb.signed) return pa.bits >= pb.bits ? pa : pb
  const [s, u] = pa.signed ? [pa, pb] : [pb, pa]
  if (u.bits >= s.bits) return u
  return s
}

export function sameType(a: CType, b: CType): boolean {
  if (a.k !== b.k) return false
  if (a.k === 'int' && b.k === 'int') return a.bits === b.bits && a.signed === b.signed && !!a.char === !!b.char && !!a.bool === !!b.bool
  if (a.k === 'float' && b.k === 'float') return a.bits === b.bits
  if (a.k === 'ptr' && b.k === 'ptr') return sameType(a.to, b.to)
  if (a.k === 'struct' && b.k === 'struct') return a.name === b.name
  if (a.k === 'obj' && b.k === 'obj') return a.cls === b.cls
  return true
}

/** 형의 크기(바이트). sizeof 에 쓴다 */
export function sizeOf(t: CType, p: Platform): number {
  switch (t.k) {
    case 'int':
      return t.bits / 8
    case 'float':
      return t.bits / 8
    case 'ptr':
      return p.core === 'avr' ? 2 : 4
    case 'array':
      return (t.len ?? 0) * sizeOf(t.of, p)
    case 'struct':
      return t.fields.reduce((n, f) => n + sizeOf(f.type, p), 0)
    case 'String':
      return 6
    default:
      return p.core === 'avr' ? 2 : 4
  }
}

/** 형의 기본값 (전역·static 변수는 0 으로 초기화된다) */
export function zeroOf(t: CType): unknown {
  switch (t.k) {
    case 'int':
    case 'float':
      return 0
    case 'String':
      return ''
    case 'array':
      return Array.from({ length: t.len ?? 0 }, () => zeroOf(t.of))
    case 'struct': {
      const o: Record<string, unknown> = {}
      for (const f of t.fields) o[f.name] = zeroOf(f.type)
      return o
    }
    case 'ptr':
      return null
    default:
      return null
  }
}

/** 구조체·배열 값 복사 (대입할 때 C 처럼 값이 복사된다) */
export function cloneValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(cloneValue)
  if (v && typeof v === 'object' && (v as { constructor?: unknown }).constructor === Object) {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) o[k] = cloneValue(x)
    return o
  }
  return v
}
