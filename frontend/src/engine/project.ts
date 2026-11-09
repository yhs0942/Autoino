import { findBoard } from '../data/boards'
import { findModule } from '../data/modules'
import type { BoardLink, BoardLinkEnd, BusProtocol, Connection, Endpoint, PinShare, PlacedBoard, PlacedModule, Point } from '../types'
import { parseHoleId } from './breadboard'
import { parseEndpointKey } from './connections'

// 프로젝트 파일(.autoino.json) 직렬화와 불러오기 검증
//
// 버전 2: 여러 보드(boards), 보드 간 통신(links), 부품의 호스트 보드(hostBoardId),
//         보드 끝점의 boardInstanceId 를 저장한다.
// 버전 1 파일(board/boardId 하나)도 불러올 수 있다.

export const PROJECT_FORMAT = 'autoino-project'
export const PROJECT_VERSION = 2

export interface ProjectData {
  name: string
  boards: PlacedBoard[]
  placed: PlacedModule[]
  connections: Connection[]
  links: BoardLink[]
  /** 브레드보드 위치 (예전 파일에는 없다) */
  breadboard?: Point
  /** 사람이 브레드보드에서 옮긴 전선의 구멍: 끝점 키 → 구멍 ID (없으면 자동 배치) */
  breadboardHoles?: Record<string, string>
  /** 핀 공유 그룹 */
  shares?: PinShare[]
  /** 실물 배치 모드의 위치 (보드·부품 인스턴스 ID 또는 'breadboard' → 좌표) */
  layout?: Record<string, Point>
  nextSeq: number
  nextConnSeq: number
  nextBoardSeq: number
  nextLinkSeq: number
  labelCounters: Record<string, number>
}

export interface ProjectFile extends Omit<ProjectData, 'placed'> {
  format: typeof PROJECT_FORMAT
  version: number
  savedAt: string
  /** 첫 번째 보드의 정의 ID (버전 1 과의 호환용) */
  boardId: string
  modules: PlacedModule[]
}

export function toProjectFile(data: ProjectData, now = new Date()): ProjectFile {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: now.toISOString(),
    name: data.name,
    boardId: data.boards[0]?.boardId ?? '',
    boards: data.boards,
    modules: data.placed,
    connections: data.connections,
    links: data.links,
    ...(data.breadboard ? { breadboard: data.breadboard } : {}),
    ...(data.breadboardHoles && Object.keys(data.breadboardHoles).length ? { breadboardHoles: data.breadboardHoles } : {}),
    ...(data.shares?.length ? { shares: data.shares } : {}),
    ...(data.layout && Object.keys(data.layout).length ? { layout: data.layout } : {}),
    nextSeq: data.nextSeq,
    nextConnSeq: data.nextConnSeq,
    nextBoardSeq: data.nextBoardSeq,
    nextLinkSeq: data.nextLinkSeq,
    labelCounters: data.labelCounters,
  }
}

export class ProjectFileError extends Error {}

function fail(message: string): never {
  throw new ProjectFileError(message)
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const PROTOCOLS: BusProtocol[] = ['UART', 'I2C', 'SPI']

function seqOf(id: string, prefix: RegExp): number {
  const m = id.match(prefix)
  return m ? Number(m[1]) : 0
}

function parseBoards(raw: Record<string, unknown>): PlacedBoard[] {
  if (Array.isArray(raw.boards)) {
    if (raw.boards.length === 0) fail('보드가 하나 이상 필요합니다.')
    const boards = raw.boards.map((b, i): PlacedBoard => {
      if (!isObj(b) || !isStr(b.instanceId) || !isStr(b.boardId)) fail(`보드 #${i + 1} 의 형식이 잘못되었습니다.`)
      if (!findBoard(b.boardId)) fail(`알 수 없는 보드입니다: ${b.boardId}`)
      return {
        instanceId: b.instanceId,
        boardId: b.boardId,
        label: isStr(b.label) && b.label ? b.label : `보드 ${i + 1}`,
        x: isNum(b.x) ? b.x : 40,
        y: isNum(b.y) ? b.y : 40,
      }
    })
    if (new Set(boards.map((b) => b.instanceId)).size !== boards.length) fail('보드 인스턴스 ID 가 중복되었습니다.')
    return boards
  }
  // 버전 1: board(선택) + boardId
  if (!isStr(raw.boardId) || !findBoard(raw.boardId)) fail(`알 수 없는 보드입니다: ${String(raw.boardId)}`)
  const rb = isObj(raw.board) ? raw.board : {}
  return [
    {
      instanceId: isStr(rb.instanceId) && rb.instanceId ? rb.instanceId : 'board-1',
      boardId: raw.boardId,
      label: '보드 1',
      x: isNum(rb.x) ? rb.x : 40,
      y: isNum(rb.y) ? rb.y : 40,
    },
  ]
}

/** 프로젝트 파일을 검증하고 앱 상태로 변환한다. 문제가 있으면 ProjectFileError 를 던진다. */
export function parseProjectFile(input: unknown): ProjectData {
  let raw = input
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input)
    } catch {
      fail('JSON 형식이 아닙니다.')
    }
  }
  if (!isObj(raw) || raw.format !== PROJECT_FORMAT) fail('Autoino 프로젝트 파일이 아닙니다.')
  if (!isNum(raw.version) || raw.version > PROJECT_VERSION)
    fail(`지원하지 않는 파일 버전입니다 (${String(raw.version)}). 프로그램을 업데이트하세요.`)
  const boards = parseBoards(raw)
  const boardIds = new Set(boards.map((b) => b.instanceId))
  const primary = boards[0].instanceId
  if (!Array.isArray(raw.modules) || !Array.isArray(raw.connections)) fail('부품 또는 연결 목록이 없습니다.')

  const placed: PlacedModule[] = raw.modules.map((m, i) => {
    if (!isObj(m) || !isStr(m.instanceId) || !isStr(m.moduleId) || !isStr(m.label) || !isNum(m.x) || !isNum(m.y))
      fail(`부품 #${i + 1} 의 형식이 잘못되었습니다.`)
    const module = findModule(m.moduleId)
    if (!module) fail(`알 수 없는 부품입니다: ${m.moduleId}`)
    // 알 수 없는 파라미터 값은 기본값으로 되돌린다.
    const params: Record<string, string> = {}
    const savedParams = isObj(m.params) ? m.params : {}
    for (const param of module.parameters ?? []) {
      const v = savedParams[param.id]
      params[param.id] = isStr(v) && param.options.some((o) => o.value === v) ? v : param.defaultValue
    }
    const hostBoardId = isStr(m.hostBoardId) && boardIds.has(m.hostBoardId) ? m.hostBoardId : primary
    return { instanceId: m.instanceId, moduleId: m.moduleId, label: m.label, x: m.x, y: m.y, params, hostBoardId }
  })
  const instanceIds = new Set(placed.map((p) => p.instanceId))
  if (instanceIds.size !== placed.length) fail('부품 인스턴스 ID 가 중복되었습니다.')

  const parseEndpoint = (e: unknown, where: string): Endpoint => {
    if (isObj(e) && e.kind === 'board' && isStr(e.pinId)) {
      // 버전 1 의 보드 끝점에는 보드 인스턴스가 없으므로 첫 번째 보드로 본다
      const boardInstanceId = isStr(e.boardInstanceId) ? e.boardInstanceId : primary
      if (!boardIds.has(boardInstanceId)) fail(`${where}: 존재하지 않는 보드(${boardInstanceId})에 연결되어 있습니다.`)
      return { kind: 'board', boardInstanceId, pinId: e.pinId }
    }
    if (isObj(e) && e.kind === 'module' && isStr(e.instanceId) && isStr(e.pinId)) {
      if (!instanceIds.has(e.instanceId)) fail(`${where}: 존재하지 않는 부품(${e.instanceId})에 연결되어 있습니다.`)
      return { kind: 'module', instanceId: e.instanceId, pinId: e.pinId }
    }
    fail(`${where}: 연결 끝점 형식이 잘못되었습니다.`)
  }

  const linksRaw = Array.isArray(raw.links) ? raw.links : []
  const parseEnd = (e: unknown, where: string): BoardLinkEnd => {
    if (!isObj(e) || !isStr(e.boardInstanceId) || !boardIds.has(e.boardInstanceId) || !isStr(e.bus) || !isObj(e.pins))
      fail(`${where} 의 형식이 잘못되었습니다.`)
    const pins: Record<string, string> = {}
    for (const [role, pin] of Object.entries(e.pins)) if (isStr(pin)) pins[role] = pin
    return { boardInstanceId: e.boardInstanceId, bus: e.bus, pins }
  }
  const links: BoardLink[] = linksRaw.map((l, i) => {
    const where = `통신 연결 #${i + 1}`
    if (!isObj(l) || !isStr(l.id) || !PROTOCOLS.includes(l.protocol as BusProtocol) || !Array.isArray(l.pairs))
      fail(`${where} 의 형식이 잘못되었습니다.`)
    const pairs = l.pairs.map((p) => {
      if (!isObj(p) || !isStr(p.a) || !isStr(p.b) || !isStr(p.signal)) fail(`${where} 의 핀 쌍 형식이 잘못되었습니다.`)
      return { a: p.a, b: p.b, signal: p.signal }
    })
    return {
      id: l.id,
      protocol: l.protocol as BusProtocol,
      a: parseEnd(l.a, where),
      b: parseEnd(l.b, where),
      pairs,
      ...(isStr(l.i2cAddress) ? { i2cAddress: l.i2cAddress } : {}),
      ...(isNum(l.baud) ? { baud: l.baud } : {}),
    }
  })
  const linkIds = new Set(links.map((l) => l.id))

  const connections: Connection[] = raw.connections.map((c, i) => {
    if (!isObj(c) || !isStr(c.id)) fail(`연결 #${i + 1} 의 형식이 잘못되었습니다.`)
    return {
      id: c.id,
      from: parseEndpoint(c.from, `연결 #${i + 1}`),
      to: parseEndpoint(c.to, `연결 #${i + 1}`),
      auto: c.auto === true,
      ...(isStr(c.linkId) && linkIds.has(c.linkId) ? { linkId: c.linkId } : {}),
      ...(c.via === 'breadboard' ? { via: 'breadboard' as const } : {}),
    }
  })

  // 카운터가 없거나 잘못되어도 ID 가 겹치지 않도록 다시 계산한다.
  const maxSeq = Math.max(0, ...placed.map((p) => seqOf(p.instanceId, /#(\d+)$/)))
  const maxConn = Math.max(0, ...connections.map((c) => seqOf(c.id, /^w(\d+)$/)))
  const maxBoard = Math.max(0, ...boards.map((b) => seqOf(b.instanceId, /^board-(\d+)$/)))
  const maxLink = Math.max(0, ...links.map((l) => seqOf(l.id, /^link-(\d+)$/)))
  const labelCounters: Record<string, number> = {}
  for (const p of placed) {
    const n = Number(p.label.match(/(\d+)$/)?.[1] ?? 0)
    labelCounters[p.moduleId] = Math.max(labelCounters[p.moduleId] ?? 0, n)
  }
  if (isObj(raw.labelCounters))
    for (const [k, v] of Object.entries(raw.labelCounters)) if (isNum(v)) labelCounters[k] = Math.max(labelCounters[k] ?? 0, v)
  const counter = (v: unknown, min: number) => Math.max(isNum(v) ? v : 1, min)

  // 핀 공유 그룹: 있는 부품 핀만 남기고, 멤버가 둘 미만이면 버린다
  const shares: PinShare[] = []
  if (Array.isArray(raw.shares))
    for (const sh of raw.shares) {
      if (!isObj(sh) || !isStr(sh.id) || !Array.isArray(sh.members)) continue
      const members = [...new Set(sh.members.filter((k): k is string => isStr(k) && parseEndpointKey(k)?.kind === 'module' && instanceIds.has((parseEndpointKey(k) as { instanceId: string }).instanceId)))]
      if (members.length >= 2 && !shares.some((x) => x.id === sh.id)) shares.push({ id: sh.id, members })
    }

  // 실물 배치 위치: 있는 보드·부품·브레드보드만
  const layout: Record<string, Point> = {}
  if (isObj(raw.layout))
    for (const [id, pos] of Object.entries(raw.layout))
      if ((boardIds.has(id) || instanceIds.has(id) || id === 'breadboard') && isObj(pos) && isNum(pos.x) && isNum(pos.y)) layout[id] = { x: pos.x, y: pos.y }

  // 브레드보드 구멍: 있는 끝점과 올바른 구멍 ID 만 남긴다
  const breadboardHoles: Record<string, string> = {}
  if (isObj(raw.breadboardHoles))
    for (const [key, hole] of Object.entries(raw.breadboardHoles)) {
      const e = parseEndpointKey(key)
      const exists = e && (e.kind === 'board' ? boardIds.has(e.boardInstanceId) : instanceIds.has(e.instanceId))
      if (exists && isStr(hole) && parseHoleId(hole)) breadboardHoles[key] = hole
    }

  return {
    name: isStr(raw.name) && raw.name.trim() ? raw.name : '제목 없는 프로젝트',
    boards,
    placed,
    connections,
    links,
    ...(isObj(raw.breadboard) && isNum(raw.breadboard.x) && isNum(raw.breadboard.y) ? { breadboard: { x: raw.breadboard.x, y: raw.breadboard.y } } : {}),
    ...(Object.keys(breadboardHoles).length ? { breadboardHoles } : {}),
    ...(shares.length ? { shares } : {}),
    ...(Object.keys(layout).length ? { layout } : {}),
    nextSeq: counter(raw.nextSeq, maxSeq + 1),
    nextConnSeq: counter(raw.nextConnSeq, maxConn + 1),
    nextBoardSeq: counter(raw.nextBoardSeq, maxBoard + 1),
    nextLinkSeq: counter(raw.nextLinkSeq, maxLink + 1),
    labelCounters,
  }
}
