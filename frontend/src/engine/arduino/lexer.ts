// Arduino 스케치(C++ 일부) 토큰화와 전처리
//
// 주석을 지우고 #include · #define · #if 계열 지시문을 처리한 뒤 토큰 목록을 만든다.
// 매크로는 객체형(#define LED 13)과 함수형(#define SQ(x) ((x)*(x)))을 펼친다.

export type TokKind = 'id' | 'num' | 'str' | 'chr' | 'op' | 'eof'

export interface Tok {
  k: TokKind
  v: string
  line: number
  /** 숫자·문자 값 */
  num?: number
  /** 실수 리터럴 (1.5, 2.0f, 1e3) */
  float?: boolean
  /** f 접미사 */
  single?: boolean
  unsigned?: boolean
  /** L 접미사 개수 */
  longs?: number
  /** 16진수·8진수·2진수 리터럴 (int 에 안 맞으면 unsigned 로 넘어갈 수 있다) */
  radix?: boolean
}

export class CompileError extends Error {
  readonly line: number
  constructor(message: string, line: number) {
    super(message)
    this.line = line
  }
}

const OPS = [
  '<<=', '>>=', '...', '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '::', '##',
  '+', '-', '*', '/', '%', '<', '>', '=', '!', '&', '|', '^', '~', '?', ':', ';', ',', '.', '(', ')', '[', ']', '{', '}', '#',
]

/** 주석을 공백으로 바꾼다 (줄 번호를 지키려고 줄바꿈은 남긴다) */
export function stripComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && d === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      i += 2
      out += ' '
      continue
    }
    if (c === '"' || c === "'") {
      const q = c
      out += c
      i++
      while (i < n && src[i] !== q && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < n) {
          out += src[i] + src[i + 1]
          i += 2
          continue
        }
        out += src[i]
        i++
      }
      if (i < n && src[i] === q) {
        out += q
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

const ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, '0': 0, '\\': 92, "'": 39, '"': 34, a: 7, b: 8, f: 12, v: 11, '?': 63 }

/** 이스케이프를 푼 문자 코드 목록 (문자열은 UTF-8 바이트가 아닌 JS 문자) */
function readEscaped(text: string, start: number, quote: string, line: number): { codes: number[]; end: number } {
  const codes: number[] = []
  let i = start
  while (i < text.length && text[i] !== quote) {
    if (text[i] === '\n') throw new CompileError('따옴표가 닫히지 않았습니다', line)
    if (text[i] === '\\') {
      const e = text[i + 1]
      if (e === 'x') {
        const m = /^[0-9a-fA-F]{1,2}/.exec(text.slice(i + 2))
        if (!m) throw new CompileError('잘못된 \\x 이스케이프', line)
        codes.push(parseInt(m[0], 16))
        i += 2 + m[0].length
        continue
      }
      if (/[0-7]/.test(e)) {
        const m = /^[0-7]{1,3}/.exec(text.slice(i + 1))!
        codes.push(parseInt(m[0], 8))
        i += 1 + m[0].length
        continue
      }
      if (e in ESCAPES) {
        codes.push(ESCAPES[e])
        i += 2
        continue
      }
      codes.push(e.charCodeAt(0))
      i += 2
      continue
    }
    codes.push(text.codePointAt(i)!)
    i += text.codePointAt(i)! > 0xffff ? 2 : 1
  }
  if (i >= text.length) throw new CompileError('따옴표가 닫히지 않았습니다', line)
  return { codes, end: i + 1 }
}

/** 한 줄(또는 지시문 본문)을 토큰으로 나눈다 */
export function tokenizeLine(text: string, line: number): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v') {
      i++
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++
      out.push({ k: 'id', v: text.slice(i, j), line })
      i = j
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const m = /^(0[xX][0-9a-fA-F']+|0[bB][01']+|(?:[0-9][0-9']*\.?[0-9']*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)([uUlLfF]*)/.exec(text.slice(i))
      if (!m) throw new CompileError(`숫자를 읽을 수 없습니다: ${text.slice(i, i + 8)}`, line)
      const body = m[1].replace(/'/g, '')
      const suffix = m[2].toLowerCase()
      const tok: Tok = { k: 'num', v: m[0], line }
      if (/^0x/i.test(body)) {
        tok.num = parseInt(body.slice(2), 16)
        tok.radix = true
      } else if (/^0b/i.test(body)) {
        tok.num = parseInt(body.slice(2), 2)
        tok.radix = true
      } else if (/[.eE]/.test(body) && !/^0x/i.test(body)) {
        tok.num = parseFloat(body)
        tok.float = true
      } else if (/^0[0-7]+$/.test(body)) {
        tok.num = parseInt(body, 8)
        tok.radix = true
      } else tok.num = parseInt(body, 10)
      if (suffix.includes('f')) {
        if (!tok.float && !/^0x/i.test(body)) tok.float = true
        tok.single = true
      }
      if (suffix.includes('u')) tok.unsigned = true
      tok.longs = (suffix.match(/l/g) ?? []).length
      out.push(tok)
      i += m[0].length
      continue
    }
    if (c === '"') {
      const { codes, end } = readEscaped(text, i + 1, '"', line)
      out.push({ k: 'str', v: String.fromCodePoint(...codes), line })
      i = end
      continue
    }
    if (c === "'") {
      const { codes, end } = readEscaped(text, i + 1, "'", line)
      if (!codes.length) throw new CompileError("빈 문자 상수 ''", line)
      // 'ab' 같은 여러 글자 상수는 마지막 글자 (gcc 경고와 같은 결과는 아님)
      out.push({ k: 'chr', v: text.slice(i, end), num: codes.length === 1 ? codes[0] : codes.reduce((a, b) => (a << 8) | b, 0), line })
      i = end
      continue
    }
    const op = OPS.find((o) => text.startsWith(o, i))
    if (!op) throw new CompileError(`알 수 없는 문자 '${c}'`, line)
    out.push({ k: 'op', v: op, line })
    i += op.length
  }
  return out
}

export interface Macro {
  params?: string[]
  variadic?: boolean
  body: Tok[]
}

export interface PreprocessResult {
  tokens: Tok[]
  includes: { name: string; line: number }[]
  macros: Map<string, Macro>
}

/** #if 식 계산 (defined(X), 정수, 비교, 논리 연산) */
function evalCondition(toks: Tok[], macros: Map<string, Macro>, line: number): boolean {
  // defined X / defined(X) 를 먼저 1/0 으로 바꾼다
  const pre: Tok[] = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.k === 'id' && t.v === 'defined') {
      let name: string | undefined
      if (toks[i + 1]?.v === '(') {
        name = toks[i + 2]?.v
        i += 3
      } else {
        name = toks[i + 1]?.v
        i += 1
      }
      pre.push({ k: 'num', v: '', num: name && macros.has(name) ? 1 : 0, line })
      continue
    }
    pre.push(t)
  }
  const expanded = expandMacros(pre, macros).map((t) => (t.k === 'id' ? { ...t, k: 'num' as const, num: t.v === 'true' ? 1 : 0 } : t))
  let p = 0
  const peek = () => expanded[p]?.v
  const prim = (): number => {
    const t = expanded[p++]
    if (!t) throw new CompileError('#if 식이 잘못되었습니다', line)
    if (t.v === '(') {
      const v = ternary()
      p++
      return v
    }
    if (t.v === '!') return prim() ? 0 : 1
    if (t.v === '-') return -prim()
    if (t.v === '~') return ~prim()
    if (t.k === 'num' || t.k === 'chr') return t.num ?? 0
    throw new CompileError(`#if 식을 계산할 수 없습니다: ${t.v}`, line)
  }
  const levels: string[][] = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']]
  const bin = (lv: number): number => {
    if (lv >= levels.length) return prim()
    let a = bin(lv + 1)
    while (levels[lv].includes(peek() ?? '')) {
      const op = expanded[p++].v
      const b = bin(lv + 1)
      a = op === '||' ? +(!!a || !!b) : op === '&&' ? +(!!a && !!b) : op === '|' ? a | b : op === '^' ? a ^ b : op === '&' ? a & b : op === '==' ? +(a === b) : op === '!=' ? +(a !== b) : op === '<' ? +(a < b) : op === '>' ? +(a > b) : op === '<=' ? +(a <= b) : op === '>=' ? +(a >= b) : op === '<<' ? a << b : op === '>>' ? a >> b : op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '/' ? Math.trunc(a / (b || 1)) : a % (b || 1)
    }
    return a
  }
  const ternary = (): number => {
    const c = bin(0)
    if (peek() === '?') {
      p++
      const a = ternary()
      p++
      const b = ternary()
      return c ? a : b
    }
    return c
  }
  return !!ternary()
}

/** 매크로 펼치기 (재귀 방지: 펼치는 중인 이름은 다시 펼치지 않는다) */
export function expandMacros(tokens: Tok[], macros: Map<string, Macro>, hide: Set<string> = new Set(), depth = 0): Tok[] {
  if (depth > 40) return tokens
  const out: Tok[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.k === 'id' && /^B[01]{1,8}$/.test(t.v) && !macros.has(t.v)) {
      // Arduino binary.h 의 B10101010 상수
      out.push({ k: 'num', v: t.v, num: parseInt(t.v.slice(1), 2), line: t.line })
      continue
    }
    const m = t.k === 'id' && !hide.has(t.v) ? macros.get(t.v) : undefined
    if (!m) {
      out.push(t)
      continue
    }
    if (!m.params) {
      const body = m.body.map((b) => ({ ...b, line: t.line }))
      out.push(...expandMacros(body, macros, new Set([...hide, t.v]), depth + 1))
      continue
    }
    if (tokens[i + 1]?.v !== '(') {
      out.push(t)
      continue
    }
    // 인자 모으기 (괄호 짝 맞추기)
    const args: Tok[][] = [[]]
    let level = 0
    let j = i + 2
    for (; j < tokens.length; j++) {
      const a = tokens[j]
      if (a.v === '(' || a.v === '[' || a.v === '{') level++
      else if (a.v === ')' || a.v === ']' || a.v === '}') {
        if (level === 0 && a.v === ')') break
        level--
      } else if (a.v === ',' && level === 0) {
        args.push([])
        continue
      }
      args[args.length - 1].push(a)
    }
    if (j >= tokens.length) throw new CompileError(`매크로 ${t.v}(…) 의 괄호가 닫히지 않았습니다`, t.line)
    if (args.length === 1 && args[0].length === 0 && m.params.length === 0) args.length = 0
    const expandedArgs = args.map((a) => expandMacros(a, macros, hide, depth + 1))
    const body: Tok[] = []
    for (let b = 0; b < m.body.length; b++) {
      const bt = m.body[b]
      if (bt.v === '#' && m.body[b + 1]?.k === 'id') {
        const idx = m.params.indexOf(m.body[b + 1].v)
        if (idx >= 0) {
          body.push({ k: 'str', v: (args[idx] ?? []).map((x) => (x.k === 'str' ? JSON.stringify(x.v) : x.v)).join(' '), line: t.line })
          b++
          continue
        }
      }
      if (bt.v === '##') continue
      const idx = bt.k === 'id' ? (bt.v === '__VA_ARGS__' ? m.params.length : m.params.indexOf(bt.v)) : -1
      if (idx >= 0) {
        if (bt.v === '__VA_ARGS__') {
          const rest = expandedArgs.slice(m.params.length)
          rest.forEach((r, k) => {
            if (k) body.push({ k: 'op', v: ',', line: t.line })
            body.push(...r)
          })
        } else body.push(...(expandedArgs[idx] ?? []).map((x) => ({ ...x, line: t.line })))
      } else body.push({ ...bt, line: t.line })
    }
    out.push(...expandMacros(body, macros, new Set([...hide, t.v]), depth + 1))
    i = j
  }
  return out
}

/** 아무 일도 하지 않는 헤더 (C 표준 라이브러리, AVR 헤더) */
export const NOOP_HEADERS = new Set([
  'Arduino.h', 'math.h', 'stdio.h', 'stdlib.h', 'string.h', 'stdint.h', 'stdbool.h', 'limits.h', 'ctype.h', 'float.h', 'inttypes.h',
  'avr/pgmspace.h', 'avr/interrupt.h', 'avr/io.h', 'util/delay.h', 'pgmspace.h', 'binary.h', 'cmath', 'cstdint', 'cstring', 'cstdio', 'cstdlib',
])

export function preprocess(src: string, predefined: Record<string, string>): PreprocessResult {
  const macros = new Map<string, Macro>()
  for (const [name, value] of Object.entries(predefined)) macros.set(name, { body: tokenizeLine(value, 0) })
  const includes: { name: string; line: number }[] = []
  const tokens: Tok[] = []
  const text = stripComments(src.replace(/\r\n?/g, '\n'))
  const lines = text.split('\n')
  /** 조건부 컴파일 상태: 지금 켜져 있는지, 이미 참인 갈래가 있었는지 */
  const stack: { active: boolean; taken: boolean; parentActive: boolean }[] = []
  const active = () => stack.every((s) => s.active)
  for (let n = 0; n < lines.length; n++) {
    let line = lines[n]
    const lineNo = n + 1
    // 줄 끝 \ 이어 붙이기
    while (line.endsWith('\\') && n + 1 < lines.length) {
      line = line.slice(0, -1) + ' ' + lines[++n]
    }
    const trimmed = line.trimStart()
    if (trimmed.startsWith('#')) {
      const m = /^#\s*([a-z_]+)\s*(.*)$/.exec(trimmed)
      if (!m) continue
      const [, directive, rest] = m
      const parentActive = active()
      switch (directive) {
        case 'if':
        case 'ifdef':
        case 'ifndef': {
          let cond = false
          if (parentActive) {
            if (directive === 'ifdef') cond = macros.has(rest.trim().split(/\s+/)[0])
            else if (directive === 'ifndef') cond = !macros.has(rest.trim().split(/\s+/)[0])
            else cond = evalCondition(tokenizeLine(rest, lineNo), macros, lineNo)
          }
          stack.push({ active: parentActive && cond, taken: cond, parentActive })
          continue
        }
        case 'elif': {
          const top = stack.at(-1)
          if (!top) throw new CompileError('#elif 앞에 #if 가 없습니다', lineNo)
          if (top.taken || !top.parentActive) top.active = false
          else {
            const cond = evalCondition(tokenizeLine(rest, lineNo), macros, lineNo)
            top.active = cond
            top.taken = cond
          }
          continue
        }
        case 'else': {
          const top = stack.at(-1)
          if (!top) throw new CompileError('#else 앞에 #if 가 없습니다', lineNo)
          top.active = top.parentActive && !top.taken
          top.taken = true
          continue
        }
        case 'endif':
          if (!stack.pop()) throw new CompileError('#endif 앞에 #if 가 없습니다', lineNo)
          continue
      }
      if (!parentActive) continue
      switch (directive) {
        case 'include': {
          const inc = /^[<"]([^>"]+)[>"]/.exec(rest.trim())
          if (!inc) throw new CompileError('#include 형식이 잘못되었습니다', lineNo)
          includes.push({ name: inc[1].trim(), line: lineNo })
          break
        }
        case 'define': {
          const d = /^([A-Za-z_][A-Za-z0-9_]*)(\(([^)]*)\))?\s*(.*)$/.exec(rest)
          if (!d) throw new CompileError('#define 형식이 잘못되었습니다', lineNo)
          const [, name, hasParams, params, body] = d
          const macro: Macro = { body: tokenizeLine(body, lineNo) }
          if (hasParams !== undefined) {
            const list = params.split(',').map((s) => s.trim()).filter(Boolean)
            macro.variadic = list.at(-1) === '...'
            macro.params = list.filter((p) => p !== '...')
          }
          macros.set(name, macro)
          break
        }
        case 'undef':
          macros.delete(rest.trim())
          break
        case 'error':
          throw new CompileError(`#error ${rest.trim()}`, lineNo)
        case 'pragma':
        case 'warning':
        case 'line':
          break
        default:
          throw new CompileError(`알 수 없는 전처리 지시문 #${directive}`, lineNo)
      }
      continue
    }
    if (!active()) continue
    tokens.push(...tokenizeLine(line, lineNo))
  }
  if (stack.length) throw new CompileError('#if 가 #endif 로 닫히지 않았습니다', lines.length)
  const expanded = expandMacros(tokens, macros)
  // 이어진 문자열 리터럴 합치기 ("ab" "cd")
  const merged: Tok[] = []
  for (const t of expanded) {
    const prev = merged.at(-1)
    if (t.k === 'str' && prev?.k === 'str') merged[merged.length - 1] = { ...prev, v: prev.v + t.v }
    else merged.push(t)
  }
  merged.push({ k: 'eof', v: '', line: lines.length })
  return { tokens: merged, includes, macros }
}
