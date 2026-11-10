import {
  ANY,
  BOOL,
  CHAR,
  CSTR,
  FN,
  STRING,
  VOID,
  basicType,
  cloneValue,
  common,
  convert,
  doubleOf,
  intOf,
  isCharPtr,
  isInt,
  longOf,
  promote,
  sizeOf,
  truthy,
  typeName,
  wrapInt,
  zeroOf,
  type CType,
  type Platform,
} from './ctypes'
import { CompileError } from './lexer'
import type { BuiltinFn, ClassDef, Gen, Machine, MethodDef, Registry } from './machine'
import type { EnumDef, Expr, FuncDef, Param, Stmt, StructDef, Top, TypeSpec, VarDecl } from './parser'
import { Ptr, RuntimeErr, cstrText, parseLeadingFloat, parseLeadingInt, toArduinoString, utf8, writeCstr } from './values'

/* oxlint-disable require-yield -- 기다리지 않는 코드도 기다리는 코드와 같은 모양(제너레이터)으로 감싸 함께 실행한다 */

// 구문 트리 → 실행 함수(클로저)
//
// 기다릴 수 있는 코드(delay, 반복문, 그런 코드를 부르는 함수)는 제너레이터로, 나머지는 보통 함수로 만든다.
// 반복문은 매 바퀴 실행 예산과 목표 시각을 확인해 양보하므로 while(true) 도 화면을 멈추지 않는다.

export type Frame = unknown[]
type Sync = (f: Frame) => unknown
type GenF = (f: Frame) => Gen
type SyncS = (f: Frame) => number
type GenS = (f: Frame) => Gen<number>

/** 컴파일한 식 */
interface CE {
  t: CType
  s?: Sync
  g?: GenF
  /** 컴파일 때 정해지는 값 */
  cv?: number
  /** 함수 이름 */
  fn?: FnInfo
}

/** 대입할 수 있는 위치: 그릇을 돌려주고 키는 m.lk 에 둔다 */
interface Loc {
  t: CType
  s?: (f: Frame) => Record<string | number, unknown>
  g?: (f: Frame) => Gen<Record<string | number, unknown>>
  isConst?: boolean
  /** 배열 이름 그 자체 */
  name?: string
}

interface CS {
  s?: SyncS
  g?: GenS
}

/** 인자 없는 내장 함수 호출에 같이 쓰는 빈 배열 (함수가 바꾸지 않는다) */
const NO_ARGS: unknown[] = []

const NEXT = 0
const BREAK = 1
const CONTINUE = 2
const RETURN = 3

interface VarInfo {
  kind: 'global' | 'local' | 'ref'
  slot: number
  t: CType
  isConst: boolean
  cv?: number
  line: number
}

export interface FnInfo {
  name: string
  ret: CType
  params: { name: string; t: CType; ref: boolean; def?: Expr }[]
  def: FuncDef
  isGen: boolean
  nslots: number
  sync?: (args: unknown[]) => unknown
  gen?: (args: unknown[]) => Gen
  /** 인터럽트·콜백으로 부를 때 쓰는 함수 (Program 이 정한다) */
  invoke?: (args?: unknown[]) => void
}

class Scope {
  readonly vars = new Map<string, VarInfo>()
  readonly parent: Scope | null
  readonly fn: { nslots: number } | null
  constructor(parent: Scope | null, fn: { nslots: number } | null) {
    this.parent = parent
    this.fn = fn
  }
  find(name: string): VarInfo | undefined {
    const own = this.vars.get(name)
    if (own) return own
    return this.parent?.find(name)
  }
}

export interface CompiledProgram {
  globals: unknown[]
  slot: (name: string) => number | undefined
  init: () => Gen
  funcs: Map<string, FnInfo[]>
  setup?: FnInfo
  loop?: FnInfo
  serialEvent?: FnInfo
  isrs: Map<string, FnInfo>
  warnings: { line: number; message: string }[]
}

const genOf = (c: CE): GenF =>
  c.g ??
  function* (f: Frame) {
    return c.s!(f)
  }
const genS = (c: CS): GenS =>
  c.g ??
  function* (f: Frame) {
    return c.s!(f)
  }

/** 기다리는 함수·메서드 이름 (함수가 제너레이터인지 미리 판단하는 데 쓴다) */
function blockingNames(reg: Registry): { fns: Set<string>; methods: Set<string> } {
  const fns = new Set<string>()
  for (const [name, b] of reg.functions) if (b.gen) fns.add(name)
  const methods = new Set<string>()
  for (const cls of reg.classes.values()) for (const [name, m] of Object.entries(cls.methods)) if (m.gen) methods.add(name)
  for (const name of ['readString', 'readStringUntil', 'parseInt', 'parseFloat', 'readBytes', 'readBytesUntil', 'find', 'findUntil']) methods.add(name)
  return { fns, methods }
}

export class Compiler {
  readonly p: Platform
  readonly reg: Registry
  readonly m: Machine
  readonly G: unknown[] = []
  private readonly gscope = new Scope(null, null)
  readonly funcs = new Map<string, FnInfo[]>()
  private readonly structs = new Map<string, CType & { k: 'struct' }>()
  private readonly structInits = new Map<string, Map<string, unknown>>()
  private readonly typedefs = new Map<string, CType>()
  private readonly inits: (CS & { line: number })[] = []
  readonly warnings: { line: number; message: string }[] = []
  private retType: CType = VOID
  private loopDepth = 0
  private switchDepth = 0
  private readonly blocking: { fns: Set<string>; methods: Set<string> }

  constructor(m: Machine, reg: Registry) {
    this.m = m
    this.p = m.p
    this.reg = reg
    this.blocking = blockingNames(reg)
  }

  private err(message: string, line: number): CompileError {
    return new CompileError(message, line)
  }

  private warn(line: number, message: string) {
    if (!this.warnings.some((w) => w.line === line && w.message === message)) this.warnings.push({ line, message })
  }

  // ------------------------------------------------------------ 형

  resolveType(spec: TypeSpec, initLen?: number): CType {
    let base = this.baseType(spec.name, spec.line)
    for (let i = 0; i < spec.ptr; i++) base = { k: 'ptr', to: base }
    const dims = spec.dims.map((d, i) => {
      if (d === null) {
        if (i === 0 && initLen !== undefined) return initLen
        if (i === 0) return null
        throw this.err('배열의 두 번째 크기부터는 비울 수 없습니다', spec.line)
      }
      const v = this.constEval(d)
      if (v === undefined) throw this.err('배열 크기는 상수여야 합니다 (const 변수나 #define 을 쓰세요)', spec.line)
      if (v < 0 || v > 20000) throw this.err(`배열 크기가 너무 큽니다: ${v}`, spec.line)
      return v
    })
    for (let i = dims.length - 1; i >= 0; i--) base = { k: 'array', of: base, len: dims[i] }
    return base
  }

  private baseType(name: string, line: number): CType {
    if (name === 'auto') return ANY
    const basic = basicType(name, this.p)
    if (basic) return basic
    if (name.startsWith('struct:')) {
      const s = this.structs.get(name.slice(7))
      if (!s) throw this.err(`구조체 ${name.slice(7)} 이(가) 정의되지 않았습니다`, line)
      return s
    }
    const td = this.typedefs.get(name)
    if (td) return td
    const st = this.structs.get(name)
    if (st) return st
    const rt = this.reg.types.get(name)
    if (rt) return rt
    if (this.reg.classes.has(name)) return { k: 'obj', cls: name }
    const q = name.split('::')
    if (q.length === 2) {
      const cls = this.reg.classes.get(q[0])
      const nested = cls?.types?.[q[1]]
      if (nested) return nested
    }
    throw this.err(`알 수 없는 형 '${name}' 입니다`, line)
  }

  /** 컴파일 때 계산할 수 있는 정수·실수 식 */
  constEval(e: Expr, sc: Scope = this.gscope): number | undefined {
    switch (e.k) {
      case 'num':
      case 'chr':
        return e.v
      case 'bool':
        return e.v ? 1 : 0
      case 'id': {
        const v = sc.find(e.name)
        if (v) return v.cv
        const c = this.reg.constants.get(e.name)
        if (c && typeof c.v === 'number') return c.v
        return undefined
      }
      case 'un': {
        const a = this.constEval(e.a, sc)
        if (a === undefined) return undefined
        return e.op === '-' ? -a : e.op === '+' ? a : e.op === '!' ? +!a : e.op === '~' ? ~a : undefined
      }
      case 'bin': {
        const a = this.constEval(e.a, sc)
        const b = this.constEval(e.b, sc)
        if (a === undefined || b === undefined) return undefined
        switch (e.op) {
          case '+':
            return a + b
          case '-':
            return a - b
          case '*':
            return a * b
          case '/':
            return b === 0 ? undefined : Number.isInteger(a) && Number.isInteger(b) ? Math.trunc(a / b) : a / b
          case '%':
            return b === 0 ? undefined : a % b
          case '<<':
            return a * 2 ** b
          case '>>':
            return Math.floor(a / 2 ** b)
          case '&':
            return a & b
          case '|':
            return a | b
          case '^':
            return a ^ b
          case '==':
            return +(a === b)
          case '!=':
            return +(a !== b)
          case '<':
            return +(a < b)
          case '>':
            return +(a > b)
          case '<=':
            return +(a <= b)
          case '>=':
            return +(a >= b)
          case '&&':
            return +(!!a && !!b)
          case '||':
            return +(!!a || !!b)
        }
        return undefined
      }
      case 'cond': {
        const c = this.constEval(e.c, sc)
        if (c === undefined) return undefined
        return c ? this.constEval(e.a, sc) : this.constEval(e.b, sc)
      }
      case 'cast':
      case 'ctor': {
        const a = e.k === 'cast' ? this.constEval(e.a, sc) : e.args.length === 1 ? this.constEval(e.args[0], sc) : undefined
        if (a === undefined) return undefined
        try {
          const t = this.resolveType(e.t)
          return t.k === 'int' || t.k === 'float' ? (convert(a, t) as number) : undefined
        } catch {
          return undefined
        }
      }
      case 'sizeof':
        try {
          return sizeOf(e.t ? this.resolveType(e.t) : this.typeOfExpr(e.a!, sc), this.p)
        } catch {
          return undefined
        }
    }
    return undefined
  }

  /** 식의 형만 알아낸다 (sizeof 용) */
  private typeOfExpr(e: Expr, sc: Scope): CType {
    if (e.k === 'id') {
      const v = sc.find(e.name)
      if (v) return v.t
    }
    if (e.k === 'str') return { k: 'array', of: CHAR, len: utf8(e.v).length + 1 }
    return this.expr(e, sc).t
  }

  // ------------------------------------------------------------ 프로그램

  /** 전역 변수 슬롯 (하드웨어가 레지스터를 읽고 쓰는 데 쓴다) */
  globalSlot(name: string): number | undefined {
    const v = this.gscope.vars.get(name)
    return v?.kind === 'global' ? v.slot : undefined
  }

  compile(tops: Top[]): CompiledProgram {
    for (const [name, g] of this.reg.globals ?? []) {
      this.gscope.vars.set(name, { kind: 'global', slot: this.G.length, t: g.t, isConst: false, line: 0 })
      this.G.push(g.v)
    }
    // 1) 형·전역 변수·함수 원형을 차례로 등록
    const bodies: FnInfo[] = []
    for (const top of tops) {
      switch (top.k) {
        case 'struct':
          this.defineStruct(top.s)
          break
        case 'enum':
          this.defineEnum(top.e)
          break
        case 'typedef':
          this.typedefs.set(top.name, this.resolveType(top.type))
          break
        case 'vars':
          for (const d of top.decls) this.globalVar(d)
          break
        case 'func': {
          const fi = this.declareFn(top.f)
          bodies.push(fi)
          break
        }
        case 'proto':
          break
      }
    }
    // 2) 기다리는 함수 판정 (반복문·delay·그런 함수를 부르는 함수)
    let changed = true
    while (changed) {
      changed = false
      for (const fi of bodies) {
        if (fi.isGen) continue
        if (this.stmtBlocks(fi.def.body)) {
          fi.isGen = true
          changed = true
        }
      }
    }
    // 3) 함수 본문
    for (const fi of bodies) this.compileFn(fi)
    // 4) 전역 초기화
    const inits = this.inits
    const G = this.G
    void G
    const m = this.m
    const init = function* (): Gen {
      for (const s of inits) {
        m.line = s.line
        if (s.g) yield* s.g([])
        else s.s!([])
      }
      return undefined
    }
    const one = (name: string) => this.funcs.get(name)?.find((f) => f.params.length === 0)
    const isrs = new Map<string, FnInfo>()
    for (const [name, list] of this.funcs) if (name.startsWith('ISR:')) isrs.set(name.slice(4), list[0])
    return { globals: this.G, slot: (n) => this.globalSlot(n), init, funcs: this.funcs, setup: one('setup'), loop: one('loop'), serialEvent: one('serialEvent'), isrs, warnings: this.warnings }
  }

  private defineStruct(s: StructDef) {
    const t: CType & { k: 'struct' } = { k: 'struct', name: s.name, fields: [] }
    this.structs.set(s.name, t)
    const defaults = new Map<string, unknown>()
    for (const f of s.fields) {
      const ft = this.resolveType(f.type)
      t.fields.push({ name: f.name, type: ft })
      if (f.init) {
        const v = this.constEval(f.init)
        if (v === undefined) throw this.err('구조체 멤버의 기본값은 상수여야 합니다', s.line)
        defaults.set(f.name, convert(v, ft))
      }
    }
    if (defaults.size) this.structInits.set(s.name, defaults)
  }

  private zero(t: CType): unknown {
    if (t.k === 'struct') {
      const o: Record<string, unknown> = {}
      const defaults = this.structInits.get(t.name)
      for (const f of t.fields) o[f.name] = defaults?.has(f.name) ? defaults.get(f.name) : this.zero(f.type)
      return o
    }
    if (t.k === 'array') return Array.from({ length: t.len ?? 0 }, () => this.zero(t.of))
    return zeroOf(t)
  }

  private defineEnum(e: EnumDef) {
    let next = 0
    const t = intOf(this.p)
    if (e.name) this.typedefs.set(e.name, t)
    for (const item of e.items) {
      if (item.value) {
        const v = this.constEval(item.value)
        if (v === undefined) throw this.err('열거 상수 값은 상수여야 합니다', item.line)
        next = v
      }
      const slot = this.G.length
      this.G.push(next)
      const info: VarInfo = { kind: 'global', slot, t, isConst: true, cv: next, line: item.line }
      this.gscope.vars.set(item.name, info)
      if (e.name) this.gscope.vars.set(`${e.name}::${item.name}`, info)
      next++
    }
  }

  private globalVar(d: VarDecl) {
    if (this.gscope.vars.has(d.name)) throw this.err(`'${d.name}' 이(가) 이미 선언되었습니다`, d.line)
    if (this.funcs.has(d.name)) throw this.err(`'${d.name}' 은(는) 이미 함수 이름입니다`, d.line)
    const t = this.declType(d, this.gscope)
    const slot = this.G.length
    this.G.push(this.zero(t))
    const info: VarInfo = { kind: 'global', slot, t, isConst: d.type.isConst, line: d.line }
    if (d.type.isConst && d.init && (t.k === 'int' || t.k === 'float')) {
      const v = this.constEval(d.init)
      if (v !== undefined) info.cv = convert(v, t) as number
    }
    this.gscope.vars.set(d.name, info)
    const store = this.initializer(d, t, this.gscope)
    const G = this.G
    if (store) {
      const line = d.line
      if (store.g) {
        const g = store.g
        this.inits.push({
          line,
          g: function* () {
            G[slot] = yield* g([])
            return NEXT
          },
        })
      } else {
        const s = store.s!
        this.inits.push({
          line,
          s: () => {
            G[slot] = s([])
            return NEXT
          },
        })
      }
    }
  }

  /** 선언의 형 (int a[] = {…} 처럼 크기를 비우면 초기값 개수로, auto 는 초기값의 형으로) */
  private declType(d: VarDecl, sc: Scope): CType {
    let len: number | undefined
    if (d.type.dims[0] === null) {
      if (d.init?.k === 'init') len = d.init.items.length
      else if (d.init?.k === 'str') len = utf8(d.init.v).length + 1
      else throw this.err(`배열 ${d.name} 의 크기를 정하거나 초기값을 주세요`, d.line)
    }
    let t = this.resolveType(d.type, len)
    if (t.k === 'any') {
      if (!d.init) throw this.err('auto 변수에는 초기값이 필요합니다', d.line)
      t = this.expr(d.init, sc).t
      if (t.k === 'int' && t.bits < this.p.intBits && !t.char && !t.bool) t = promote(t, this.p)
    }
    if (t.k === 'void') throw this.err('void 형 변수는 만들 수 없습니다', d.line)
    return t
  }

  /** 선언의 초기값을 만드는 함수 (없으면 0 · 빈 객체) */
  private initializer(d: VarDecl, t: CType, sc: Scope): CE | null {
    if (t.k === 'obj') {
      const cls = this.reg.classes.get(t.cls)!
      if (d.init) {
        const c = this.expr(d.init, sc)
        if (c.t.k !== 'obj' || c.t.cls !== t.cls) throw this.err(`${t.cls} 형에 ${typeName(c.t)} 값을 넣을 수 없습니다`, d.line)
        return c
      }
      return this.construct(cls, d.ctorArgs ?? [], sc, d.line)
    }
    if (d.ctorArgs) {
      if (t.k === 'String' || t.k === 'int' || t.k === 'float') return this.ctorExpr(t, d.ctorArgs, sc, d.line)
      throw this.err(`${typeName(t)} 형은 괄호로 초기화할 수 없습니다`, d.line)
    }
    if (!d.init) {
      if (t.k === 'array' || t.k === 'struct') {
        const zero = () => this.zero(t)
        return { t, s: zero }
      }
      if (t.k === 'String') return { t, s: () => '' }
      return null
    }
    return this.initValue(d.init, t, sc, d.line)
  }

  /** 초기값 (배열·구조체의 { … } 포함)을 형에 맞춘다 */
  private initValue(e: Expr, t: CType, sc: Scope, line: number): CE {
    if (t.k === 'array') {
      if (e.k === 'str' && isCharPtr(t)) {
        const bytes = utf8(e.v)
        const len = t.len ?? bytes.length + 1
        if (bytes.length + 1 > len) throw this.err(`문자열이 배열 크기(${len})보다 깁니다`, line)
        return { t, s: () => Array.from({ length: len }, (_, i) => (i < bytes.length ? (bytes[i] > 127 ? bytes[i] - 256 : bytes[i]) : 0)) }
      }
      if (e.k !== 'init') {
        const c = this.expr(e, sc)
        if (c.t.k === 'array') return { t, g: c.g, s: c.s ? (f) => cloneValue(c.s!(f)) : undefined }
        throw this.err('배열은 { … } 로 초기화하세요', line)
      }
      const len = t.len ?? e.items.length
      if (e.items.length > len) throw this.err(`초기값이 배열 크기(${len})보다 많습니다`, line)
      const items = e.items.map((it) => this.initValue(it, t.of, sc, line))
      const rest = () => this.zero(t.of)
      return this.liftN(
        t,
        items,
        (vals) => {
          const out = vals.slice()
          while (out.length < len) out.push(rest())
          return out
        },
      )
    }
    if (t.k === 'struct') {
      if (e.k !== 'init') {
        const c = this.expr(e, sc)
        if (c.t.k !== 'struct' || c.t.name !== t.name) throw this.err(`${t.name} 에 ${typeName(c.t)} 값을 넣을 수 없습니다`, line)
        return this.lift1(t, c, cloneValue)
      }
      if (e.items.length > t.fields.length) throw this.err(`구조체 ${t.name} 의 멤버보다 초기값이 많습니다`, line)
      const items = e.items.map((it, i) => this.initValue(it, t.fields[i].type, sc, line))
      const fields = t.fields
      return this.liftN(t, items, (vals) => {
        const o = this.zero(t) as Record<string, unknown>
        vals.forEach((v, i) => (o[fields[i].name] = v))
        return o
      })
    }
    if (e.k === 'init') {
      if (e.items.length === 0) return { t, s: () => this.zero(t) }
      return this.initValue(e.items[0], t, sc, line)
    }
    return this.coerce(this.expr(e, sc), t, line)
  }

  private declareFn(f: FuncDef): FnInfo {
    if (this.gscope.vars.has(f.name)) throw this.err(`'${f.name}' 은(는) 이미 변수 이름입니다`, f.line)
    const ret = this.resolveType(f.ret)
    const params = f.params.map((p: Param) => {
      let t = this.resolveType({ ...p.type, ref: false })
      // 배열 매개변수는 포인터처럼 원본을 받는다 (크기를 비워도 된다)
      if (t.k === 'array' && t.len === null) t = { ...t }
      return { name: p.name, t, ref: p.type.ref && t.k !== 'array' && t.k !== 'obj', def: p.def }
    })
    const list = this.funcs.get(f.name) ?? []
    const same = list.find((x) => x.params.length === params.length && x.params.every((p, i) => typeName(p.t) === typeName(params[i].t)))
    if (same) throw this.err(`함수 ${f.name} 이(가) 두 번 정의되었습니다 (${same.def.line}번째 줄)`, f.line)
    const info: FnInfo = { name: f.name, ret, params, def: f, isGen: false, nslots: 0 }
    list.push(info)
    this.funcs.set(f.name, list)
    return info
  }

  // ------------------------------------------------------------ 기다리는 코드 판정

  private stmtBlocks(s: Stmt): boolean {
    switch (s.k) {
      case 'block':
        return s.body.some((x) => this.stmtBlocks(x))
      case 'expr':
        return this.exprBlocks(s.e)
      case 'decl':
        return s.decls.some((d) => (d.init ? this.exprBlocks(d.init) : false) || (d.ctorArgs ?? []).some((a) => this.exprBlocks(a)))
      case 'if':
        return this.exprBlocks(s.c) || this.stmtBlocks(s.a) || (s.b ? this.stmtBlocks(s.b) : false)
      case 'while':
      case 'do':
      case 'for':
      case 'forin':
        return true
      case 'switch':
        return this.exprBlocks(s.e) || s.body.some((x) => this.stmtBlocks(x))
      case 'return':
        return s.e ? this.exprBlocks(s.e) : false
      default:
        return false
    }
  }

  private exprBlocks(e: Expr): boolean {
    switch (e.k) {
      case 'call': {
        if (e.fn.k === 'id') {
          if (this.blocking.fns.has(e.fn.name)) return true
          const fns = this.funcs.get(e.fn.name)
          if (fns?.some((f) => f.isGen)) return true
        }
        if (e.fn.k === 'member' && this.blocking.methods.has(e.fn.name)) return true
        return this.exprBlocks(e.fn) || e.args.some((a) => this.exprBlocks(a))
      }
      case 'bin':
      case 'assign':
      case 'comma':
        return this.exprBlocks(e.a) || this.exprBlocks(e.b)
      case 'un':
      case 'post':
        return this.exprBlocks(e.a)
      case 'cond':
        return this.exprBlocks(e.c) || this.exprBlocks(e.a) || this.exprBlocks(e.b)
      case 'member':
        return this.exprBlocks(e.obj)
      case 'index':
        return this.exprBlocks(e.a) || this.exprBlocks(e.i)
      case 'cast':
        return this.exprBlocks(e.a)
      case 'ctor':
        return e.args.some((a) => this.exprBlocks(a))
      case 'init':
        return e.items.some((a) => this.exprBlocks(a))
      default:
        return false
    }
  }

  // ------------------------------------------------------------ 함수 본문

  private compileFn(fi: FnInfo) {
    const counter = { nslots: 0 }
    const sc = new Scope(this.gscope, counter)
    for (const p of fi.params) {
      if (!p.name) {
        counter.nslots++
        continue
      }
      sc.vars.set(p.name, { kind: p.ref ? 'ref' : 'local', slot: counter.nslots++, t: p.t, isConst: false, line: fi.def.line })
    }
    this.retType = fi.ret
    this.loopDepth = 0
    this.switchDepth = 0
    const body = this.block(fi.def.body, sc, false)
    if (!fi.isGen && body.g) fi.isGen = true // 판정보다 실제가 우선 (만일을 위해)
    fi.nslots = Math.max(counter.nslots, 1)
    const m = this.m
    const n = () => fi.nslots
    const ret = fi.ret
    const zero = ret.k === 'void' ? undefined : this.zero(ret)
    const isStruct = ret.k === 'struct'
    if (body.g) {
      const g = body.g
      fi.gen = function* (args: unknown[]): Gen {
        const f: Frame = new Array(n())
        for (let i = 0; i < args.length; i++) f[i] = args[i]
        const r = yield* g(f)
        return r === RETURN ? m.rv : isStruct ? cloneValue(zero) : zero
      }
      fi.sync = undefined
    } else {
      const s = body.s!
      fi.sync = (args: unknown[]) => {
        const f: Frame = new Array(n())
        for (let i = 0; i < args.length; i++) f[i] = args[i]
        const r = s(f)
        return r === RETURN ? m.rv : isStruct ? cloneValue(zero) : zero
      }
      fi.gen = function* (args: unknown[]): Gen {
        return fi.sync!(args)
      }
    }
  }

  // ------------------------------------------------------------ 문장

  private block(b: Stmt & { k: 'block' }, parent: Scope, newScope = true): CS {
    const sc = newScope ? new Scope(parent, parent.fn) : parent
    const list = b.body.map((s) => this.stmt(s, sc))
    return this.seq(list)
  }

  private seq(list: CS[]): CS {
    if (list.length === 0) return { s: () => NEXT }
    if (list.length === 1) return list[0]
    if (list.every((s) => s.s && !s.g)) {
      const fs = list.map((s) => s.s!)
      if (fs.length === 2) {
        const [a, b] = fs
        return { s: (f) => a(f) || b(f) }
      }
      return {
        s: (f) => {
          for (let i = 0; i < fs.length; i++) {
            const r = fs[i](f)
            if (r) return r
          }
          return NEXT
        },
      }
    }
    const items = list.map((s) => (s.g ? { g: s.g } : { s: s.s! }))
    return {
      g: function* (f: Frame) {
        for (let i = 0; i < items.length; i++) {
          const it = items[i]
          const r = it.g ? yield* it.g(f) : it.s!(f)
          if (r) return r
        }
        return NEXT
      },
    }
  }

  private stmt(s: Stmt, sc: Scope): CS {
    const m = this.m
    const line = s.line
    switch (s.k) {
      case 'empty':
        return { s: () => NEXT }
      case 'block':
        return this.block(s, sc)
      case 'expr': {
        const e = this.expr(s.e, sc)
        if (e.g) {
          const g = e.g
          return {
            g: function* (f) {
              m.line = line
              m.us += m.cost
              m.budget--
              yield* g(f)
              return NEXT
            },
          }
        }
        const x = e.s!
        return {
          s: (f) => {
            m.line = line
            m.us += m.cost
            m.budget--
            x(f)
            return NEXT
          },
        }
      }
      case 'decl':
        return this.seq(s.decls.map((d) => this.localVar(d, sc)))
      case 'if': {
        const c = this.cond(s.c, sc)
        const a = this.stmt(s.a, new Scope(sc, sc.fn))
        const b = s.b ? this.stmt(s.b, new Scope(sc, sc.fn)) : null
        if (!c.g && !a.g && !b?.g) {
          const cs = c.s!
          const as = a.s!
          const bs = b?.s
          return {
            s: bs
              ? (f) => {
                  m.line = line
                  return cs(f) ? as(f) : bs(f)
                }
              : (f) => {
                  m.line = line
                  return cs(f) ? as(f) : NEXT
                },
          }
        }
        const cg = genOf(c)
        const ag = genS(a)
        const bg = b ? genS(b) : null
        return {
          g: function* (f) {
            m.line = line
            if (yield* cg(f)) return yield* ag(f)
            return bg ? yield* bg(f) : NEXT
          },
        }
      }
      case 'while':
      case 'do':
      case 'for':
        return this.loop(s, sc)
      case 'forin':
        return this.forIn(s, sc)
      case 'switch':
        return this.switchStmt(s, sc)
      case 'break':
        if (!this.loopDepth && !this.switchDepth) throw this.err('break 는 반복문이나 switch 안에서만 쓸 수 있습니다', line)
        return { s: () => BREAK }
      case 'continue':
        if (!this.loopDepth) throw this.err('continue 는 반복문 안에서만 쓸 수 있습니다', line)
        return { s: () => CONTINUE }
      case 'return': {
        const ret = this.retType
        if (!s.e) {
          if (ret.k !== 'void') this.warn(line, `값을 돌려주지 않는 return 입니다 (반환형 ${typeName(ret)})`)
          return { s: () => ((m.rv = ret.k === 'void' ? undefined : zeroOf(ret)), RETURN) }
        }
        if (ret.k === 'void') throw this.err('void 함수는 값을 돌려줄 수 없습니다', line)
        const e = this.coerce(this.expr(s.e, sc), ret, line)
        if (e.g) {
          const g = e.g
          return {
            g: function* (f) {
              m.line = line
              m.rv = yield* g(f)
              return RETURN
            },
          }
        }
        const x = e.s!
        return {
          s: (f) => {
            m.line = line
            m.rv = x(f)
            return RETURN
          },
        }
      }
    }
  }

  private localVar(d: VarDecl, sc: Scope): CS {
    if (sc.vars.has(d.name)) throw this.err(`'${d.name}' 이(가) 이 블록에서 이미 선언되었습니다`, d.line)
    const m = this.m
    const line = d.line
    // 참조 변수 (int &r = x;)
    if (d.type.ref) {
      if (!d.init) throw this.err('참조 변수에는 초기값이 필요합니다', line)
      const t = this.resolveType({ ...d.type, ref: false })
      const loc = this.loc(d.init, sc)
      if (!loc?.s) throw this.err('참조는 변수에만 걸 수 있습니다', line)
      const slot = sc.fn!.nslots++
      sc.vars.set(d.name, { kind: 'ref', slot, t, isConst: d.type.isConst, line })
      const ls = loc.s
      return {
        s: (f) => {
          const c = ls(f)
          f[slot] = new Ptr(c, m.lk, t)
          return NEXT
        },
      }
    }
    const t = this.declType(d, sc)
    // static 지역 변수: 전역 슬롯에 한 번만 초기화
    if (d.type.isStatic) {
      const slot = this.G.length
      this.G.push(this.zero(t))
      const info: VarInfo = { kind: 'global', slot, t, isConst: d.type.isConst, line }
      const init = this.initializer(d, t, sc)
      sc.vars.set(d.name, info)
      if (!init) return { s: () => NEXT }
      const G = this.G
      let done = false
      if (init.g) {
        const g = init.g
        return {
          g: function* (f) {
            if (done) return NEXT
            done = true
            G[slot] = yield* g(f)
            return NEXT
          },
        }
      }
      const is = init.s!
      return {
        s: (f) => {
          if (!done) {
            done = true
            G[slot] = is(f)
          }
          return NEXT
        },
      }
    }
    const slot = sc.fn!.nslots++
    const info: VarInfo = { kind: 'local', slot, t, isConst: d.type.isConst, line }
    if (d.type.isConst && d.init && (t.k === 'int' || t.k === 'float')) {
      const v = this.constEval(d.init, sc)
      if (v !== undefined) info.cv = convert(v, t) as number
    }
    // 초기값은 변수를 등록하기 전에 컴파일한다 (int x = x; 방지)
    const init = this.initializer(d, t, sc)
    sc.vars.set(d.name, info)
    if (!init) {
      const zero = t.k === 'int' || t.k === 'float' ? 0 : null
      return {
        s: (f) => {
          f[slot] = zero
          return NEXT
        },
      }
    }
    if (init.g) {
      const g = init.g
      return {
        g: function* (f) {
          m.line = line
          m.us += m.cost
          m.budget--
          f[slot] = yield* g(f)
          return NEXT
        },
      }
    }
    const is = init.s!
    return {
      s: (f) => {
        m.line = line
        m.us += m.cost
        m.budget--
        f[slot] = is(f)
        return NEXT
      },
    }
  }

  private cond(e: Expr, sc: Scope): CE {
    const c = this.expr(e, sc)
    if (c.t.k === 'void') throw this.err('조건에 void 값을 쓸 수 없습니다', e.line)
    if (c.t.k === 'String') throw this.err('String 은 조건으로 쓸 수 없습니다 (예: s.length() > 0)', e.line)
    // 정수는 JS 의 참·거짓과 같다 (실수의 NaN 만 다르다)
    if (c.t.k === 'int') return { ...c, t: BOOL }
    return this.lift1(BOOL, c, truthy)
  }

  private loop(s: Stmt & { k: 'while' | 'do' | 'for' }, parent: Scope): CS {
    const m = this.m
    const sc = new Scope(parent, parent.fn)
    const line = s.line
    const init = s.k === 'for' && s.init ? this.stmt(s.init, sc) : null
    const c = s.k === 'for' ? (s.c ? this.cond(s.c, sc) : null) : this.cond(s.c, sc)
    const step = s.k === 'for' && s.step ? this.expr(s.step, sc) : null
    this.loopDepth++
    const body = this.stmt(s.body, new Scope(sc, sc.fn))
    this.loopDepth--
    const cs = c && !c.g ? c.s! : null
    const cg = c?.g ?? null
    const bs = !body.g ? body.s! : null
    const bg = body.g ?? null
    const ss = step && !step.g ? step.s! : null
    const sg = step?.g ?? null
    const ig = init ? genS(init) : null
    const isDo = s.k === 'do'
    return {
      g: function* (f) {
        if (ig) yield* ig(f)
        let first = true
        for (;;) {
          m.line = line
          m.us += m.cost
          m.budget--
          if (!(isDo && first)) {
            if (cs) {
              if (!cs(f)) break
            } else if (cg) {
              if (!(yield* cg(f))) break
            }
          }
          first = false
          const r = bs ? bs(f) : yield* bg!(f)
          if (r === BREAK) break
          if (r === RETURN) return RETURN
          if (ss) ss(f)
          else if (sg) yield* sg(f)
          if (m.shouldYield()) yield 0
        }
        return NEXT
      },
    }
  }

  private forIn(s: Stmt & { k: 'forin' }, parent: Scope): CS {
    const m = this.m
    const sc = new Scope(parent, parent.fn)
    const range = this.expr(s.range, sc)
    if (range.t.k !== 'array') throw this.err('범위 for 는 배열에만 쓸 수 있습니다', s.line)
    const el = range.t.of
    const declared = s.decl.type.name === 'auto' ? el : this.resolveType({ ...s.decl.type, ref: false })
    const slot = sc.fn!.nslots++
    const byRef = s.decl.type.ref
    sc.vars.set(s.decl.name, { kind: byRef ? 'ref' : 'local', slot, t: declared, isConst: s.decl.type.isConst, line: s.line })
    this.loopDepth++
    const body = genS(this.stmt(s.body, new Scope(sc, sc.fn)))
    this.loopDepth--
    const rg = genOf(range)
    const line = s.line
    return {
      g: function* (f) {
        const arr = (yield* rg(f)) as unknown[]
        for (let i = 0; i < arr.length; i++) {
          m.line = line
          m.us += m.cost
          m.budget--
          f[slot] = byRef ? new Ptr(arr, i, el) : convert(cloneValue(arr[i]), declared)
          const r = yield* body(f)
          if (r === BREAK) break
          if (r === RETURN) return RETURN
          if (m.shouldYield()) yield 0
        }
        return NEXT
      },
    }
  }

  private switchStmt(s: Stmt & { k: 'switch' }, parent: Scope): CS {
    const m = this.m
    const sc = new Scope(parent, parent.fn)
    const e = this.expr(s.e, sc)
    if (e.t.k !== 'int') throw this.err('switch 에는 정수(int, char, enum) 값만 쓸 수 있습니다', s.line)
    const table = new Map<number, number>()
    let def = -1
    for (const c of s.cases) {
      if (c.test === null) {
        if (def >= 0) throw this.err('default 가 두 번 있습니다', c.line)
        def = c.at
        continue
      }
      const v = this.constEval(c.test, sc)
      if (v === undefined) throw this.err('case 값은 상수여야 합니다', c.line)
      if (table.has(v)) throw this.err(`case ${v} 이(가) 두 번 있습니다`, c.line)
      table.set(v, c.at)
    }
    this.switchDepth++
    const body = s.body.map((b) => this.stmt(b, sc))
    this.switchDepth--
    const items = body.map((b) => (b.g ? { g: b.g } : { s: b.s! }))
    const allSync = items.every((it) => !it.g)
    const eg = genOf(e)
    const es = e.s
    const line = s.line
    const run = (start: number, f: Frame): number => {
      for (let i = start; i < items.length; i++) {
        const r = items[i].s!(f)
        if (r === BREAK) return NEXT
        if (r) return r
      }
      return NEXT
    }
    if (allSync && es)
      return {
        s: (f) => {
          m.line = line
          const v = es(f) as number
          const start = table.get(v) ?? def
          return start < 0 ? NEXT : run(start, f)
        },
      }
    return {
      g: function* (f) {
        m.line = line
        const v = (yield* eg(f)) as number
        const start = table.get(v) ?? def
        if (start < 0) return NEXT
        for (let i = start; i < items.length; i++) {
          const it = items[i]
          const r = it.g ? yield* it.g(f) : it.s!(f)
          if (r === BREAK) return NEXT
          if (r) return r
        }
        return NEXT
      },
    }
  }

  // ------------------------------------------------------------ 식 조립 도우미

  private lift1(t: CType, a: CE, op: (x: unknown) => unknown): CE {
    if (!a.g) {
      const as = a.s!
      return { t, s: (f) => op(as(f)) }
    }
    const ag = a.g
    return {
      t,
      g: function* (f) {
        return op(yield* ag(f))
      },
    }
  }

  private lift2(t: CType, a: CE, b: CE, op: (x: unknown, y: unknown) => unknown): CE {
    if (!a.g && !b.g) {
      const as = a.s!
      const bs = b.s!
      return { t, s: (f) => op(as(f), bs(f)) }
    }
    const ag = genOf(a)
    const bg = genOf(b)
    return {
      t,
      g: function* (f) {
        const x = yield* ag(f)
        const y = yield* bg(f)
        return op(x, y)
      },
    }
  }

  private liftN(t: CType, kids: CE[], op: (vals: unknown[]) => unknown): CE {
    if (kids.every((k) => !k.g)) {
      const fs = kids.map((k) => k.s!)
      if (fs.length === 0) return { t, s: () => op([]) }
      if (fs.length === 1) {
        const [a] = fs
        return { t, s: (f) => op([a(f)]) }
      }
      if (fs.length === 2) {
        const [a, b] = fs
        return { t, s: (f) => op([a(f), b(f)]) }
      }
      return { t, s: (f) => op(fs.map((x) => x(f))) }
    }
    const gs = kids.map((k) => (k.g ? { g: k.g } : { s: k.s! }))
    return {
      t,
      g: function* (f) {
        const vals: unknown[] = []
        for (const k of gs) vals.push(k.g ? yield* k.g(f) : k.s!(f))
        return op(vals)
      },
    }
  }

  /** 값을 형에 맞춘다 (대입·인자·반환) */
  coerce(c: CE, t: CType, line: number): CE {
    const from = c.t
    if (t.k === 'any') return c
    if (t.k === 'int' || t.k === 'float') {
      if (from.k === 'String') throw this.err(`String 을 ${typeName(t)} 로 바꿀 수 없습니다 (toInt() / toFloat() 를 쓰세요)`, line)
      if (from.k === 'obj' || from.k === 'struct' || from.k === 'void') throw this.err(`${typeName(from)} 값을 ${typeName(t)} 로 바꿀 수 없습니다`, line)
      if ((from.k === 'ptr' || from.k === 'array') && !(t.k === 'int' && t.bool)) throw this.err(`포인터·배열을 ${typeName(t)} 로 바꿀 수 없습니다`, line)
      if (from.k === 'int' && t.k === 'int' && from.bits <= t.bits && (from.signed === t.signed || (!from.signed && from.bits < t.bits)) && !t.bool) return { ...c, t }
      if (c.cv !== undefined) {
        const v = convert(c.cv, t) as number
        return { t, s: () => v, cv: v }
      }
      return this.lift1(t, c, (v) => convert(v, t))
    }
    if (t.k === 'String') {
      if (from.k === 'String') return c
      if (from.k === 'obj' || from.k === 'struct' || from.k === 'void') throw this.err(`${typeName(from)} 값을 String 으로 바꿀 수 없습니다`, line)
      return this.lift1(STRING, c, (v) => toArduinoString(v, from))
    }
    if (t.k === 'struct') {
      if (from.k !== 'struct' || from.name !== t.name) throw this.err(`${typeName(from)} 값을 ${t.name} 에 넣을 수 없습니다`, line)
      return this.lift1(t, c, cloneValue)
    }
    if (t.k === 'ptr') {
      if (from.k === 'String') throw this.err('String 을 char* 로 넘기려면 .c_str() 을 쓰세요', line)
      if (from.k === 'int' && c.cv !== 0) throw this.err(`정수를 포인터(${typeName(t)})로 바꿀 수 없습니다`, line)
      return { ...c, t: from.k === 'int' ? t : from.k === 'array' ? { k: 'ptr', to: from.of } : from }
    }
    if (t.k === 'array') {
      if (from.k === 'array' || from.k === 'ptr') return c
      throw this.err(`${typeName(from)} 값을 배열에 넣을 수 없습니다`, line)
    }
    if (t.k === 'obj') {
      if (from.k === 'obj' && from.cls === t.cls) return c
      if (from.k === 'ptr' && from.to.k === 'obj' && from.to.cls === t.cls) return c
      throw this.err(`${typeName(from)} 값을 ${t.cls} 에 넣을 수 없습니다`, line)
    }
    return c
  }

  // ------------------------------------------------------------ 식

  expr(e: Expr, sc: Scope): CE {
    switch (e.k) {
      case 'num': {
        const t = this.literalType(e)
        const v = convert(e.v, t) as number
        return { t, s: () => v, cv: v }
      }
      case 'chr':
        return { t: CHAR, s: () => e.v, cv: e.v }
      case 'bool': {
        const v = e.v ? 1 : 0
        return { t: BOOL, s: () => v, cv: v }
      }
      case 'null':
        return { t: { k: 'ptr', to: VOID }, s: () => null, cv: 0 }
      case 'str': {
        const v = e.v
        return { t: CSTR, s: () => v }
      }
      case 'id':
        return this.ident(e, sc)
      case 'bin':
        return this.binary(e, sc)
      case 'un':
        return this.unary(e, sc)
      case 'post':
        return this.incdec(e.a, e.op, false, sc, e.line)
      case 'assign':
        return this.assign(e, sc)
      case 'cond': {
        const c = this.cond(e.c, sc)
        let a = this.expr(e.a, sc)
        let b = this.expr(e.b, sc)
        let t: CType = a.t
        if ((a.t.k === 'int' || a.t.k === 'float') && (b.t.k === 'int' || b.t.k === 'float')) {
          t = common(a.t, b.t, this.p)
          a = this.coerce(a, t, e.line)
          b = this.coerce(b, t, e.line)
        } else if (a.t.k === 'String' || b.t.k === 'String') {
          t = STRING
          a = this.coerce(a, t, e.line)
          b = this.coerce(b, t, e.line)
        } else if (a.t.k === 'ptr' && b.t.k === 'int' && b.cv === 0) t = a.t
        if (!c.g && !a.g && !b.g) {
          const cs = c.s!
          const as = a.s!
          const bs = b.s!
          return { t, s: (f) => (cs(f) ? as(f) : bs(f)) }
        }
        const cg = genOf(c)
        const ag = genOf(a)
        const bg = genOf(b)
        return {
          t,
          g: function* (f) {
            return (yield* cg(f)) ? yield* ag(f) : yield* bg(f)
          },
        }
      }
      case 'comma': {
        const a = this.expr(e.a, sc)
        const b = this.expr(e.b, sc)
        return this.lift2(b.t, a, b, (_x, y) => y)
      }
      case 'call':
        return this.call(e, sc)
      case 'member':
        return this.member(e, sc)
      case 'index':
        return this.index(e, sc)
      case 'cast': {
        const t = this.resolveType(e.t)
        return this.castTo(this.expr(e.a, sc), t, e.line)
      }
      case 'ctor':
        return this.ctorExpr(this.resolveType(e.t), e.args, sc, e.line)
      case 'sizeof': {
        const v = this.constEval(e, sc)
        if (v === undefined) throw this.err('sizeof 를 계산할 수 없습니다', e.line)
        const t = basicType('size_t', this.p)!
        return { t, s: () => v, cv: v }
      }
      case 'init':
        throw this.err('{ … } 는 변수 초기값에서만 쓸 수 있습니다', e.line)
    }
  }

  private literalType(e: Expr & { k: 'num' }): CType {
    if (e.float) return e.single ? { k: 'float', bits: 32, name: 'float' } : doubleOf(this.p)
    const v = e.v
    const intBits = this.p.intBits
    const fits = (bits: number, signed: boolean) => (signed ? v < 2 ** (bits - 1) : v < 2 ** bits)
    if (e.longs >= 2) return basicType(e.unsigned ? 'unsigned long long' : 'long long', this.p)!
    if (e.longs === 1) {
      if (e.unsigned) return longOf(false)
      return fits(32, true) ? longOf() : longOf(false)
    }
    if (e.unsigned) return fits(intBits, false) ? intOf(this.p, false) : longOf(false)
    if (fits(intBits, true)) return intOf(this.p)
    if (e.radix && fits(intBits, false)) return intOf(this.p, false)
    if (fits(32, true)) return longOf()
    if (e.radix && fits(32, false)) return longOf(false)
    return basicType('long long', this.p)!
  }

  private ident(e: Expr & { k: 'id' }, sc: Scope): CE {
    const v = sc.find(e.name)
    if (v) return this.readVar(v)
    const fns = this.funcs.get(e.name)
    if (fns) return { t: FN, s: () => fns[0], fn: fns[0] }
    const c = this.reg.constants.get(e.name)
    if (c) {
      const val = c.v
      return { t: c.t, s: () => val, cv: typeof val === 'number' ? val : undefined }
    }
    const obj = this.objectRef(e.name)
    if (obj) return obj
    const q = e.name.split('::')
    if (q.length === 2) {
      const cls = this.reg.classes.get(q[0])
      const st = cls?.statics?.[q[1]]
      if (st) {
        const val = st.v
        return { t: st.t, s: () => val, cv: typeof val === 'number' ? val : undefined }
      }
    }
    if (this.reg.functions.has(e.name)) throw this.err(`${e.name} 은(는) 함수입니다. ${e.name}(…) 처럼 불러 주세요`, e.line)
    throw this.err(this.unknownName(e.name), e.line)
  }

  private unknownName(name: string): string {
    const hints: Record<string, string> = {
      Servo: '#include <Servo.h>',
      Wire: '#include <Wire.h>',
      SPI: '#include <SPI.h>',
      EEPROM: '#include <EEPROM.h>',
      FastLED: '#include <FastLED.h>',
    }
    const hint = hints[name]
    return `'${name}' 이(가) 선언되지 않았습니다${hint ? ` (${hint} 가 필요합니다)` : ''}`
  }

  /** 전역 객체 (Serial, Wire …) 는 처음 쓸 때 만든다 */
  private readonly objectSlots = new Map<string, number>()
  private objectRef(name: string): CE | null {
    const def = this.reg.objects.get(name)
    if (!def) return null
    let slot = this.objectSlots.get(name)
    if (slot === undefined) {
      slot = this.G.length
      this.G.push(def.make(this.m))
      this.objectSlots.set(name, slot)
    }
    const G = this.G
    const s = slot
    return { t: { k: 'obj', cls: def.cls }, s: () => G[s] }
  }

  private readVar(v: VarInfo): CE {
    const slot = v.slot
    if (v.cv !== undefined) {
      const val = v.cv
      return { t: v.t, s: () => val, cv: val }
    }
    if (v.kind === 'global') {
      const G = this.G
      return { t: v.t, s: () => G[slot] }
    }
    if (v.kind === 'ref')
      return {
        t: v.t,
        s: (f) => {
          const r = f[slot] as Ptr
          return (r.a as Record<string | number, unknown>)[r.i]
        },
      }
    return { t: v.t, s: (f) => f[slot] }
  }

  /** 대입할 수 있는 위치 */
  private loc(e: Expr, sc: Scope): Loc | null {
    const m = this.m
    switch (e.k) {
      case 'id': {
        const v = sc.find(e.name)
        if (!v) {
          if (this.reg.constants.has(e.name) || this.funcs.has(e.name)) return null
          throw this.err(this.unknownName(e.name), e.line)
        }
        const slot = v.slot
        if (v.kind === 'global') {
          const G = this.G as unknown as Record<number, unknown>
          return {
            t: v.t,
            isConst: v.isConst,
            name: e.name,
            s: () => {
              m.lk = slot
              return G
            },
          }
        }
        if (v.kind === 'ref')
          return {
            t: v.t,
            isConst: v.isConst,
            name: e.name,
            s: (f) => {
              const r = f[slot] as Ptr
              m.lk = r.i
              return r.a as Record<string | number, unknown>
            },
          }
        return {
          t: v.t,
          isConst: v.isConst,
          name: e.name,
          s: (f) => {
            m.lk = slot
            return f as unknown as Record<number, unknown>
          },
        }
      }
      case 'index': {
        const base = this.expr(e.a, sc)
        const i = this.expr(e.i, sc)
        if (i.t.k !== 'int') throw this.err('배열 첨자는 정수여야 합니다', e.line)
        let el: CType
        if (base.t.k === 'array') el = base.t.of
        else if (base.t.k === 'ptr') el = base.t.to
        else if (base.t.k === 'obj' && this.reg.classes.get(base.t.cls)?.index) {
          const ix = this.reg.classes.get(base.t.cls)!.index!
          const bs = base.s!
          const is2 = i.s!
          if (base.g || i.g) throw this.err('이 식은 지원하지 않습니다', e.line)
          return {
            t: ix.t,
            s: (f) => {
              const arr = ix.container(bs(f))
              const k = is2(f) as number
              if (k < 0 || k >= arr.length) throw new RuntimeErr(`범위를 벗어난 주소 ${k} (0–${arr.length - 1})`)
              m.lk = k
              return arr as unknown as Record<number, unknown>
            },
          }
        } else if (base.t.k === 'String') throw this.err('String 의 글자를 바꾸려면 s.setCharAt(i, c) 를 쓰세요', e.line)
        else throw this.err(`${typeName(base.t)} 에는 [ ] 를 쓸 수 없습니다`, e.line)
        const name = e.a.k === 'id' ? e.a.name : '배열'
        const at = (arr: unknown, k: number): Record<number, unknown> => {
          if (Array.isArray(arr)) {
            if (k < 0 || k >= arr.length || !Number.isInteger(k)) throw new RuntimeErr(`배열 범위를 벗어났습니다: ${name}[${k}] (크기 ${arr.length})`)
            m.lk = k
            return arr as unknown as Record<number, unknown>
          }
          if (arr instanceof Ptr) {
            const j = (arr.i as number) + k
            const a = arr.a as unknown[]
            if (Array.isArray(a) && (j < 0 || j >= a.length)) throw new RuntimeErr(`배열 범위를 벗어났습니다: ${name}[${k}]`)
            m.lk = j
            return a as unknown as Record<number, unknown>
          }
          if (typeof arr === 'string') throw new RuntimeErr('문자열 상수는 바꿀 수 없습니다')
          throw new RuntimeErr(`${name} 이(가) 가리키는 배열이 없습니다 (NULL 포인터)`)
        }
        if (!base.g && !i.g) {
          const bs = base.s!
          const is2 = i.s!
          return { t: el, s: (f) => at(bs(f), is2(f) as number) }
        }
        const bg = genOf(base)
        const ig = genOf(i)
        return {
          t: el,
          g: function* (f) {
            const arr = yield* bg(f)
            const k = (yield* ig(f)) as number
            return at(arr, k)
          },
        }
      }
      case 'member': {
        const obj = this.expr(e.obj, sc)
        let st = obj.t
        if (e.arrow) {
          if (st.k !== 'ptr') throw this.err('-> 는 포인터에만 쓸 수 있습니다', e.line)
          st = st.to
        }
        if (st.k === 'struct') {
          const field = st.fields.find((f) => f.name === e.name)
          if (!field) throw this.err(`구조체 ${st.name} 에 멤버 ${e.name} 이(가) 없습니다`, e.line)
          const name = e.name
          const deref = e.arrow
          const pick = (o: unknown) => {
            const target = deref && o instanceof Ptr ? o.get() : o
            m.lk = name
            return target as Record<string, unknown>
          }
          if (!obj.g) {
            const os = obj.s!
            return { t: field.type, s: (f) => pick(os(f)) }
          }
          const og = obj.g
          return {
            t: field.type,
            g: function* (f) {
              return pick(yield* og(f))
            },
          }
        }
        if (st.k === 'obj') {
          const cls = this.reg.classes.get(st.cls)!
          const ft = cls.fields?.[e.name]
          if (!ft) return null
          const name = e.name
          const os = obj.s!
          return {
            t: ft,
            s: (f) => {
              m.lk = name
              return os(f) as Record<string, unknown>
            },
          }
        }
        return null
      }
      case 'un':
        if (e.op === '*') {
          const p = this.expr(e.a, sc)
          if (p.t.k !== 'ptr' && p.t.k !== 'array') throw this.err('* 는 포인터에만 쓸 수 있습니다', e.line)
          const el = p.t.k === 'ptr' ? p.t.to : p.t.of
          const ps = genOf(p)
          const deref = (v: unknown): Record<string | number, unknown> => {
            if (v instanceof Ptr) {
              m.lk = v.i
              return v.a as Record<string | number, unknown>
            }
            if (Array.isArray(v)) {
              m.lk = 0
              return v as unknown as Record<number, unknown>
            }
            throw new RuntimeErr('NULL 포인터를 따라갔습니다')
          }
          if (!p.g) {
            const s = p.s!
            return { t: el, s: (f) => deref(s(f)) }
          }
          return {
            t: el,
            g: function* (f) {
              return deref(yield* ps(f))
            },
          }
        }
        return null
    }
    return null
  }

  private requireLoc(e: Expr, sc: Scope, what: string): Loc {
    const l = this.loc(e, sc)
    if (!l) throw this.err(`${what}: 변수(이름·배열 원소·구조체 멤버)가 필요합니다`, e.line)
    if (l.isConst) throw this.err(`const 변수 ${l.name ?? ''} 은(는) 바꿀 수 없습니다`, e.line)
    return l
  }

  private assign(e: Expr & { k: 'assign' }, sc: Scope): CE {
    const loc = this.requireLoc(e.a, sc, '대입')
    const t = loc.t
    const m = this.m
    if (t.k === 'array') {
      if (t.of.k === 'int' && t.of.bits === 8 && e.b.k === 'str') throw this.err('char 배열에는 = 로 문자열을 넣을 수 없습니다. strcpy(배열, "…") 를 쓰세요', e.line)
      throw this.err('배열에는 = 로 대입할 수 없습니다', e.line)
    }
    let rhs: CE
    if (e.op === '=') {
      rhs = e.b.k === 'init' ? this.initValue(e.b, t, sc, e.line) : this.coerce(this.expr(e.b, sc), t, e.line)
    } else return this.update(loc, e.op.slice(0, -1), this.expr(e.b, sc), e.line)
    if (!loc.g && !rhs.g) {
      const ls = loc.s!
      const rs = rhs.s!
      return {
        t,
        s: (f) => {
          const v = rs(f)
          const c = ls(f)
          c[m.lk] = v
          return v
        },
      }
    }
    const lg =
      loc.g ??
      function* (f: Frame) {
        return loc.s!(f)
      }
    const rg = genOf(rhs)
    return {
      t,
      g: function* (f) {
        const v = yield* rg(f)
        const c = yield* lg(f)
        c[m.lk] = v
        return v
      },
    }
  }

  /** 복합 대입 (+= 등): 위치를 한 번만 계산한다 */
  private update(loc: Loc, op: string, b: CE, line: number): CE {
    const m = this.m
    const t = loc.t
    // 현재 값을 담는 가짜 식으로 연산을 만든다
    let held: unknown
    const cur: CE = { t, s: () => held }
    const result = this.coerce(this.arith(op, cur, b, line), t, line)
    if (result.g || loc.g) {
      // b 가 기다리는 식이면: 먼저 위치를 구하고 b 를 계산
      const lg =
        loc.g ??
        function* (f: Frame) {
          return loc.s!(f)
        }
      const bg = genOf(b)
      const opOnly = this.coerce(this.arith(op, { t, s: () => held }, { t: b.t, s: () => heldB }, line), t, line).s!
      let heldB: unknown
      return {
        t,
        g: function* (f) {
          const c = yield* lg(f)
          const k = m.lk
          const old = c[k]
          const bv = yield* bg(f)
          held = old
          heldB = bv
          const v = opOnly(f)
          c[k] = v
          return v
        },
      }
    }
    const ls = loc.s!
    const rs = result.s!
    return {
      t,
      s: (f) => {
        const c = ls(f)
        const k = m.lk
        held = c[k]
        const v = rs(f)
        c[k] = v
        return v
      },
    }
  }

  private locRead(loc: Loc): CE {
    const m = this.m
    if (loc.g) {
      const g = loc.g
      return {
        t: loc.t,
        g: function* (f) {
          const c = yield* g(f)
          return c[m.lk]
        },
      }
    }
    const s = loc.s!
    return {
      t: loc.t,
      s: (f) => {
        const c = s(f)
        return c[m.lk]
      },
    }
  }

  private incdec(target: Expr, op: string, prefix: boolean, sc: Scope, line: number): CE {
    const loc = this.requireLoc(target, sc, op)
    const t = loc.t
    const m = this.m
    const d = op === '++' ? 1 : -1
    let step: (v: unknown) => unknown
    if (t.k === 'int' || t.k === 'float') step = (v) => convert((v as number) + d, t)
    else if (t.k === 'ptr')
      step = (v) => {
        if (v instanceof Ptr) return v.offset(d)
        if (typeof v === 'string') return d > 0 ? v.slice(1) : v
        if (Array.isArray(v)) return new Ptr(v, d, t.to)
        throw new RuntimeErr('NULL 포인터를 옮겼습니다')
      }
    else throw this.err(`${typeName(t)} 에는 ${op} 를 쓸 수 없습니다`, line)
    if (loc.g) {
      const g = loc.g
      return {
        t,
        g: function* (f) {
          const c = yield* g(f)
          const k = m.lk
          const old = c[k]
          const v = step(old)
          c[k] = v
          return prefix ? v : old
        },
      }
    }
    const s = loc.s!
    return {
      t,
      s: prefix
        ? (f) => {
            const c = s(f)
            const k = m.lk
            const v = step(c[k])
            c[k] = v
            return v
          }
        : (f) => {
            const c = s(f)
            const k = m.lk
            const old = c[k]
            c[k] = step(old)
            return old
          },
    }
  }

  private unary(e: Expr & { k: 'un' }, sc: Scope): CE {
    if (e.op === '++' || e.op === '--') return this.incdec(e.a, e.op, true, sc, e.line)
    if (e.op === '&') return this.addressOf(e.a, sc, e.line)
    if (e.op === '*') {
      const l = this.loc(e, sc)!
      return this.locRead(l)
    }
    const a = this.expr(e.a, sc)
    if (e.op === '!') {
      if (a.t.k === 'String') throw this.err('String 에는 ! 를 쓸 수 없습니다', e.line)
      if (a.cv !== undefined) {
        const v = a.cv ? 0 : 1
        return { t: BOOL, s: () => v, cv: v }
      }
      return this.lift1(BOOL, a, (v) => (truthy(v) ? 0 : 1))
    }
    if (a.t.k !== 'int' && a.t.k !== 'float') throw this.err(`${typeName(a.t)} 에는 ${e.op} 를 쓸 수 없습니다`, e.line)
    const t = promote(a.t, this.p)
    if (e.op === '~' && t.k !== 'int') throw this.err('~ 는 정수에만 쓸 수 있습니다', e.line)
    const op = e.op === '-' ? (v: unknown) => convert(-(v as number), t) : e.op === '~' ? (v: unknown) => convert(~(v as number), t) : (v: unknown) => v
    if (a.cv !== undefined) {
      const v = op(a.cv) as number
      return { t, s: () => v, cv: v }
    }
    return this.lift1(t, a, op)
  }

  private addressOf(target: Expr, sc: Scope, line: number): CE {
    // 함수 이름 → 함수, 객체 → 객체 자신(포인터처럼 쓴다)
    if (target.k === 'id' && !sc.find(target.name)) {
      const fns = this.funcs.get(target.name)
      if (fns) return { t: FN, s: () => fns[0], fn: fns[0] }
      const obj = this.objectRef(target.name)
      if (obj) return { ...obj, t: { k: 'ptr', to: obj.t } }
    }
    const loc = this.loc(target, sc)
    if (!loc) throw this.err('& 는 변수에만 쓸 수 있습니다', line)
    const t = loc.t
    const m = this.m
    if (t.k === 'obj') {
      const read = this.locRead(loc)
      return { ...read, t: { k: 'ptr', to: t } }
    }
    if (t.k === 'array') {
      // &arr → arr 와 같은 주소
      const read = this.locRead(loc)
      return this.lift1({ k: 'ptr', to: t.of }, read, (v) => new Ptr(v as unknown[], 0, t.of))
    }
    if (loc.g) {
      const g = loc.g
      return {
        t: { k: 'ptr', to: t },
        g: function* (f) {
          const c = yield* g(f)
          return new Ptr(c, m.lk, t)
        },
      }
    }
    const s = loc.s!
    return {
      t: { k: 'ptr', to: t },
      s: (f) => {
        const c = s(f)
        return new Ptr(c, m.lk, t)
      },
    }
  }

  private binary(e: Expr & { k: 'bin' }, sc: Scope): CE {
    if (e.op === '&&' || e.op === '||') {
      const a = this.cond(e.a, sc)
      const b = this.cond(e.b, sc)
      const and = e.op === '&&'
      if (a.cv !== undefined && b.cv !== undefined) {
        const v = and ? +(a.cv && b.cv) : +(a.cv || b.cv)
        return { t: BOOL, s: () => v, cv: v }
      }
      if (!a.g && !b.g) {
        const as = a.s!
        const bs = b.s!
        return { t: BOOL, s: and ? (f) => (as(f) ? (bs(f) ? 1 : 0) : 0) : (f) => (as(f) ? 1 : bs(f) ? 1 : 0) }
      }
      const ag = genOf(a)
      const bg = genOf(b)
      return {
        t: BOOL,
        g: and
          ? function* (f) {
              return (yield* ag(f)) ? ((yield* bg(f)) ? 1 : 0) : 0
            }
          : function* (f) {
              return (yield* ag(f)) ? 1 : (yield* bg(f)) ? 1 : 0
            },
      }
    }
    const a = this.expr(e.a, sc)
    const b = this.expr(e.b, sc)
    return this.arith(e.op, a, b, e.line)
  }

  /** 이항 연산 (산술·비교·비트·문자열 연결·포인터 산술) */
  arith(op: string, a: CE, b: CE, line: number): CE {
    const at = a.t
    const bt = b.t
    const cmp = ['==', '!=', '<', '>', '<=', '>='].includes(op)
    // String 연결·비교
    if (at.k === 'String' || bt.k === 'String') {
      if (op === '+') {
        if (at.k === 'obj' || bt.k === 'obj' || at.k === 'void' || bt.k === 'void') throw this.err('String 에 더할 수 없는 값입니다', line)
        return this.lift2(STRING, a, b, (x, y) => toArduinoString(x, at) + toArduinoString(y, bt))
      }
      if (cmp) {
        const ac = at.k === 'String' || isCharPtr(at) ? a : null
        const bc = bt.k === 'String' || isCharPtr(bt) ? b : null
        if (!ac || !bc) throw this.err(`String 과 ${typeName(at.k === 'String' ? bt : at)} 는 비교할 수 없습니다`, line)
        const f = compareFn(op)
        return this.lift2(BOOL, a, b, (x, y) => f(cstrText(x), cstrText(y)))
      }
      throw this.err(`String 에는 ${op} 를 쓸 수 없습니다`, line)
    }
    // 포인터·배열 산술과 비교
    if (at.k === 'ptr' || at.k === 'array' || bt.k === 'ptr' || bt.k === 'array') {
      if (cmp) {
        if (isCharPtr(at) && isCharPtr(bt) && (op === '==' || op === '!=')) this.warn(line, 'char* 문자열을 == 로 비교하면 내용이 아니라 주소를 비교합니다. strcmp(a, b) == 0 이나 String 을 쓰세요')
        const eq = op === '=='
        if (op === '==' || op === '!=')
          return this.lift2(BOOL, a, b, (x, y) => {
            const same = x === y || (x instanceof Ptr && y instanceof Ptr && x.a === y.a && x.i === y.i) || ((x === null || x === 0) && (y === null || y === 0))
            return same === eq ? 1 : 0
          })
        const f = compareFn(op)
        return this.lift2(BOOL, a, b, (x, y) => f(x instanceof Ptr ? (x.i as number) : 0, y instanceof Ptr ? (y.i as number) : 0))
      }
      if ((op === '+' || op === '-') && (bt.k === 'int' || (op === '+' && at.k === 'int'))) {
        const [pc, nc, sign] = bt.k === 'int' ? [a, b, op === '-' ? -1 : 1] : [b, a, 1]
        const pt = pc.t.k === 'array' ? ({ k: 'ptr', to: pc.t.of } as CType) : pc.t
        const el = pt.k === 'ptr' ? pt.to : CHAR
        return this.lift2(pt, pc, nc, (p, n) => {
          const k = (n as number) * sign
          if (typeof p === 'string') return k >= 0 ? p.slice(k) : p
          if (p instanceof Ptr) return p.offset(k)
          if (Array.isArray(p)) return new Ptr(p, k, el)
          throw new RuntimeErr('NULL 포인터 산술')
        })
      }
      if (op === '-' && (at.k === 'ptr' || at.k === 'array') && (bt.k === 'ptr' || bt.k === 'array'))
        return this.lift2(intOf(this.p), a, b, (x, y) => (x instanceof Ptr ? (x.i as number) : 0) - (y instanceof Ptr ? (y.i as number) : 0))
      throw this.err(`포인터·배열에는 ${op} 를 쓸 수 없습니다`, line)
    }
    if ((at.k !== 'int' && at.k !== 'float') || (bt.k !== 'int' && bt.k !== 'float')) {
      if (at.k === 'obj' && op === '==') throw this.err('객체는 == 로 비교할 수 없습니다', line)
      throw this.err(`${typeName(at)} 와(과) ${typeName(bt)} 에는 ${op} 를 쓸 수 없습니다`, line)
    }
    const shift = op === '<<' || op === '>>'
    const ct = shift ? promote(at, this.p) : common(at, bt, this.p)
    if (ct.k === 'float' && ['%', '<<', '>>', '&', '|', '^'].includes(op)) throw this.err(op === '%' ? '실수에는 % 를 쓸 수 없습니다. fmod(a, b) 를 쓰세요' : `실수에는 ${op} 를 쓸 수 없습니다`, line)
    const ca = !shift && needsConv(at, ct) ? (v: unknown) => convert(v, ct) as number : null
    const cb = !shift && needsConv(bt, ct) ? (v: unknown) => convert(v, ct) as number : null
    if (cmp) {
      const f = compareFn(op)
      const g = ca || cb ? (x: unknown, y: unknown) => f(ca ? ca(x) : (x as number), cb ? cb(y) : (y as number)) : (x: unknown, y: unknown) => f(x as number, y as number)
      if (a.cv !== undefined && b.cv !== undefined) {
        const v = g(a.cv, b.cv)
        return { t: BOOL, s: () => v, cv: v }
      }
      return this.lift2(BOOL, a, b, g)
    }
    const fn = arithFn(op, ct)
    if (ca && ct.k === 'int' && op === '+' && at.k === 'int' && at.signed && !ct.signed) {
      // 부호 있는 값과 부호 없는 값의 연산: C 처럼 부호 없는 값으로 바꾼다 (아래 일반 경로)
    }
    const h = ca || cb ? (x: unknown, y: unknown) => fn(ca ? ca(x) : (x as number), cb ? cb(y) : (y as number)) : (x: unknown, y: unknown) => fn(x as number, y as number)
    if (a.cv !== undefined && b.cv !== undefined) {
      try {
        const v = h(a.cv, b.cv)
        return { t: ct, s: () => v, cv: v }
      } catch (err) {
        if (err instanceof RuntimeErr) throw this.err(err.message, line)
        throw err
      }
    }
    if (!a.g && !b.g) {
      const as = a.s!
      const bs = b.s!
      if (!ca && !cb) return { t: ct, s: (f) => fn(as(f) as number, bs(f) as number) }
      return { t: ct, s: (f) => h(as(f), bs(f)) }
    }
    return this.lift2(ct, a, b, h)
  }

  private castTo(c: CE, t: CType, line: number): CE {
    if (t.k === 'int' || t.k === 'float') {
      if (c.t.k === 'ptr' || c.t.k === 'array') {
        if (t.k === 'int' && t.bool) return this.lift1(t, c, (v) => (v === null ? 0 : 1))
        throw this.err('포인터를 정수로 바꾸는 캐스트는 지원하지 않습니다', line)
      }
      if (c.t.k === 'String' || c.t.k === 'obj' || c.t.k === 'struct') throw this.err(`${typeName(c.t)} 를 ${typeName(t)} 로 캐스트할 수 없습니다`, line)
      if (c.cv !== undefined) {
        const v = convert(c.cv, t) as number
        return { t, s: () => v, cv: v }
      }
      return this.lift1(t, c, (v) => convert(v, t))
    }
    if (t.k === 'ptr') return { ...c, t: c.t.k === 'array' ? t : c.t.k === 'ptr' ? t : t }
    if (t.k === 'String') return this.coerce(c, t, line)
    if (t.k === 'void') return this.lift1(VOID, c, () => undefined)
    return this.coerce(c, t, line)
  }

  /** int(x), String(x, HEX), Servo(), CRGB(255, 0, 0) … */
  private ctorExpr(t: CType, argsE: Expr[], sc: Scope, line: number): CE {
    if (t.k === 'int' || t.k === 'float') {
      if (argsE.length === 0) return { t, s: () => 0, cv: 0 }
      if (argsE.length !== 1) throw this.err(`${typeName(t)}(…) 에는 값 하나가 필요합니다`, line)
      return this.castTo(this.expr(argsE[0], sc), t, line)
    }
    if (t.k === 'String') {
      if (argsE.length === 0) return { t, s: () => '' }
      const args = argsE.map((a) => this.expr(a, sc))
      if (args.length > 2) throw this.err('String(값[, 진법·자릿수]) 형식입니다', line)
      const vt = args[0].t
      if (vt.k === 'obj' || vt.k === 'struct' || vt.k === 'void') throw this.err(`${typeName(vt)} 로 String 을 만들 수 없습니다`, line)
      if (args.length === 2 && vt.k !== 'int' && vt.k !== 'float') throw this.err('String(값, 진법·자릿수) 는 숫자에만 씁니다', line)
      return this.liftN(STRING, args, (v) => toArduinoString(v[0], vt, v[1] as number | undefined))
    }
    if (t.k === 'struct') {
      return this.initValue({ k: 'init', items: argsE, line }, t, sc, line)
    }
    if (t.k === 'obj') return this.construct(this.reg.classes.get(t.cls)!, argsE, sc, line)
    throw this.err(`${typeName(t)}(…) 는 지원하지 않습니다`, line)
  }

  private construct(cls: ClassDef, argsE: Expr[], sc: Scope, line: number): CE {
    const min = cls.ctorMin ?? 0
    const max = cls.ctorMax ?? Infinity
    if (argsE.length < min || argsE.length > max)
      throw this.err(`${cls.name} 을(를) 만들 때 인자가 ${min === max ? `${min}개` : `${min}–${max === Infinity ? '' : max}개`} 필요합니다 (지금 ${argsE.length}개)`, line)
    const args = argsE.map((a) => this.expr(a, sc))
    const types = args.map((a) => a.t)
    const m = this.m
    return this.liftN({ k: 'obj', cls: cls.name }, args, (vals) => cls.construct(m, vals, types))
  }

  // ------------------------------------------------------------ 함수 호출

  private call(e: Expr & { k: 'call' }, sc: Scope): CE {
    if (e.fn.k === 'member') return this.methodCall(e, e.fn, sc)
    if (e.fn.k !== 'id') throw this.err('이 형태의 함수 호출은 지원하지 않습니다', e.line)
    const name = e.fn.name
    if (sc.find(name)) throw this.err(`'${name}' 은(는) 변수입니다. 함수처럼 부를 수 없습니다`, e.line)
    const user = this.funcs.get(name)
    if (user) return this.userCall(name, user, e.args, sc, e.line)
    const b = this.reg.functions.get(name)
    if (b) return this.builtinCall(name, b, e.args, sc, e.line)
    if (name === 'F' || name === 'PSTR') {
      if (e.args.length !== 1 || e.args[0].k !== 'str') throw this.err(`${name}("…") 형식이어야 합니다`, e.line)
      return this.expr(e.args[0], sc)
    }
    if (name === 'setup' || name === 'loop') throw this.err(`${name}() 함수가 정의되지 않았습니다`, e.line)
    throw this.err(`함수 '${name}' 이(가) 없습니다${this.unknownName(name).includes('#include') ? this.unknownName(name).slice(this.unknownName(name).indexOf(' (')) : ''}`, e.line)
  }

  private userCall(name: string, fns: FnInfo[], argsE: Expr[], sc: Scope, line: number): CE {
    const fi =
      fns.find((f) => argsE.length <= f.params.length && argsE.length >= f.params.filter((p) => !p.def).length && f.params.length === argsE.length) ??
      fns.find((f) => argsE.length <= f.params.length && argsE.length >= f.params.filter((p) => !p.def).length)
    if (!fi) {
      const f0 = fns[0]
      throw this.err(`${name}() 에는 인자가 ${f0.params.length}개 필요합니다 (지금 ${argsE.length}개)`, line)
    }
    const args: CE[] = fi.params.map((p, i) => {
      const ae = argsE[i] ?? p.def!
      if (p.ref) {
        const loc = this.loc(ae, sc)
        if (!loc) throw this.err(`${name}() 의 ${i + 1}번째 인자(참조 매개변수 ${p.name})에는 변수를 넘겨야 합니다`, line)
        if (loc.g) throw this.err('이 식은 참조로 넘길 수 없습니다', line)
        const m = this.m
        const ls = loc.s!
        const t = p.t
        return { t: p.t, s: (f: Frame) => new Ptr(ls(f), m.lk, t) }
      }
      const c = this.expr(ae, sc)
      if (p.t.k === 'array') {
        if (c.t.k !== 'array' && c.t.k !== 'ptr') throw this.err(`${name}() 의 ${i + 1}번째 인자는 배열이어야 합니다`, line)
        return c
      }
      return this.coerce(c, p.t, line)
    })
    const ret = fi.ret
    if (fi.isGen) {
      if (args.every((a) => !a.g)) {
        const fs = args.map((a) => a.s!)
        return {
          t: ret,
          g: function* (f) {
            const vals = fs.map((x) => x(f))
            return yield* fi.gen!(vals)
          },
        }
      }
      const gs = args.map(genOf)
      return {
        t: ret,
        g: function* (f) {
          const vals: unknown[] = []
          for (const g of gs) vals.push(yield* g(f))
          return yield* fi.gen!(vals)
        },
      }
    }
    if (args.every((a) => !a.g)) {
      const fs = args.map((a) => a.s!)
      if (fs.length === 0) return { t: ret, s: () => fi.sync!([]) }
      if (fs.length === 1) {
        const [a] = fs
        return { t: ret, s: (f) => fi.sync!([a(f)]) }
      }
      if (fs.length === 2) {
        const [a, b] = fs
        return { t: ret, s: (f) => fi.sync!([a(f), b(f)]) }
      }
      return { t: ret, s: (f) => fi.sync!(fs.map((x) => x(f))) }
    }
    return this.liftN(ret, args, (vals) => fi.sync!(vals))
  }

  private argsFor(name: string, b: BuiltinFn | MethodDef, argsE: Expr[], sc: Scope, line: number): CE[] {
    if (b.core && b.core !== this.p.core) throw this.err(`${name} 은(는) ${b.core === 'esp32' ? 'ESP32' : 'AVR(Uno·Nano·Mega)'} 보드에서만 쓸 수 있습니다`, line)
    const min = b.min ?? 0
    const max = b.max ?? Infinity
    if (argsE.length < min || argsE.length > max)
      throw this.err(`${name}() 에는 인자가 ${min === max ? `${min}개` : max === Infinity ? `${min}개 이상` : `${min}–${max}개`} 필요합니다 (지금 ${argsE.length}개)${b.usage ? ` — 예: ${b.usage}` : ''}`, line)
    return argsE.map((a, i) => {
      if (b.refArgs?.includes(i)) {
        const loc = this.loc(a, sc)
        if (!loc?.s) throw this.err(`${name}() 의 ${i + 1}번째 인자에는 변수가 필요합니다`, line)
        const m = this.m
        const ls = loc.s
        const t = loc.t
        return { t, s: (f: Frame) => new Ptr(ls(f), m.lk, t) }
      }
      return this.expr(a, sc)
    })
  }

  private builtinCall(name: string, b: BuiltinFn, argsE: Expr[], sc: Scope, line: number): CE {
    const args = this.argsFor(name, b, argsE, sc, line)
    const types = args.map((a) => a.t)
    const ret = typeof b.ret === 'function' ? b.ret(types, this.p) : b.ret
    const m = this.m
    if (b.gen) {
      const bg = b.gen
      const gs = args.map((a) => (a.g ? { g: a.g } : { s: a.s! }))
      return {
        t: ret,
        g: function* (f) {
          const vals: unknown[] = []
          for (const k of gs) vals.push(k.g ? yield* k.g(f) : k.s!(f))
          return yield* bg(m, vals, types)
        },
      }
    }
    const call = b.call!
    if (args.every((a) => !a.g)) {
      const fs = args.map((a) => a.s!)
      if (fs.length === 0) return { t: ret, s: () => call(m, NO_ARGS, types) }
      if (fs.length === 1) {
        const [a] = fs
        return { t: ret, s: (f) => call(m, [a(f)], types) }
      }
      if (fs.length === 2) {
        const [a, c] = fs
        return { t: ret, s: (f) => call(m, [a(f), c(f)], types) }
      }
      return { t: ret, s: (f) => call(m, fs.map((x) => x(f)), types) }
    }
    return this.liftN(ret, args, (vals) => call(m, vals, types))
  }

  private methodCall(e: Expr & { k: 'call' }, fn: Expr & { k: 'member' }, sc: Scope): CE {
    const obj = this.expr(fn.obj, sc)
    let ot = obj.t
    if (fn.arrow) {
      if (ot.k !== 'ptr') throw this.err('-> 는 포인터에만 쓸 수 있습니다', e.line)
      ot = ot.to
    } else if (ot.k === 'ptr' && ot.to.k === 'obj') throw this.err(`포인터의 메서드는 -> 로 부르세요 (${fn.name})`, e.line)
    if (ot.k === 'String') return this.stringMethod(fn, obj, e.args, sc, e.line)
    if (ot.k !== 'obj') throw this.err(`${typeName(ot)} 에는 메서드 ${fn.name}() 이(가) 없습니다`, e.line)
    const cls = this.reg.classes.get(ot.cls)!
    const md = cls.methods[fn.name]
    if (!md) throw this.err(`${cls.name} 에는 ${fn.name}() 메서드가 없습니다${suggest(fn.name, Object.keys(cls.methods))}`, e.line)
    const args = this.argsFor(`${cls.name}.${fn.name}`, md, e.args, sc, e.line)
    if (e.targs) {
      // 템플릿 인자 (FastLED.addLeds<WS2812B, 6, GRB>) 는 맨 앞 인자로 넘긴다
      const targs = e.targs.map((t) => ('ptr' in t && 'dims' in t ? t.name : (this.constEval(t, sc) ?? (t.k === 'id' ? t.name : null))))
      args.unshift({ t: ANY, s: () => targs })
    }
    const types = args.map((a) => a.t)
    const ret = typeof md.ret === 'function' ? md.ret(types, this.p) : md.ret
    const m = this.m
    const kids = [obj, ...args]
    if (md.gen) {
      const mg = md.gen
      const gs = kids.map((a) => (a.g ? { g: a.g } : { s: a.s! }))
      return {
        t: ret,
        g: function* (f) {
          const vals: unknown[] = []
          for (const k of gs) vals.push(k.g ? yield* k.g(f) : k.s!(f))
          return yield* mg(m, vals[0], vals.slice(1), types)
        },
      }
    }
    const call = md.call!
    if (kids.every((a) => !a.g)) {
      const os = obj.s!
      const fs = args.map((a) => a.s!)
      if (fs.length === 0) return { t: ret, s: (f) => call(m, os(f), NO_ARGS, types) }
      if (fs.length === 1) {
        const [a] = fs
        return { t: ret, s: (f) => call(m, os(f), [a(f)], types) }
      }
      return { t: ret, s: (f) => call(m, os(f), fs.map((x) => x(f)), types) }
    }
    return this.liftN(ret, kids, (vals) => call(m, vals[0], vals.slice(1), types))
  }

  private member(e: Expr & { k: 'member' }, sc: Scope): CE {
    const loc = this.loc(e, sc)
    if (loc) return this.locRead(loc)
    const obj = this.expr(e.obj, sc)
    if (obj.t.k === 'obj' || obj.t.k === 'String') throw this.err(`${e.name} 은(는) 메서드입니다. ${e.name}() 처럼 불러 주세요`, e.line)
    throw this.err(`${typeName(obj.t)} 에는 멤버 ${e.name} 이(가) 없습니다`, e.line)
  }

  private index(e: Expr & { k: 'index' }, sc: Scope): CE {
    const base = this.expr(e.a, sc)
    if (base.t.k === 'String' || (base.t.k === 'ptr' && base.t.to.k === 'int' && base.t.to.bits === 8)) {
      // 문자열 글자 읽기 (상수 문자열·String 은 JS 문자열)
      const i = this.expr(e.i, sc)
      const isString = base.t.k === 'String'
      const m = this.m
      return this.lift2(CHAR, base, i, (s, k) => {
        if (typeof s === 'string') {
          const bytes = utf8(s)
          const n = k as number
          if (n < 0 || n > bytes.length) {
            if (isString) return 0
            throw new RuntimeErr(`문자열 범위를 벗어났습니다: [${n}]`)
          }
          const b = n === bytes.length ? 0 : bytes[n]
          return b > 127 ? b - 256 : b
        }
        void m
        if (s instanceof Ptr || Array.isArray(s)) {
          const arr = s instanceof Ptr ? (s.a as unknown[]) : s
          const j = (s instanceof Ptr ? (s.i as number) : 0) + (k as number)
          if (j < 0 || j >= arr.length) throw new RuntimeErr(`배열 범위를 벗어났습니다: [${k}]`)
          return arr[j]
        }
        throw new RuntimeErr('NULL 포인터를 따라갔습니다')
      })
    }
    const loc = this.loc(e, sc)!
    return this.locRead(loc)
  }

  // ------------------------------------------------------------ String 메서드

  private stringMethod(fn: Expr & { k: 'member' }, obj: CE, argsE: Expr[], sc: Scope, line: number): CE {
    const name = fn.name
    const args = argsE.map((a) => this.expr(a, sc))
    const types = args.map((a) => a.t)
    const need = (min: number, max = min) => {
      if (args.length < min || args.length > max) throw this.err(`String.${name}() 에는 인자가 ${min === max ? min : `${min}–${max}`}개 필요합니다`, line)
    }
    const text = (v: unknown, t: CType) => (t.k === 'String' ? (v as string) : toArduinoString(v, t))
    const pure = (t: CType, op: (s: string, a: unknown[]) => unknown) => this.liftN(t, [obj, ...args], (v) => op(v[0] as string, v.slice(1)))
    const int = intOf(this.p)
    switch (name) {
      case 'length':
        need(0)
        return pure(basicType('unsigned int', this.p)!, (s) => utf8(s).length)
      case 'isEmpty':
        need(0)
        return pure(BOOL, (s) => (s.length ? 0 : 1))
      case 'charAt':
        need(1)
        return pure(CHAR, (s, a) => {
          const b = utf8(s)[a[0] as number] ?? 0
          return b > 127 ? b - 256 : b
        })
      case 'substring':
        need(1, 2)
        return pure(STRING, (s, a) => {
          const from = Math.max(0, a[0] as number)
          const to = a.length > 1 ? Math.max(0, a[1] as number) : undefined
          return to !== undefined && to < from ? s.slice(to, from) : s.slice(from, to)
        })
      case 'indexOf':
      case 'lastIndexOf':
        need(1, 2)
        return pure(int, (s, a) => {
          const what = text(a[0], types[0])
          if (name === 'indexOf') return s.indexOf(what, (a[1] as number | undefined) ?? 0)
          return a.length > 1 ? s.lastIndexOf(what, a[1] as number) : s.lastIndexOf(what)
        })
      case 'startsWith':
        need(1, 2)
        return pure(BOOL, (s, a) => +s.startsWith(text(a[0], types[0]), (a[1] as number | undefined) ?? 0))
      case 'endsWith':
        need(1)
        return pure(BOOL, (s, a) => +s.endsWith(text(a[0], types[0])))
      case 'equals':
        need(1)
        return pure(BOOL, (s, a) => +(s === text(a[0], types[0])))
      case 'equalsIgnoreCase':
        need(1)
        return pure(BOOL, (s, a) => +(s.toLowerCase() === text(a[0], types[0]).toLowerCase()))
      case 'compareTo':
        need(1)
        return pure(int, (s, a) => {
          const o = text(a[0], types[0])
          return s < o ? -1 : s > o ? 1 : 0
        })
      case 'toInt':
        need(0)
        return pure(longOf(), (s) => wrapInt(parseLeadingInt(s), 32, true))
      case 'toFloat':
        need(0)
        return pure({ k: 'float', bits: 32, name: 'float' }, (s) => Math.fround(parseLeadingFloat(s)))
      case 'toDouble':
        need(0)
        return pure(doubleOf(this.p), (s) => parseLeadingFloat(s))
      case 'c_str':
        need(0)
        return pure(CSTR, (s) => s)
      case 'reserve':
        need(1)
        return pure(BOOL, () => 1)
      case 'toCharArray':
      case 'getBytes':
        need(2)
        return pure(VOID, (s, a) => {
          writeCstr(a[0], s, a[1] as number)
          return undefined
        })
    }
    // 원본을 바꾸는 메서드
    const mutate: Record<string, [number, number, (s: string, a: unknown[]) => string]> = {
      trim: [0, 0, (s) => s.trim()],
      toUpperCase: [0, 0, (s) => s.toUpperCase()],
      toLowerCase: [0, 0, (s) => s.toLowerCase()],
      replace: [2, 2, (s, a) => s.split(text(a[0], types[0])).join(text(a[1], types[1]))],
      remove: [1, 2, (s, a) => (a.length > 1 ? s.slice(0, a[0] as number) + s.slice((a[0] as number) + (a[1] as number)) : s.slice(0, a[0] as number))],
      concat: [1, 1, (s, a) => s + text(a[0], types[0])],
      setCharAt: [
        2,
        2,
        (s, a) => {
          const i = a[0] as number
          if (i < 0 || i >= s.length) return s
          return s.slice(0, i) + String.fromCharCode((a[1] as number) & 255) + s.slice(i + 1)
        },
      ],
    }
    const mu = mutate[name]
    if (!mu) throw this.err(`String 에는 ${name}() 메서드가 없습니다${suggest(name, ['length', 'charAt', 'substring', 'indexOf', 'toInt', 'toFloat', 'trim', 'replace', 'startsWith', 'equals', 'c_str', 'toUpperCase', 'remove', 'concat'])}`, line)
    need(mu[0], mu[1])
    const loc = this.loc(fn.obj, sc)
    const rt = name === 'concat' ? BOOL : VOID
    const done = name === 'concat' ? 1 : undefined
    if (!loc?.s || args.some((a) => a.g)) return pure(rt, (s, a) => (mu[2](s, a), done)) // 임시 String: 원본이 없다
    const m = this.m
    const ls = loc.s
    const op = mu[2]
    const fs = args.map((a) => a.s!)
    return {
      t: rt,
      s: (f) => {
        const vals = fs.map((x) => x(f))
        const c = ls(f)
        const k = m.lk
        c[k] = op(c[k] as string, vals)
        return done
      },
    }
  }
}

function needsConv(from: CType, to: CType): boolean {
  if (from.k === 'int' && to.k === 'int') return from.signed && !to.signed
  if (from.k === 'int' && to.k === 'float') return to.bits === 32 && from.bits >= 32
  return false
}

function compareFn(op: string): (a: number | string, b: number | string) => number {
  switch (op) {
    case '==':
      return (a, b) => (a === b ? 1 : 0)
    case '!=':
      return (a, b) => (a !== b ? 1 : 0)
    case '<':
      return (a, b) => (a < b ? 1 : 0)
    case '>':
      return (a, b) => (a > b ? 1 : 0)
    case '<=':
      return (a, b) => (a <= b ? 1 : 0)
    default:
      return (a, b) => (a >= b ? 1 : 0)
  }
}

const divZero = () => new RuntimeErr('0 으로 나눴습니다')

/** 형별 산술 함수 */
function arithFn(op: string, t: CType): (a: number, b: number) => number {
  if (t.k === 'float') {
    const r = t.bits === 32 ? Math.fround : (x: number) => x
    switch (op) {
      case '+':
        return (a, b) => r(a + b)
      case '-':
        return (a, b) => r(a - b)
      case '*':
        return (a, b) => r(a * b)
      case '/':
        return (a, b) => r(a / b)
    }
    throw new Error(op)
  }
  if (!isInt(t)) throw new Error('int')
  const { bits, signed } = t
  const W: (x: number) => number =
    bits === 32 ? (signed ? (x) => x | 0 : (x) => x >>> 0) : bits === 16 ? (signed ? (x) => (x << 16) >> 16 : (x) => x & 0xffff) : bits === 8 ? (signed ? (x) => (x << 24) >> 24 : (x) => x & 0xff) : (x) => wrapInt(x, 64, signed)
  const big = bits === 64
  switch (op) {
    case '+':
      return big ? (a, b) => W(a + b) : (a, b) => W(a + b)
    case '-':
      return (a, b) => W(a - b)
    case '*':
      return bits === 32 ? (a, b) => W(Math.imul(a, b)) : (a, b) => W(a * b)
    case '/':
      return (a, b) => {
        if (b === 0) throw divZero()
        return W(Math.trunc(a / b))
      }
    case '%':
      return (a, b) => {
        if (b === 0) throw divZero()
        return W(a % b)
      }
    case '<<':
      return big ? (a, b) => W(a * 2 ** b) : (a, b) => (b >= 32 ? 0 : W(a << b))
    case '>>':
      return big ? (a, b) => Math.floor(a / 2 ** b) : signed ? (a, b) => a >> Math.min(b, 31) : (a, b) => (b >= 32 ? 0 : a >>> b)
    case '&':
      return big ? (a, b) => Number(BigInt.asUintN(64, BigInt(a)) & BigInt.asUintN(64, BigInt(b))) : (a, b) => W(a & b)
    case '|':
      return big ? (a, b) => Number(BigInt.asUintN(64, BigInt(a)) | BigInt.asUintN(64, BigInt(b))) : (a, b) => W(a | b)
    case '^':
      return big ? (a, b) => Number(BigInt.asUintN(64, BigInt(a)) ^ BigInt.asUintN(64, BigInt(b))) : (a, b) => W(a ^ b)
  }
  throw new Error(op)
}

function suggest(name: string, options: string[]): string {
  const lower = name.toLowerCase()
  const hit = options.find((o) => o.toLowerCase() === lower) ?? options.find((o) => o.toLowerCase().startsWith(lower.slice(0, 4)))
  return hit && hit !== name ? ` (혹시 ${hit}() ?)` : ''
}

export { BREAK, CONTINUE, NEXT, RETURN }
