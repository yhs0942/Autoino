import { CompileError, type Tok } from './lexer'

// 구문 분석: 토큰 → 구문 트리
// Arduino 스케치에서 흔히 쓰는 C++ 부분(전역 변수·함수·구조체·열거형·라이브러리 객체, 모든 제어문과 연산자)을 다룬다.
// 사용자 class·템플릿·람다·new 는 지원하지 않는다고 알린다.

export interface TypeSpec {
  /** 기본 이름 (예: 'unsigned long', 'Servo', 'struct:Point', 'MFRC522::Uid', 'auto') */
  name: string
  ptr: number
  ref: boolean
  isConst: boolean
  isStatic: boolean
  /** 배열 크기 (선언자에서 붙음). null 은 int a[] 처럼 크기를 비운 것 */
  dims: (Expr | null)[]
  line: number
}

export type Expr =
  | { k: 'num'; v: number; float: boolean; single: boolean; unsigned: boolean; longs: number; radix: boolean; line: number }
  | { k: 'chr'; v: number; line: number }
  | { k: 'str'; v: string; line: number }
  | { k: 'bool'; v: boolean; line: number }
  | { k: 'null'; line: number }
  | { k: 'id'; name: string; line: number }
  | { k: 'bin'; op: string; a: Expr; b: Expr; line: number }
  | { k: 'un'; op: string; a: Expr; line: number }
  | { k: 'post'; op: '++' | '--'; a: Expr; line: number }
  | { k: 'assign'; op: string; a: Expr; b: Expr; line: number }
  | { k: 'cond'; c: Expr; a: Expr; b: Expr; line: number }
  | { k: 'call'; fn: Expr; args: Expr[]; targs?: (TypeSpec | Expr)[]; line: number }
  | { k: 'member'; obj: Expr; name: string; arrow: boolean; line: number }
  | { k: 'index'; a: Expr; i: Expr; line: number }
  | { k: 'cast'; t: TypeSpec; a: Expr; line: number }
  | { k: 'ctor'; t: TypeSpec; args: Expr[]; line: number }
  | { k: 'sizeof'; t?: TypeSpec; a?: Expr; line: number }
  | { k: 'init'; items: Expr[]; line: number }
  | { k: 'comma'; a: Expr; b: Expr; line: number }

export interface VarDecl {
  name: string
  type: TypeSpec
  init?: Expr
  /** Servo s(…) 처럼 괄호로 만든 객체 */
  ctorArgs?: Expr[]
  line: number
}

export type Stmt =
  | { k: 'block'; body: Stmt[]; line: number }
  | { k: 'expr'; e: Expr; line: number }
  | { k: 'decl'; decls: VarDecl[]; line: number }
  | { k: 'if'; c: Expr; a: Stmt; b?: Stmt; line: number }
  | { k: 'while'; c: Expr; body: Stmt; line: number }
  | { k: 'do'; body: Stmt; c: Expr; line: number }
  | { k: 'for'; init?: Stmt; c?: Expr; step?: Expr; body: Stmt; line: number }
  | { k: 'forin'; decl: VarDecl; range: Expr; body: Stmt; line: number }
  | { k: 'switch'; e: Expr; body: Stmt[]; cases: { test: Expr | null; at: number; line: number }[]; line: number }
  | { k: 'break'; line: number }
  | { k: 'continue'; line: number }
  | { k: 'return'; e?: Expr; line: number }
  | { k: 'empty'; line: number }

export interface Param {
  name: string
  type: TypeSpec
  def?: Expr
}

export interface FuncDef {
  name: string
  ret: TypeSpec
  params: Param[]
  body: Stmt & { k: 'block' }
  line: number
}

export interface StructDef {
  name: string
  fields: { name: string; type: TypeSpec; init?: Expr }[]
  line: number
}

export interface EnumDef {
  name?: string
  items: { name: string; value?: Expr; line: number }[]
  line: number
}

export type Top =
  | { k: 'func'; f: FuncDef }
  | { k: 'proto'; name: string; line: number }
  | { k: 'vars'; decls: VarDecl[]; line: number }
  | { k: 'struct'; s: StructDef }
  | { k: 'enum'; e: EnumDef }
  | { k: 'typedef'; name: string; type: TypeSpec; line: number }

const BASIC_WORDS = new Set(['void', 'bool', 'boolean', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', 'byte', 'word', 'auto'])
const QUALIFIERS = new Set(['const', 'volatile', 'static', 'extern', 'inline', 'constexpr', 'register', 'PROGMEM', 'IRAM_ATTR', 'ICACHE_RAM_ATTR', 'ARDUINO_ISR_ATTR', 'DRAM_ATTR', 'mutable', 'typename', 'unsigned', 'signed'])
const KEYWORDS = new Set(['if', 'else', 'while', 'do', 'for', 'switch', 'case', 'default', 'break', 'continue', 'return', 'sizeof', 'struct', 'enum', 'typedef', 'class', 'union', 'goto', 'new', 'delete', 'template', 'namespace', 'using', 'this', 'true', 'false', 'nullptr'])
const TEMPLATE_METHODS = new Set(['addLeds'])
/** 형 이름 (typedef 가 필요 없는 기본 이름) */
export const BASIC_TYPE_NAMES = ['String', 'uint8_t', 'int8_t', 'uint16_t', 'int16_t', 'uint32_t', 'int32_t', 'uint64_t', 'int64_t', 'size_t', 'uint_fast8_t', 'uint_least8_t']
/** 라이브러리 형 → 필요한 헤더 (선언되지 않은 형을 알려 줄 때) */
export const LIBRARY_TYPES: Record<string, string> = {
  Servo: 'Servo.h',
  LiquidCrystal_I2C: 'LiquidCrystal_I2C.h',
  Adafruit_SSD1306: 'Adafruit_SSD1306.h',
  Adafruit_NeoPixel: 'Adafruit_NeoPixel.h',
  TM1637Display: 'TM1637Display.h',
  DHT: 'DHT.h',
  NewPing: 'NewPing.h',
  MFRC522: 'MFRC522.h',
  SoftwareSerial: 'SoftwareSerial.h',
  Stepper: 'Stepper.h',
  AccelStepper: 'AccelStepper.h',
  Adafruit_PWMServoDriver: 'Adafruit_PWMServoDriver.h',
  Adafruit_MPU6050: 'Adafruit_MPU6050.h',
  MPU6050: 'MPU6050.h',
  CRGB: 'FastLED.h',
  sensors_event_t: 'Adafruit_Sensor.h',
}
const CASTS = new Set(['static_cast', 'reinterpret_cast', 'const_cast', 'dynamic_cast'])

export class Parser {
  private p = 0
  private readonly toks: Tok[]
  readonly typeNames: Set<string>

  constructor(toks: Tok[], typeNames: Iterable<string>) {
    this.toks = toks
    this.typeNames = new Set(typeNames)
  }

  // ------------------------------------------------------------ 토큰

  private get t(): Tok {
    return this.toks[this.p]
  }
  private atEnd(): boolean {
    return this.toks[this.p].k === 'eof'
  }
  private at(k: number): Tok {
    return this.toks[Math.min(this.p + k, this.toks.length - 1)]
  }
  private is(v: string, k = 0): boolean {
    const t = this.at(k)
    return (t.k === 'op' || t.k === 'id') && t.v === v
  }
  private next(): Tok {
    const t = this.t
    if (t.k !== 'eof') this.p++
    return t
  }
  private eat(v: string): boolean {
    if (this.is(v)) {
      this.p++
      return true
    }
    return false
  }
  private expect(v: string, what?: string): Tok {
    // ';' · ')' 가 빠졌으면 그 앞 줄(빠뜨린 줄)을 알려 준다 (gcc 와 같은 방식)
    const line = (v === ';' || v === ')') && this.p > 0 ? this.toks[this.p - 1].line : this.t.line
    if (!this.is(v)) throw this.err(`'${v}' 이(가) 필요합니다${what ? ` (${what})` : ''}${this.t.k === 'eof' ? ' — 코드가 중간에 끝났습니다' : ` — '${this.t.v}' 앞`}`, line)
    return this.next()
  }
  private ident(what = '이름'): string {
    const t = this.t
    if (t.k !== 'id' || KEYWORDS.has(t.v)) throw this.err(`${what}이(가) 필요합니다 — '${t.v || '끝'}' 앞`)
    this.p++
    return t.v
  }
  private err(message: string, line = this.t.line): CompileError {
    return new CompileError(message, line)
  }

  /** 'Servo s;' 처럼 모르는 이름 뒤에 변수 이름이 오면: 형을 모르는 것 */
  private unknownTypeCheck() {
    const t = this.t
    const n = this.at(1)
    if (t.k !== 'id' || KEYWORDS.has(t.v) || n.k !== 'id' || KEYWORDS.has(n.v)) return
    const after = this.at(2).v
    if (![';', '=', '(', ',', '[', ')'].includes(after)) return
    const header = LIBRARY_TYPES[t.v]
    throw this.err(header ? `'${t.v}' 형을 쓰려면 #include <${header}> 가 필요합니다` : `'${t.v}' 은(는) 알 수 없는 형입니다`)
  }

  /** A::B::C 처럼 범위가 붙은 이름 */
  private qualified(): string {
    let name = this.ident()
    while (this.is('::') && this.at(1).k === 'id') {
      this.p++
      name += `::${this.next().v}`
    }
    return name
  }

  private peekQualified(): { name: string; len: number } | null {
    if (this.t.k !== 'id') return null
    let name = this.t.v
    let len = 1
    while (this.at(len).v === '::' && this.at(len + 1).k === 'id') {
      name += `::${this.at(len + 1).v}`
      len += 2
    }
    return { name, len }
  }

  // ------------------------------------------------------------ 형

  /** 지금 위치가 형 이름으로 시작하는지 */
  isTypeStart(k = 0): boolean {
    const t = this.at(k)
    if (t.k !== 'id') return false
    if (BASIC_WORDS.has(t.v) || QUALIFIERS.has(t.v) || t.v === 'struct' || t.v === 'enum') return true
    let name = t.v
    let len = 1
    while (this.at(k + len).v === '::' && this.at(k + len + 1).k === 'id') {
      name += `::${this.at(k + len + 1).v}`
      len += 2
    }
    return this.typeNames.has(name)
  }

  /** 형 지정자 (const unsigned long, Servo, struct Point, MFRC522::Uid …) */
  typeSpec(): TypeSpec {
    const line = this.t.line
    let isConst = false
    let isStatic = false
    const words: string[] = []
    let named: string | null = null
    for (;;) {
      const t = this.t
      if (t.k !== 'id') break
      if (t.v === 'const' || t.v === 'constexpr') {
        isConst = true
        this.p++
        continue
      }
      if (t.v === 'static') {
        isStatic = true
        this.p++
        continue
      }
      if (QUALIFIERS.has(t.v) && t.v !== 'unsigned' && t.v !== 'signed') {
        this.p++
        continue
      }
      if (named) break
      if (t.v === 'struct' || t.v === 'enum' || t.v === 'union') {
        if (t.v === 'union') throw this.err('union 은 지원하지 않습니다')
        this.p++
        const n = this.ident('구조체 이름')
        named = t.v === 'enum' ? 'int' : `struct:${n}`
        if (t.v === 'enum' && !this.typeNames.has(n)) this.typeNames.add(n)
        continue
      }
      if (BASIC_WORDS.has(t.v) || t.v === 'unsigned' || t.v === 'signed') {
        words.push(t.v)
        this.p++
        continue
      }
      if (words.length) break
      const q = this.peekQualified()
      if (q && this.typeNames.has(q.name)) {
        named = q.name
        this.p += q.len
        continue
      }
      break
    }
    if (!named && !words.length) throw this.err(`형 이름이 필요합니다 — '${this.t.v}' 앞`)
    let name = named ?? normalizeWords(words)
    if (named && words.length) name = normalizeWords(words)
    if (name === 'auto' && !named) name = 'auto'
    let ptr = 0
    let ref = false
    for (;;) {
      if (this.eat('*')) {
        ptr++
        continue
      }
      if (this.eat('&')) {
        ref = true
        continue
      }
      if (this.is('const') || this.is('volatile') || this.is('PROGMEM')) {
        if (this.is('const')) isConst = true
        this.p++
        continue
      }
      break
    }
    return { name, ptr, ref, isConst, isStatic, dims: [], line }
  }

  /** 선언자: *name[3][4] PROGMEM. 형에 포인터·배열을 붙여 돌려준다 */
  private declarator(base: TypeSpec, allowUnnamed = false): { name: string; type: TypeSpec } {
    const type: TypeSpec = { ...base, dims: [] }
    for (;;) {
      if (this.eat('*')) {
        type.ptr++
        continue
      }
      if (this.eat('&')) {
        type.ref = true
        continue
      }
      if (this.is('const') || this.is('volatile')) {
        this.p++
        continue
      }
      break
    }
    if (this.is('(') && this.is('*', 1)) throw this.err('함수 포인터 선언은 지원하지 않습니다')
    let name = ''
    if (this.t.k === 'id' && !KEYWORDS.has(this.t.v) && !this.isTypeStart()) name = this.next().v
    else if (!allowUnnamed) throw this.err(`변수 이름이 필요합니다 — '${this.t.v}' 앞`)
    while (this.eat('[')) {
      type.dims.push(this.is(']') ? null : this.expr())
      this.expect(']')
    }
    while (this.is('PROGMEM') || this.is('IRAM_ATTR') || this.is('DRAM_ATTR')) this.p++
    return { name, type }
  }

  // ------------------------------------------------------------ 최상위

  program(): Top[] {
    const out: Top[] = []
    while (this.t.k !== 'eof') {
      if (this.eat(';')) continue
      out.push(...this.top())
    }
    return out
  }

  private top(): Top[] {
    const line = this.t.line
    const v = this.t.v
    if (this.t.k === 'id') {
      if (v === 'class') throw this.err('사용자 class 정의는 지원하지 않습니다. struct 와 함수로 바꿔 주세요')
      if (v === 'template') throw this.err('템플릿은 지원하지 않습니다')
      if (v === 'namespace') throw this.err('namespace 는 지원하지 않습니다')
      if (v === 'using') {
        while (!this.is(';') && !this.atEnd()) this.p++
        this.eat(';')
        return []
      }
      if (v === 'extern' && this.at(1).k === 'str') throw this.err('extern "C" 는 지원하지 않습니다')
      if (v === 'typedef') return [this.typedef()]
      if (v === 'struct' && this.at(1).k === 'id' && (this.is('{', 2) || this.is(';', 2))) {
        const s = this.structDef()
        const vars = this.restOfStructDecl(s.name, line)
        return [{ k: 'struct', s }, ...vars]
      }
      if (v === 'struct' && this.is('{', 1)) throw this.err('이름 없는 struct 는 typedef 와 함께 쓰세요')
      if (v === 'enum' && (this.is('{', 1) || (this.at(1).k === 'id' && (this.is('{', 2) || this.is(':', 2))) || (this.is('class', 1) && this.at(2).k === 'id'))) {
        const e = this.enumDef()
        this.eat(';')
        return [{ k: 'enum', e }]
      }
      if (v === 'ISR' && this.is('(', 1)) {
        this.p += 2
        const vec = this.ident('인터럽트 벡터')
        while (!this.is(')') && !this.atEnd()) this.p++
        this.expect(')')
        const body = this.block()
        return [{ k: 'func', f: { name: `ISR:${vec}`, ret: { name: 'void', ptr: 0, ref: false, isConst: false, isStatic: false, dims: [], line }, params: [], body, line } }]
      }
    }
    if (!this.isTypeStart()) {
      this.unknownTypeCheck()
      if (this.t.k === 'id' && this.is('(', 1)) throw this.err(`함수 '${v}' 의 반환형이 없습니다 (예: void ${v}())`)
      throw this.err(`여기에는 선언이 와야 합니다 — '${v}'`)
    }
    const base = this.typeSpec()
    // 함수 정의 / 원형
    if (this.t.k === 'id' && (this.is('(', 1) || (this.is('::', 1) && this.is('(', 3)))) {
      const save = this.p
      const name = this.qualified()
      if (name.includes('::')) throw this.err('클래스 메서드 정의는 지원하지 않습니다')
      this.expect('(')
      if (this.looksLikeParams()) {
        const params = this.params()
        while (this.is('const') || this.is('override') || this.is('IRAM_ATTR')) this.p++
        if (this.eat(';')) return [{ k: 'proto', name, line }]
        if (!this.is('{')) throw this.err(`함수 ${name} 의 본문 { } 이(가) 필요합니다`)
        const body = this.block()
        return [{ k: 'func', f: { name, ret: base, params, body, line } }]
      }
      this.p = save
    }
    const decls = this.declList(base)
    return [{ k: 'vars', decls, line }]
  }

  /** ( 다음이 매개변수 목록인지 (비어 있거나 형 이름으로 시작) */
  private looksLikeParams(): boolean {
    if (this.is(')')) return true
    if (this.is('void') && this.is(')', 1)) return true
    return this.isTypeStart()
  }

  private params(): Param[] {
    const out: Param[] = []
    if (this.is('void') && this.is(')', 1)) {
      this.p += 2
      return out
    }
    while (!this.eat(')')) {
      if (this.is('...')) throw this.err('가변 인자 함수는 지원하지 않습니다')
      const base = this.typeSpec()
      const { name, type } = this.declarator(base, true)
      const param: Param = { name, type }
      if (this.eat('=')) param.def = this.assign()
      out.push(param)
      if (!this.is(')')) this.expect(',', '매개변수 사이')
    }
    return out
  }

  private declList(base: TypeSpec): VarDecl[] {
    const decls: VarDecl[] = []
    for (;;) {
      const line = this.t.line
      const { name, type } = this.declarator(base)
      const d: VarDecl = { name, type, line }
      if (this.eat('=')) d.init = this.is('{') ? this.initList() : this.assign()
      else if (this.is('{')) d.init = this.initList()
      else if (this.is('(')) {
        this.p++
        d.ctorArgs = []
        while (!this.eat(')')) {
          d.ctorArgs.push(this.assign())
          if (!this.is(')')) this.expect(',', '인자 사이')
        }
      }
      decls.push(d)
      if (this.eat(',')) continue
      this.expect(';', '선언 끝')
      return decls
    }
  }

  private initList(): Expr {
    const line = this.expect('{').line
    const items: Expr[] = []
    while (!this.eat('}')) {
      if (this.is('.') && this.at(1).k === 'id' && this.is('=', 2)) this.p += 3 // 지정 초기화 (.x = 1) 는 순서대로 본다
      items.push(this.is('{') ? this.initList() : this.assign())
      if (!this.is('}')) this.expect(',', '초기값 사이')
    }
    return { k: 'init', items, line }
  }

  private typedef(): Top {
    const line = this.next().line
    if (this.is('struct') && (this.is('{', 1) || (this.at(1).k === 'id' && this.is('{', 2)))) {
      this.p++
      const tag = this.t.k === 'id' ? this.next().v : `anon${line}`
      const s = this.structBody(tag, line)
      const alias = this.ident('typedef 이름')
      this.typeNames.add(alias)
      this.expect(';')
      return { k: 'struct', s: { ...s, name: alias } }
    }
    if (this.is('enum')) {
      const e = this.enumDef()
      const alias = this.ident('typedef 이름')
      this.typeNames.add(alias)
      this.expect(';')
      return { k: 'enum', e: { ...e, name: alias } }
    }
    const base = this.typeSpec()
    if (this.is('(')) throw this.err('함수 포인터 typedef 는 지원하지 않습니다')
    const { name, type } = this.declarator(base)
    this.typeNames.add(name)
    this.expect(';')
    return { k: 'typedef', name, type, line }
  }

  private structDef(): StructDef {
    const line = this.next().line
    const name = this.ident('구조체 이름')
    this.typeNames.add(name)
    if (this.is(';')) return { name, fields: [], line }
    return this.structBody(name, line)
  }

  private structBody(name: string, line: number): StructDef {
    this.typeNames.add(name)
    this.expect('{')
    const fields: StructDef['fields'] = []
    while (!this.eat('}')) {
      if (this.eat(';')) continue
      if (this.is('public') || this.is('private')) {
        this.p++
        this.expect(':')
        continue
      }
      const base = this.typeSpec()
      if (this.t.k === 'id' && this.is('(', 1)) throw this.err('구조체 안의 함수(메서드)는 지원하지 않습니다. 구조체 밖의 함수로 바꿔 주세요')
      if (this.is('(')) throw this.err('구조체 생성자는 지원하지 않습니다')
      for (;;) {
        const { name: fname, type } = this.declarator(base)
        const f: StructDef['fields'][number] = { name: fname, type }
        if (this.eat('=')) f.init = this.is('{') ? this.initList() : this.assign()
        fields.push(f)
        if (this.eat(',')) continue
        this.expect(';')
        break
      }
    }
    return { name, fields, line }
  }

  private restOfStructDecl(name: string, line: number): Top[] {
    if (this.eat(';')) return []
    const base: TypeSpec = { name: `struct:${name}`, ptr: 0, ref: false, isConst: false, isStatic: false, dims: [], line }
    return [{ k: 'vars', decls: this.declList(base), line }]
  }

  private enumDef(): EnumDef {
    const line = this.expect('enum').line
    this.eat('class')
    this.eat('struct')
    let name: string | undefined
    if (this.t.k === 'id') {
      name = this.next().v
      this.typeNames.add(name)
    }
    if (this.eat(':')) this.typeSpec()
    this.expect('{')
    const items: EnumDef['items'] = []
    while (!this.eat('}')) {
      const iline = this.t.line
      const n = this.ident('열거 상수')
      const item: EnumDef['items'][number] = { name: n, line: iline }
      if (this.eat('=')) item.value = this.cond()
      items.push(item)
      if (!this.is('}')) this.expect(',')
    }
    return { name, items, line }
  }

  // ------------------------------------------------------------ 문장

  block(): Stmt & { k: 'block' } {
    const line = this.expect('{').line
    const body: Stmt[] = []
    while (!this.eat('}')) {
      if (this.t.k === 'eof') throw this.err("'}' 이(가) 필요합니다 — 블록이 닫히지 않았습니다", line)
      body.push(this.stmt())
    }
    return { k: 'block', body, line }
  }

  private looksLikeDecl(): boolean {
    if (!this.isTypeStart()) return false
    const save = this.p
    try {
      const base = this.typeSpec()
      void base
      // 형 다음에 이름이 오면 선언 (String(x).length() 같은 식은 아님)
      while (this.is('*') || this.is('&')) this.p++
      return this.t.k === 'id' && !KEYWORDS.has(this.t.v)
    } catch {
      return false
    } finally {
      this.p = save
    }
  }

  stmt(): Stmt {
    const line = this.t.line
    const t = this.t
    if (t.k === 'op') {
      if (t.v === '{') return this.block()
      if (t.v === ';') {
        this.p++
        return { k: 'empty', line }
      }
    }
    if (t.k === 'id') {
      switch (t.v) {
        case 'if': {
          this.p++
          this.expect('(')
          const c = this.expr()
          this.expect(')')
          const a = this.stmt()
          const b = this.eat('else') ? this.stmt() : undefined
          return { k: 'if', c, a, b, line }
        }
        case 'while': {
          this.p++
          this.expect('(')
          const c = this.expr()
          this.expect(')')
          return { k: 'while', c, body: this.stmt(), line }
        }
        case 'do': {
          this.p++
          const body = this.stmt()
          this.expect('while')
          this.expect('(')
          const c = this.expr()
          this.expect(')')
          this.expect(';')
          return { k: 'do', body, c, line }
        }
        case 'for': {
          this.p++
          this.expect('(')
          // 범위 for: for (auto x : arr)
          if (this.isTypeStart()) {
            const save = this.p
            const base = this.typeSpec()
            if (this.t.k === 'id' && this.is(':', 1)) {
              const name = this.next().v
              this.p++
              const range = this.expr()
              this.expect(')')
              return { k: 'forin', decl: { name, type: base, line }, range, body: this.stmt(), line }
            }
            this.p = save
          }
          let init: Stmt | undefined
          if (!this.eat(';')) {
            if (this.looksLikeDecl()) {
              const base = this.typeSpec()
              init = { k: 'decl', decls: this.declList(base), line }
            } else {
              init = { k: 'expr', e: this.expr(), line }
              this.expect(';')
            }
          }
          const c = this.is(';') ? undefined : this.expr()
          this.expect(';')
          const step = this.is(')') ? undefined : this.expr()
          this.expect(')')
          return { k: 'for', init, c, step, body: this.stmt(), line }
        }
        case 'switch':
          return this.switchStmt()
        case 'break':
          this.p++
          this.expect(';')
          return { k: 'break', line }
        case 'continue':
          this.p++
          this.expect(';')
          return { k: 'continue', line }
        case 'return': {
          this.p++
          const e = this.is(';') ? undefined : this.expr()
          this.expect(';')
          return { k: 'return', e, line }
        }
        case 'goto':
          throw this.err('goto 는 지원하지 않습니다')
        case 'case':
        case 'default':
          throw this.err(`${t.v} 는 switch 안에서만 쓸 수 있습니다`)
        case 'typedef':
        case 'struct':
        case 'enum':
          if (t.v === 'enum' || t.v === 'typedef' || this.is('{', 2)) throw this.err(`함수 안의 ${t.v} 정의는 지원하지 않습니다. 함수 밖(전역)에 정의해 주세요`)
          break
        case 'else':
          throw this.err("'else' 앞에 짝이 되는 if 가 없습니다")
      }
      if (this.looksLikeDecl()) {
        const base = this.typeSpec()
        return { k: 'decl', decls: this.declList(base), line }
      }
      if (!this.isTypeStart()) this.unknownTypeCheck()
    }
    const e = this.expr()
    this.expect(';', '문장 끝')
    return { k: 'expr', e, line }
  }

  private switchStmt(): Stmt {
    const line = this.next().line
    this.expect('(')
    const e = this.expr()
    this.expect(')')
    this.expect('{')
    const body: Stmt[] = []
    const cases: { test: Expr | null; at: number; line: number }[] = []
    while (!this.eat('}')) {
      if (this.t.k === 'eof') throw this.err('switch 블록이 닫히지 않았습니다', line)
      const cl = this.t.line
      if (this.eat('case')) {
        const test = this.cond()
        if (this.eat('...')) throw this.err('case 범위(a ... b)는 지원하지 않습니다')
        this.expect(':')
        cases.push({ test, at: body.length, line: cl })
        continue
      }
      if (this.eat('default')) {
        this.expect(':')
        cases.push({ test: null, at: body.length, line: cl })
        continue
      }
      body.push(this.stmt())
    }
    return { k: 'switch', e, body, cases, line }
  }

  // ------------------------------------------------------------ 식

  expr(): Expr {
    let e = this.assign()
    while (this.is(',')) {
      const line = this.next().line
      e = { k: 'comma', a: e, b: this.assign(), line }
    }
    return e
  }

  assign(): Expr {
    const a = this.cond()
    const t = this.t
    if (t.k === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='].includes(t.v)) {
      this.p++
      const b = t.v === '=' && this.is('{') ? this.initList() : this.assign()
      return { k: 'assign', op: t.v, a, b, line: t.line }
    }
    return a
  }

  cond(): Expr {
    const c = this.binary(0)
    if (this.is('?')) {
      const line = this.next().line
      const a = this.assign()
      this.expect(':', '조건 연산자')
      const b = this.assign()
      return { k: 'cond', c, a, b, line }
    }
    return c
  }

  private static readonly LEVELS: string[][] = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']]

  private binary(level: number): Expr {
    if (level >= Parser.LEVELS.length) return this.unary()
    let a = this.binary(level + 1)
    for (;;) {
      const t = this.t
      if (t.k !== 'op' || !Parser.LEVELS[level].includes(t.v)) return a
      this.p++
      const b = this.binary(level + 1)
      a = { k: 'bin', op: t.v, a, b, line: t.line }
    }
  }

  private unary(): Expr {
    const t = this.t
    if (t.k === 'op') {
      if (['-', '+', '!', '~', '*', '&'].includes(t.v)) {
        this.p++
        return { k: 'un', op: t.v, a: this.unary(), line: t.line }
      }
      if (t.v === '++' || t.v === '--') {
        this.p++
        return { k: 'un', op: t.v, a: this.unary(), line: t.line }
      }
      if (t.v === '(' && this.isTypeStart(1)) {
        // (형) 캐스트인지 확인
        const save = this.p
        this.p++
        try {
          const type = this.typeSpec()
          if (this.eat(')')) {
            if (this.is('{')) throw this.err('복합 리터럴 (형){…} 은 지원하지 않습니다')
            return { k: 'cast', t: type, a: this.unary(), line: t.line }
          }
        } catch (e) {
          if (e instanceof CompileError && /복합 리터럴/.test(e.message)) throw e
        }
        this.p = save
      }
    }
    if (t.k === 'id') {
      if (t.v === 'sizeof') {
        this.p++
        if (this.is('(') && this.isTypeStart(1)) {
          const save = this.p
          this.p++
          const type = this.typeSpec()
          while (this.eat('[')) {
            type.dims.push(this.is(']') ? null : this.expr())
            this.expect(']')
          }
          if (this.eat(')')) return { k: 'sizeof', t: type, line: t.line }
          this.p = save
        }
        return { k: 'sizeof', a: this.unary(), line: t.line }
      }
      if (t.v === 'new' || t.v === 'delete') throw this.err('new / delete (동적 메모리)는 지원하지 않습니다. 전역 변수나 배열로 바꿔 주세요')
    }
    return this.postfix(this.primary())
  }

  private args(): Expr[] {
    const out: Expr[] = []
    while (!this.eat(')')) {
      out.push(this.assign())
      if (!this.is(')')) this.expect(',', '인자 사이')
    }
    return out
  }

  private postfix(e: Expr): Expr {
    for (;;) {
      const t = this.t
      if (t.k !== 'op') return e
      if (t.v === '(') {
        this.p++
        e = { k: 'call', fn: e, args: this.args(), line: t.line }
        continue
      }
      if (t.v === '[') {
        this.p++
        const i = this.expr()
        this.expect(']')
        e = { k: 'index', a: e, i, line: t.line }
        continue
      }
      if (t.v === '.' || t.v === '->') {
        this.p++
        const name = this.ident('멤버 이름')
        e = { k: 'member', obj: e, name, arrow: t.v === '->', line: t.line }
        if (TEMPLATE_METHODS.has(name) && this.is('<')) {
          const targs = this.templateArgs()
          this.expect('(')
          e = { k: 'call', fn: e, args: this.args(), targs, line: t.line }
        }
        continue
      }
      if (t.v === '++' || t.v === '--') {
        this.p++
        e = { k: 'post', op: t.v, a: e, line: t.line }
        continue
      }
      return e
    }
  }

  private templateArgs(): (TypeSpec | Expr)[] {
    this.expect('<')
    const out: (TypeSpec | Expr)[] = []
    while (!this.eat('>')) {
      if (this.isTypeStart() && !this.is('(', 1)) out.push(this.typeSpec())
      else out.push(this.binary(7)) // 비교 연산자 앞까지만 (> 를 닫는 괄호로 보기 위해)
      if (!this.is('>')) this.expect(',', '템플릿 인자 사이')
    }
    return out
  }

  private primary(): Expr {
    const t = this.t
    const line = t.line
    switch (t.k) {
      case 'num':
        this.p++
        return { k: 'num', v: t.num ?? 0, float: !!t.float, single: !!t.single, unsigned: !!t.unsigned, longs: t.longs ?? 0, radix: !!t.radix, line }
      case 'chr':
        this.p++
        return { k: 'chr', v: t.num ?? 0, line }
      case 'str':
        this.p++
        return { k: 'str', v: t.v, line }
      case 'eof':
        throw this.err('식이 필요한데 코드가 끝났습니다')
    }
    if (t.k === 'op') {
      if (t.v === '(') {
        this.p++
        const e = this.expr()
        this.expect(')')
        return e
      }
      if (t.v === '{') return this.initList()
      if (t.v === '[') throw this.err('람다 식은 지원하지 않습니다. 따로 함수를 만들어 이름을 넘겨 주세요')
      throw this.err(`식이 필요합니다 — '${t.v}' 앞`)
    }
    // 식별자
    if (t.v === 'true' || t.v === 'false') {
      this.p++
      return { k: 'bool', v: t.v === 'true', line }
    }
    if (t.v === 'nullptr') {
      this.p++
      return { k: 'null', line }
    }
    if (t.v === 'this') throw this.err('this 는 지원하지 않습니다')
    if (CASTS.has(t.v) && this.is('<', 1)) {
      this.p += 2
      const type = this.typeSpec()
      this.expect('>')
      this.expect('(')
      const a = this.expr()
      this.expect(')')
      return { k: 'cast', t: type, a, line }
    }
    // 형 이름 + ( → 함수형 캐스트 / 임시 객체 (int(x), String(x), Servo())
    if (this.isTypeStart() && !QUALIFIERS.has(t.v)) {
      const save = this.p
      const type = this.typeSpec()
      if (this.is('(')) {
        this.p++
        return { k: 'ctor', t: type, args: this.args(), line }
      }
      if (this.is('{') && type.ptr === 0) return { k: 'ctor', t: type, args: (this.initList() as Extract<Expr, { k: 'init' }>).items, line }
      this.p = save
      if (BASIC_WORDS.has(t.v)) throw this.err(`'${t.v}' 다음에 변수 이름이 필요합니다`)
    }
    if (KEYWORDS.has(t.v)) throw this.err(`'${t.v}' 는 여기에 쓸 수 없습니다`)
    return { k: 'id', name: this.qualified(), line }
  }
}

function normalizeWords(words: string[]): string {
  const w = [...words]
  const unsigned = w.includes('unsigned')
  const signed = w.includes('signed')
  const longs = w.filter((x) => x === 'long').length
  const rest = w.filter((x) => x !== 'unsigned' && x !== 'signed' && x !== 'long' && !(x === 'int' && (longs || w.includes('short'))))
  let base: string
  if (w.includes('short')) base = 'short'
  else if (longs >= 2) base = 'long long'
  else if (longs === 1) base = rest.includes('double') ? 'long double' : 'long'
  else base = rest[0] ?? 'int'
  if (base === 'short' || base === 'long' || base === 'long long' || base === 'int' || base === 'char') {
    if (unsigned) return base === 'int' ? 'unsigned int' : `unsigned ${base}`
    if (signed && base === 'char') return 'signed char'
  }
  return base
}
