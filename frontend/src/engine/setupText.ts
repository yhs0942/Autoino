import { getModule } from '../data/modules'
import type { Board, PlacedModule } from '../types'
import { boardKindOf } from './arduino/core'
import { SUPPORTED_LIBRARIES } from './arduino/libs'
import { boardDefOf, type Circuit } from './circuit'
import { endpointKey, isPinConnected, moduleEndpoint } from './connections'
import { isGroundPin, supplyPinOf } from './electrical'
import { motorDriverOf } from './motorAttach'
import { muxChannelOf, muxUsers } from './mux'
import { buildNetlist, type Netlist } from './netlist'
import { routeToBoard } from './paths'
import { netVoltage } from './power'
import { computeSeriesResistors, formatOhms } from './resistor'
import { computeLadderResistors, shareBoardPin, shareOf } from './shares'

// 지금 회로의 설정(보드·부품·핀 연결·전원·보드 간 통신)을 글로 정리한다.
// 사용자가 ChatGPT·Gemini·Claude 같은 생성형 AI 에 보내는 글에 그대로 붙여 넣을 수 있게, 설정만 적고 요청·지시는 넣지 않는다.

export interface SetupTextOptions {
  /** 이 보드에 연결된 부품만 (없으면 모든 보드) */
  board?: string
  /** Autoino 시뮬레이터에서 돌릴 조건(지원 라이브러리 등)을 덧붙인다 */
  simulator?: boolean
}

/** 코드에서 쓰는 핀 번호 (D7 → 7, A0 → A0, GPIO21 → 21) */
export function codePin(board: Board, pinId: string): string {
  if (boardKindOf(board.id) === 'esp32') return String(board.pins.find((p) => p.id === pinId)?.gpio ?? pinId.replace(/^GPIO/, ''))
  if (/^D\d+$/.test(pinId)) return pinId.slice(1)
  return pinId
}

interface Ctx {
  circuit: Circuit
  traced: Netlist
  netlist: Netlist
}

/** 같은 넷에 물린 다른 부품 핀 이름 (예: L298N 모터 드라이버 1 12V) */
function otherParts(ctx: Ctx, key: string): string[] {
  const members = ctx.netlist.members.get(ctx.netlist.netOf(key)) ?? []
  return members
    .filter((k) => k !== key && k.startsWith('module:'))
    .map((k) => {
      const [, id, pin] = k.split(':')
      const it = ctx.circuit.placed.find((p) => p.instanceId === id)
      const m = it && getModule(it.moduleId)
      return it && m ? `${it.label} ${m.pins.find((p) => p.id === pin)?.name ?? pin}` : k
    })
}

/** 부품 핀이 이어진 곳 (보드 핀 / GND / 전원 / 다른 부품). 연결되지 않았으면 null */
function describeEnd(ctx: Ctx, item: PlacedModule, pinId: string): { text: string; pin?: string } | null {
  const { circuit } = ctx
  if (!isPinConnected(circuit.connections, item.instanceId, pinId)) return null
  const route = routeToBoard(circuit, item.instanceId, pinId, ctx.traced)
  if (route) {
    const def = boardDefOf(circuit, route.boardInstanceId)!
    const label = circuit.boards.length > 1 ? `${circuit.boards.find((b) => b.instanceId === route.boardInstanceId)?.label} ` : ''
    if (isGroundPin(def, route.pinId)) return { text: `${label}GND` }
    const sp = supplyPinOf(def, route.pinId)
    if (sp) return { text: `${label}${route.pinId} (${sp.voltage} V 전원)` }
    const via = route.via.length ? `, ${route.via.join(', ')} 경유` : ''
    const code = codePin(def, route.pinId)
    const paren = [code !== route.pinId ? code : '', via.slice(2)].filter(Boolean).join(', ')
    return { text: `${label}${route.pinId}${paren ? ` (${paren})` : ''}`, pin: route.pinId }
  }
  const ch = muxChannelOf(circuit, endpointKey(moduleEndpoint(item.instanceId, pinId)))
  if (ch) {
    const mux = circuit.placed.find((p) => p.instanceId === ch.muxId)!
    return { text: `${mux.label} 채널 C${ch.channel}` }
  }
  const key = endpointKey(moduleEndpoint(item.instanceId, pinId))
  const others = otherParts(ctx, key)
  // 전원 부품의 출력: 무엇에 전원을 주는지
  if (getModule(item.moduleId).pins.find((p) => p.id === pinId)?.role === 'source') return { text: others.length ? others.join(', ') : '연결된 부품 없음' }
  const v = netVoltage(circuit, ctx.netlist, key)
  if (v !== null) {
    const members = ctx.netlist.members.get(ctx.netlist.netOf(key)) ?? []
    const source = members
      .map((k) => k.split(':'))
      .filter(([kind]) => kind === 'module')
      .map(([, id, pin]) => circuit.placed.find((p) => p.instanceId === id && getModule(p.moduleId).pins.find((x) => x.id === pin)?.role === 'source'))
      .find((p) => p && p !== item)
    return { text: source ? `${source.label} 출력 (${v} V)` : `${v} V 전원` }
  }
  const members = ctx.netlist.members.get(ctx.netlist.netOf(key)) ?? []
  if (members.some((k) => k.startsWith('board:') && /:GND/.test(k))) return { text: 'GND' }
  return { text: others.length ? others.join(', ') : '다른 부품' }
}

/** 부품의 성질 (I²C 주소, LOW 에서 켜짐, 모터가 물린 드라이버 등) */
function facts(ctx: Ctx, item: PlacedModule): string[] {
  const module = getModule(item.moduleId)
  const code = module.code
  const out: string[] = []
  if (module.i2cAddress) out.push(`I²C 주소 ${module.i2cAddress}`)
  if (code?.activeLow) out.push(`${module.pins.find((p) => p.id === code.pins?.value)?.name ?? '입력'} 이 LOW 일 때 켜짐`)
  if (code?.template === 'servo-continuous') out.push('연속 회전 서보 (각도 대신 회전 속도·방향)')
  if (code?.template === 'serial-module') out.push('기본 통신 속도 9600 baud')
  if (item.moduleId === 'stepper-28byj48') out.push('한 바퀴 2048 스텝')
  if (item.moduleId === 'stepper-nema17') out.push('한 바퀴 200 스텝 (1.8°)')
  if (module.motor) {
    const link = motorDriverOf(ctx.circuit, item)
    out.push(link ? `${link.driver.label} 의 ${link.channel.label} 채널에 연결` : '드라이버에 연결되지 않음')
  }
  if (module.mux) {
    const users = muxUsers(ctx.circuit, item.instanceId).map((u) => {
      const user = ctx.circuit.placed.find((x) => u.key.startsWith(`module:${x.instanceId}:`))
      return `C${u.channel} = ${user?.label ?? '다른 부품'}`
    })
    out.push(`쓰는 채널: ${users.join(', ') || '없음'}`)
  }
  return out
}

function boardLine(board: Board): string {
  return `${board.name} — ${board.microcontroller}, ${board.clockSpeed}, ${board.logicVoltage} V 로직`
}

/** 보드에 연결된 (또는 그 보드가 제어하는) 부품 */
function modulesOf(circuit: Circuit, traced: Netlist, boardId: string | undefined): PlacedModule[] {
  if (!boardId) return circuit.placed
  return circuit.placed.filter((item) => {
    const module = getModule(item.moduleId)
    const routes = module.pins.filter((p) => p.role === 'signal').map((p) => routeToBoard(circuit, item.instanceId, p.id, traced)?.boardInstanceId)
    if (routes.some((b) => b === boardId)) return true
    if (routes.some((b) => b)) return false
    const link = module.motor ? motorDriverOf(circuit, item) : null
    if (link) return modulesOf(circuit, traced, boardId).includes(link.driver)
    return item.hostBoardId === boardId
  })
}

/** 회로 설정을 글로 정리한다 (생성형 AI 에 보내는 글에 붙여 넣는 용도) */
export function buildSetupText(circuit: Circuit, options: SetupTextOptions = {}): string {
  const traced = buildNetlist(circuit, { passThrough: true })
  const netlist = buildNetlist(circuit)
  const ctx: Ctx = { circuit, traced, netlist }
  const multi = circuit.boards.length > 1
  const targets = options.board ? circuit.boards.filter((b) => b.instanceId === options.board) : circuit.boards
  const resistors = computeSeriesResistors(circuit)
  const ladder = computeLadderResistors(circuit)
  const out: string[] = ['아두이노 회로 설정', '(부품 핀 → 연결된 곳. 괄호 안 숫자는 코드에서 쓰는 핀 번호)', '']
  const libraries: string[] = []

  out.push('[보드]')
  for (const b of circuit.boards) out.push(`- ${multi ? `${b.label}: ` : ''}${boardLine(boardDefOf(circuit, b.instanceId)!)}`)
  out.push('')

  for (const b of targets) {
    const def = boardDefOf(circuit, b.instanceId)!
    const items = modulesOf(circuit, traced, multi ? b.instanceId : undefined)
    out.push(multi ? `[${b.label} 에 연결된 부품]` : '[부품과 연결]')
    if (!items.length) out.push('- (연결된 부품 없음)')
    items.forEach((item, i) => {
      const module = getModule(item.moduleId)
      const params = (module.parameters ?? [])
        .filter((pp) => pp.bom || pp.id === 'color' || pp.id === 'model' || pp.id === 'count')
        .map((pp) => pp.options.find((o) => o.value === item.params[pp.id])?.label)
        .filter((x): x is string => !!x)
      const name = item.label.startsWith(module.name) ? item.label : `${item.label} — ${module.name}`
      out.push(`${i + 1}. ${[name, ...params, ...facts(ctx, item)].join(' · ')}`)
      const linked = module.motor && motorDriverOf(circuit, item)
      let wired = 0
      for (const pin of module.pins) {
        // 모터 단자·드라이버 출력은 모터 줄의 '… 채널에 연결' 로 대신한다
        if ((linked && pin.role === 'load') || (module.driver && pin.role === 'drive')) continue
        const end = describeEnd(ctx, item, pin.id)
        if (!end) continue
        wired++
        const notes: string[] = []
        const res = resistors.find((r) => r.instanceId === item.instanceId && r.pinId === pin.id)
        if (res?.status === 'ok') notes.push(`직렬 저항 ${formatOhms(res.choice.standardOhms)}`)
        const rung = ladder.find((r) => r.instanceId === item.instanceId && r.pinId === pin.id)
        if (rung) notes.push(`저항 사다리 (${rung.ohms ? formatOhms(rung.ohms) : '저항 없이'}): 버튼 여러 개가 한 아날로그 핀을 함께 씀`)
        const share = shareOf(circuit, endpointKey(moduleEndpoint(item.instanceId, pin.id)))
        if (share && end.pin && shareBoardPin(circuit, share)?.pinId === end.pin && !rung) notes.push(`핀 공유: 부품 ${share.members.length}개가 이 핀을 함께 씀`)
        out.push(`   - ${pin.name} → ${end.text}${notes.length ? ` · ${notes.join(' · ')}` : ''}`)
      }
      if (!wired && !linked) out.push('   - (아직 연결되지 않음)')
      const lib = module.libraryByCore?.[def.core] ?? module.library
      if (lib) libraries.push(`${item.label} → ${lib}`)
    })
    out.push('')
  }

  // 보드 간 통신
  const links = circuit.links.filter((l) => targets.some((b) => b.instanceId === l.a.boardInstanceId || b.instanceId === l.b.boardInstanceId))
  if (multi && links.length) {
    out.push('[보드 간 통신]')
    for (const l of links) {
      const label = (id: string) => circuit.boards.find((b) => b.instanceId === id)?.label ?? id
      const pins = (end: typeof l.a) => {
        const def = boardDefOf(circuit, end.boardInstanceId)
        return Object.entries(end.pins).map(([role, pin]) => `${role} ${pin}${def && codePin(def, pin) !== pin ? ` (${codePin(def, pin)})` : ''}`).join(', ')
      }
      out.push(`- ${label(l.a.boardInstanceId)} ${l.a.bus}: ${pins(l.a)} ↔ ${label(l.b.boardInstanceId)} ${l.b.bus}: ${pins(l.b)} · ${l.protocol}${l.baud ? ` ${l.baud} baud` : ''}${l.i2cAddress ? ` · 주변장치 주소 ${l.i2cAddress}` : ''}`)
    }
    out.push('')
  }

  if (options.simulator) {
    const companion: Record<string, string> = { Adafruit_SSD1306: 'Adafruit_SSD1306(+Adafruit_GFX)', Adafruit_MPU6050: 'Adafruit_MPU6050(+Adafruit_Sensor)', MFRC522: 'MFRC522(+SPI)' }
    const supported = SUPPORTED_LIBRARIES()
      .filter((h) => !h.startsWith('avr/') && h !== 'DHT_U.h')
      .map((h) => h.replace(/\.h$/, ''))
      .map((h) => companion[h] ?? h)
    out.push('[Autoino 시뮬레이터에서 실행하려면]')
    out.push(`- 쓸 수 있는 라이브러리: ${supported.join(', ')}`)
    if (libraries.length) out.push(`- 부품별 라이브러리: ${libraries.join(', ')}`)
    out.push('- 지원하지 않는 것: Wi-Fi·인터넷·ESP32 내장 블루투스, 사용자 정의 class·템플릿·람다, new·malloc')
    if (targets.length > 1) out.push(`- 코드는 보드마다 따로 (코드 블록 첫 줄에 ${targets.map((b) => `// ${b.label}`).join(', ')} 처럼 보드 이름)`)
    out.push('')
  }
  return out.join('\n').trimEnd() + '\n'
}

// ------------------------------------------------------------ AI 답변에서 코드 꺼내기

export interface ExtractedSketch {
  board: string
  code: string
}

/** AI 답변(마크다운)에서 코드 블록을 꺼내 보드에 나눠 준다 */
export function extractSketches(text: string, boards: { instanceId: string; label: string }[], preferred?: string): ExtractedSketch[] {
  const blocks: { code: string; before: string }[] = []
  const re = /```[ \t]*([\w+#-]*)[^\n]*\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  let last = 0
  while ((m = re.exec(text))) {
    const lang = m[1].toLowerCase()
    const code = m[2]
    if (lang && !['cpp', 'c++', 'c', 'arduino', 'ino', 'cc', 'h'].includes(lang) && !/void\s+setup\s*\(/.test(code)) {
      last = re.lastIndex
      continue
    }
    blocks.push({ code: code.replace(/\s+$/, '\n'), before: text.slice(last, m.index) })
    last = re.lastIndex
  }
  if (!blocks.length) return /void\s+setup\s*\(/.test(text) ? [{ board: preferred ?? boards[0]?.instanceId ?? 'board-1', code: text.trim() + '\n' }] : []
  const sketches = blocks.filter((b) => /void\s+setup\s*\(/.test(b.code) || blocks.length === 1)
  const used = new Set<string>()
  const out: ExtractedSketch[] = []
  const findBoard = (s: string) => {
    // 길이가 긴 이름부터 (보드 10 이 보드 1 로 잡히지 않게)
    const sorted = [...boards].sort((a, b) => b.label.length - a.label.length)
    return sorted.find((b) => s.includes(b.label) || s.includes(b.instanceId))
  }
  for (const b of sketches) {
    const head = b.code.split('\n').slice(0, 3).join('\n')
    const tail = b.before.split('\n').slice(-3).join('\n')
    const hit = findBoard(head) ?? findBoard(tail)
    if (hit && !used.has(hit.instanceId)) {
      used.add(hit.instanceId)
      out.push({ board: hit.instanceId, code: b.code })
      continue
    }
    out.push({ board: '', code: b.code })
  }
  // 이름으로 못 찾은 블록: 고른 보드 → 남은 보드 순서대로
  const free = [preferred, ...boards.map((b) => b.instanceId)].filter((id): id is string => !!id && !used.has(id))
  for (const o of out) {
    if (o.board) continue
    const next = free.find((id) => !used.has(id))
    if (!next) continue
    o.board = next
    used.add(next)
  }
  return out.filter((o) => o.board)
}

/**
 * 편집기에 붙여 넣은 글이 AI 답변(``` 코드 블록)이면 설명을 빼고 코드만 꺼낸다.
 * 블록이 하나면 지금 보고 있는 보드에, 여러 개면 보드 이름 주석(// 보드 2)을 보고 나눈다.
 * 코드 블록이 없거나 코드가 아니면 null (보통처럼 붙여 넣는다).
 */
export function pastedSketches(text: string, boards: { instanceId: string; label: string }[], active: string): ExtractedSketch[] | null {
  if (!text.includes('```')) return null
  const found = extractSketches(text, boards, active)
  if (!found.length) return null
  return found.length === 1 ? [{ board: active, code: found[0].code }] : found
}
