import { DEFAULT_BOARD_ID, findBoard, getBoard } from '../data/boards'
import { getModule } from '../data/modules'
import { findSupply } from '../data/supplies'
import { arrangeModules } from '../engine/arrange'
import { autoAssign } from '../engine/autoAssign'
import { planBoardLink, type LinkRequest } from '../engine/boardLinks'
import { BB_COLUMNS, checkLeadMove, holeId, holeLabel, holeNode, nodeLabel, routeBreadboard, type Hole, type MainRow } from '../engine/breadboard'
import { resolveBoardPin, type Circuit } from '../engine/circuit'
import {
  asModuleBoardLink,
  boardHasPin,
  describeEndpoint,
  endpointKey,
  moduleEndpoint,
  parseEndpointKey,
  resolveModulePin,
  sameEndpoint,
  touches,
  touchesBoard,
  touchesInstance,
} from '../engine/connections'
import { boardToBoardError, linkError } from '../engine/electrical'
import { insertLevelShifters } from '../engine/levelShift'
import { buildNetlist } from '../engine/netlist'
import { motorPins, planMotorAttach, recommendDriver } from '../engine/motorAttach'
import { analyzePower, formatCurrent, primaryGrounds, supplyScope } from '../engine/power'
import type { ProjectData } from '../engine/project'
import { roleOfKey, shareBoardPin, shareOf, shareRefusal } from '../engine/shares'
import { hasSupplyKind, paramsForSupply, SUPPLY_PARAM, syncSupplyKind } from '../engine/supplyInfo'
import type { Connection, Endpoint, PinShare, PlacedBoard, PlacedModule, Point, RouteMode, Selection } from '../types'
import {
  BOARD_POSITION,
  BREADBOARD_POSITION,
  BREADBOARD_SIZE,
  breadboardRect,
  clampToCanvas,
  MODULE_SIZE,
  findBoardPosition,
  findBreadboardPosition,
  findFreePosition,
  type Rect,
} from '../utils/placement'

// 작업 공간 상태와 리듀서.
// UI 와 분리된 순수 함수로 작성하여 테스트하기 쉽고, 백엔드 동기화나
// 저장/불러오기 기능을 붙이기 쉽게 한다.

export const DEFAULT_PROJECT_NAME = '제목 없는 프로젝트'
const HISTORY_LIMIT = 100

/** 저장·실행 취소의 대상이 되는 문서 부분 */
export interface CircuitDocument {
  projectName: string
  /** 작업 공간에 배치된 메인 보드 인스턴스 (정의는 data/boards.json). 항상 1개 이상 */
  boards: PlacedBoard[]
  placed: PlacedModule[]
  connections: Connection[]
  links: Circuit['links']
  /** 배선도 위 브레드보드 위치 */
  breadboard: Point
  /** 사람이 브레드보드에서 옮긴 전선의 구멍 (끝점 키 → 구멍 ID). 비어 있으면 모두 자동 배치 */
  breadboardHoles: Record<string, string>
  /** 핀 공유 그룹 */
  shares: PinShare[]
  /** 실물 배치 모드의 위치 (보드·부품 인스턴스 ID 또는 'breadboard' → 좌표). 없으면 배선도 위치를 쓴다 */
  layout: Record<string, Point>
  /** 인스턴스 ID 생성용 증가 카운터 */
  nextSeq: number
  /** 연결 ID 생성용 증가 카운터 */
  nextConnSeq: number
  nextBoardSeq: number
  nextLinkSeq: number
  /** 모듈 종류별 표시 번호 카운터 (예: LED 1, LED 2 …) */
  labelCounters: Record<string, number>
}

export interface CircuitState extends CircuitDocument {
  selection: Selection
  /** 하단 상태 표시줄 메시지 */
  statusMessage: string
  /** 실행 취소 / 다시 실행 기록 */
  past: CircuitDocument[]
  future: CircuitDocument[]
}

export type CircuitAction =
  | { type: 'setBoard'; boardInstanceId: string; boardId: string }
  | { type: 'addBoard'; boardId: string }
  | { type: 'removeBoard'; boardInstanceId: string }
  | { type: 'moveBoard'; boardInstanceId: string; position: Point }
  /**
   * 부품을 놓는다. autoConnect 이면 외부 전원은 전원이 필요한 부품(near 카드가 있으면 그 부품)에
   * 맞춰 전압·전류를 정하고 바로 연결한다.
   */
  | { type: 'addModule'; moduleId: string; position?: Point; hostBoardId?: string; autoConnect?: boolean; near?: string; route?: RouteMode }
  | { type: 'moveModule'; instanceId: string; position: Point }
  | { type: 'setHostBoard'; instanceId: string; boardInstanceId: string }
  | { type: 'select'; selection: Selection }
  | { type: 'removeModule'; instanceId: string }
  | { type: 'setParam'; instanceId: string; paramId: string; value: string }
  /** 부품 신호 핀을 다른 부품 신호 핀에 놓으면 핀 공유 그룹을 만든다 */
  | { type: 'connect'; from: Endpoint; to: Endpoint; via?: 'breadboard' }
  /** 핀 공유 그룹에서 이 부품 핀을 빼고 공유 핀 전선을 뗀다 */
  | { type: 'unsharePin'; key: string }
  /** 끌어 놓은 핀에 맞는 상대 핀을 자동으로 골라 연결한다 (브레드보드에 놓았을 때) */
  | { type: 'connectAuto'; endpoint: Endpoint; route: RouteMode }
  | { type: 'setConnectionRoute'; connectionId: string; via: RouteMode }
  | { type: 'removeConnection'; connectionId: string }
  | { type: 'clearConnections' }
  | { type: 'autoAssign'; route?: RouteMode }
  /** 전원 예시를 외부 전원 부품으로 놓고 지정한 전원 핀에 연결한다 */
  | { type: 'applySupply'; supplyId: string; pins: string[]; route: RouteMode }
  | { type: 'moveBreadboard'; position: Point }
  /** 실물 배치 모드에서 보드·부품·브레드보드('breadboard')를 옮긴다 */
  | { type: 'moveLayout'; id: string; position: Point }
  /** 전압이 같은 외부 전원(otherIds)을 keepId 하나로 합친다 */
  | { type: 'mergeSupplies'; keepId: string; otherIds: string[] }
  /** 브레드보드에 꽂힌 전선 끝(끝점 키)을 다른 구멍으로 옮긴다 */
  | { type: 'moveLead'; key: string; hole: Hole }
  | { type: 'resetBreadboardLayout' }
  /** 부품 핀에서 끈 전선을 브레드보드 구멍에 놓았을 때: 그 줄의 전선과 잇고 그 구멍에 꽂는다 */
  | { type: 'connectToHole'; endpoint: Endpoint; hole: Hole; route: RouteMode }
  /** 한 부품의 전선만 모두 지운다 */
  | { type: 'resetModuleWiring'; instanceId: string }
  /** 한 부품의 핀만 자동 배정한다 */
  | { type: 'autoAssignModule'; instanceId: string; route: RouteMode }
  /** 전선의 한쪽 끝(from)을 다른 핀(to)으로 옮긴다. 보드 핀 하나를 여러 전선이 나눠 쓰면 함께 옮긴다 */
  | { type: 'retargetWire'; connectionIds: string[]; from: Endpoint; to: Endpoint }
  /** 모터 카드를 드라이버 카드에 놓았을 때: 빈 채널에 모터를 잇고 그 채널의 제어 핀을 배정한다 */
  | { type: 'attachMotor'; motorId: string; driverId: string; route: RouteMode }
  /** 모터에 맞는 드라이버를 새로 놓고 연결한다 */
  | { type: 'addDriverFor'; motorId: string; route: RouteMode }
  | { type: 'addBoardLink'; request: LinkRequest }
  | { type: 'removeBoardLink'; linkId: string }
  | { type: 'insertLevelShifters' }
  | { type: 'arrangeModules' }
  | { type: 'setProjectName'; name: string }
  | { type: 'loadProject'; data: ProjectData; message?: string }
  | { type: 'reset' }
  | { type: 'setStatus'; message: string }
  /** 드래그 시작 시 현재 문서를 기록한다 (이동 중의 moveModule/moveBoard 는 기록하지 않음) */
  | { type: 'checkpoint' }
  | { type: 'undo' }
  | { type: 'redo' }

/** 기록하지 않는 동작 */
const NOT_RECORDED = new Set<CircuitAction['type']>([
  'select', 'setStatus', 'moveModule', 'moveBoard', 'moveBreadboard', 'moveLayout', 'setProjectName', 'loadProject', 'checkpoint', 'undo', 'redo',
])

export function createBoardInstance(boardId: string = DEFAULT_BOARD_ID, seq = 1, position: Point = BOARD_POSITION): PlacedBoard {
  return { instanceId: `board-${seq}`, boardId, label: `보드 ${seq}`, x: position.x, y: position.y }
}

export function createInitialState(board: string | PlacedBoard = DEFAULT_BOARD_ID): CircuitState {
  const first = typeof board === 'string' ? createBoardInstance(board) : board
  return {
    projectName: DEFAULT_PROJECT_NAME,
    boards: [first],
    placed: [],
    connections: [],
    links: [],
    breadboard: { ...BREADBOARD_POSITION },
    breadboardHoles: {},
    shares: [],
    layout: {},
    selection: { kind: 'none' },
    nextSeq: 1,
    nextConnSeq: 1,
    nextBoardSeq: (Number(first.instanceId.match(/(\d+)$/)?.[1]) || 1) + 1,
    nextLinkSeq: 1,
    labelCounters: {},
    statusMessage: '준비됨 — 왼쪽 라이브러리에서 부품을 추가하세요.',
    past: [],
    future: [],
  }
}

export function documentOf(state: CircuitDocument): CircuitDocument {
  const { projectName, boards, placed, connections, links, breadboard, breadboardHoles, shares, layout, nextSeq, nextConnSeq, nextBoardSeq, nextLinkSeq, labelCounters } = state
  return { projectName, boards, placed, connections, links, breadboard, breadboardHoles, shares, layout, nextSeq, nextConnSeq, nextBoardSeq, nextLinkSeq, labelCounters }
}

function sameDocument(a: CircuitDocument, b: CircuitDocument): boolean {
  return (Object.keys(documentOf(a)) as (keyof CircuitDocument)[]).every((k) => a[k] === b[k])
}

export function toProjectData(state: CircuitDocument): ProjectData {
  const d = documentOf(state)
  return {
    name: d.projectName,
    boards: d.boards,
    placed: d.placed,
    connections: d.connections,
    links: d.links,
    breadboard: d.breadboard,
    ...(Object.keys(d.breadboardHoles).length ? { breadboardHoles: d.breadboardHoles } : {}),
    ...(d.shares.length ? { shares: d.shares } : {}),
    ...(Object.keys(d.layout).length ? { layout: d.layout } : {}),
    nextSeq: d.nextSeq,
    nextConnSeq: d.nextConnSeq,
    nextBoardSeq: d.nextBoardSeq,
    nextLinkSeq: d.nextLinkSeq,
    labelCounters: d.labelCounters,
  }
}

export function circuitOf(state: CircuitDocument): Circuit {
  return { boards: state.boards, placed: state.placed, connections: state.connections, links: state.links, breadboard: state.breadboard, breadboardHoles: state.breadboardHoles, shares: state.shares }
}

/** 툴바·보드 선택기가 다루는 보드: 선택된 보드가 있으면 그 보드, 없으면 첫 번째 보드 */
export function activeBoardOf(state: CircuitState): PlacedBoard {
  const { selection } = state
  if (selection.kind === 'board') {
    const b = state.boards.find((x) => x.instanceId === selection.boardInstanceId)
    if (b) return b
  }
  if (selection.kind === 'module') {
    const m = state.placed.find((p) => p.instanceId === selection.instanceId)
    const b = m && state.boards.find((x) => x.instanceId === m.hostBoardId)
    if (b) return b
  }
  return state.boards[0]
}

function boardRects(state: CircuitDocument): Rect[] {
  return state.boards.map((b) => {
    const def = findBoard(b.boardId)
    return { x: b.x, y: b.y, width: def?.footprint.width ?? 0, height: def?.footprint.height ?? 0 }
  })
}

/** 새 부품·보드 자리를 찾을 때 피할 영역: 보드와 브레드보드 */
function obstacleRects(state: CircuitDocument): Rect[] {
  return [...boardRects(state), breadboardRect(state.breadboard)]
}

function selectionExists(state: CircuitDocument, selection: Selection): boolean {
  if (selection.kind === 'module') return state.placed.some((p) => p.instanceId === selection.instanceId)
  if (selection.kind === 'connection') return state.connections.some((c) => c.id === selection.connectionId)
  if (selection.kind === 'board') return state.boards.some((b) => b.instanceId === selection.boardInstanceId)
  return true
}

function keepSelection(next: CircuitState, previous: Selection): CircuitState {
  return { ...next, selection: selectionExists(next, previous) ? previous : { kind: 'none' } }
}

/** 두 끝점을 잇는다. id 를 주면 그 ID 로 만든다 (전선 끝을 옮길 때) */
function connect(state: CircuitState, from: Endpoint, to: Endpoint, via?: 'breadboard', id?: string): CircuitState {
  const reject = (message: string) => ({ ...state, statusMessage: message })
  const circuit = circuitOf(state)
  if (from.kind === 'board' && to.kind === 'board' && from.boardInstanceId === to.boardInstanceId)
    return reject('같은 보드의 핀끼리는 연결할 수 없습니다. 부품 핀이나 다른 보드의 핀과 연결하세요.')
  if (sameEndpoint(from, to)) return state
  if (from.kind === 'module' && to.kind === 'module' && from.instanceId === to.instanceId)
    return reject('같은 부품의 핀끼리는 연결할 수 없습니다.')
  if ([from, to].some((e) => e.kind === 'module' && !resolveModulePin(state.placed, e))) return state

  // 모듈을 항상 from 쪽에 둔다.
  const [a, b] = from.kind === 'module' ? [from, to] : [to, from]
  const exists = state.connections.some(
    (c) => (sameEndpoint(c.from, a) && sameEndpoint(c.to, b)) || (sameEndpoint(c.from, b) && sameEndpoint(c.to, a)),
  )
  if (exists) return state

  // 모듈 핀 하나에는 전선 하나만 둔다: 기존 연결을 대체한다. 단, 단자대처럼 여러 가닥을 받는 핀은 그대로 둔다.
  const single = (e: Endpoint) => e.kind === 'module' && !resolveModulePin(state.placed, e)?.pin.fanout
  const replaced = state.connections.filter((c) => [a, b].some((e) => single(e) && touches(c, e)))
  const connection: Connection = { id: id ?? `w${state.nextConnSeq}`, from: a, to: b, auto: false, ...(via ? { via } : {}) }
  const connections = [...state.connections.filter((c) => !replaced.includes(c)), connection]

  let message = `${describeEndpoint(a, circuit)} → ${describeEndpoint(b, circuit)} 연결했습니다.`
  if (b.kind === 'board') {
    const target = resolveBoardPin(circuit, b.boardInstanceId, b.pinId)
    const error =
      a.kind === 'module'
        ? target && linkError(target.board, resolveModulePin(state.placed, a)!.module, resolveModulePin(state.placed, a)!.pin, target.pin, resolveModulePin(state.placed, a)!.placed)
        : (() => {
            const src = resolveBoardPin(circuit, a.boardInstanceId, a.pinId)
            return src && target ? boardToBoardError(src.board, src.pin, target.board, target.pin) : null
          })()
    if (error) message += ` ⚠ ${error}`
  }
  if (replaced.length) message += ` (기존 연결 ${replaced.length}개 대체)`
  return {
    ...state,
    connections,
    nextConnSeq: id ? state.nextConnSeq : state.nextConnSeq + 1,
    selection: { kind: 'connection', connectionId: connection.id },
    statusMessage: message,
  }
}

/** 부품 핀에서 끈 전선을 브레드보드 구멍에 놓는다: 그 줄에 꽂힌 전선의 핀과 잇고, 빈 줄이면 맞는 보드 핀을 고른다 */
function connectToHole(state: CircuitState, endpoint: Endpoint, hole: Hole): CircuitState {
  const reject = (message: string) => ({ ...state, statusMessage: message })
  const circuit = circuitOf(state)
  const routing = routeBreadboard(circuit)
  const key = endpointKey(endpoint)
  const node = holeNode(hole)
  const here = routing.leads.filter((l) => holeNode(l.hole) === node && l.key !== key && !l.resistor)
  let next: CircuitState
  if (here.length) {
    // 그 줄의 전선과 잇는다 (보드 핀이 있으면 보드 핀과)
    const anchor = here.find((l) => l.key.startsWith('board:')) ?? here[0]
    const to = parseEndpointKey(anchor.key)!
    const r = resolveModulePin(state.placed, endpoint)
    if (r && to.kind === 'board') {
      const target = resolveBoardPin(circuit, to.boardInstanceId, to.pinId)
      const error = target && linkError(target.board, r.module, r.pin, target.pin, r.placed)
      if (error) return reject(`${nodeLabel(hole)} 줄은 ${anchor.net} 줄이라 ${r.placed.label} · ${r.pin.name} 을(를) 꽂을 수 없습니다. ${error}`)
    }
    next = connect(state, endpoint, to, 'breadboard')
  } else {
    if (endpoint.kind !== 'module') return reject('보드 핀은 부품 핀이나 전선이 꽂힌 줄에 놓으세요.')
    next = reduce(state, { type: 'connectAuto', endpoint, route: 'breadboard' })
  }
  if (next.connections === state.connections) return next
  const connected = next.statusMessage
  // 놓은 구멍이 차 있으면 같은 줄의 빈 구멍에 꽂는다
  const after = routeBreadboard(circuitOf(next))
  const taken = new Set([...after.leads.filter((l) => l.key !== key).map((l) => holeId(l.hole)), ...after.resistors.flatMap((x) => x.legs.map(holeId))])
  let spot: Hole | undefined = taken.has(holeId(hole)) ? undefined : hole
  if (!spot && hole.kind === 'main') {
    const rows: MainRow[] = ['a', 'b', 'c', 'd', 'e'].includes(hole.row) ? ['a', 'b', 'c', 'd', 'e'] : ['f', 'g', 'h', 'i', 'j']
    spot = rows.map((row): Hole => ({ kind: 'main', col: hole.col, row })).find((h) => !taken.has(holeId(h)))
  } else if (!spot && hole.kind === 'rail') {
    const cols = Array.from({ length: BB_COLUMNS }, (_, i) => i + 1).sort((a, b) => Math.abs(a - hole.col) - Math.abs(b - hole.col))
    spot = cols.map((col): Hole => ({ kind: 'rail', rail: hole.rail, col })).find((h) => !taken.has(holeId(h)))
  }
  if (!spot) return { ...next, statusMessage: `${connected} 그 줄에 빈 구멍이 없어 자동으로 꽂았습니다.` }
  const placed = reduce(next, { type: 'moveLead', key, hole: spot })
  if (placed.breadboardHoles === next.breadboardHoles && leadAt(next, key) !== holeId(spot))
    return { ...next, statusMessage: `${connected} ${holeLabel(spot)}에는 꽂을 수 없어 자동으로 꽂았습니다 (${placed.statusMessage})` }
  return { ...placed, statusMessage: `${connected} 전선을 ${holeLabel(spot)}에 꽂았습니다.` }
}

function leadAt(state: CircuitState, key: string): string | null {
  const lead = routeBreadboard(circuitOf(state)).leads.find((l) => l.key === key)
  return lead ? holeId(lead.hole) : null
}

/** 외부 전원 부품(itemId)의 전압·전류를 정하고 지정한 전원 핀(pins)과 GND 에 잇는다 */
function connectSupply(state: CircuitState, itemId: string, pins: string[], route: RouteMode, voltage: number, currentMa: number, message: string, supplyId?: string): CircuitState {
  const item = state.placed.find((p) => p.instanceId === itemId)!
  const module = getModule(item.moduleId)
  const param = (id: string, wanted: number) => module.parameters!.find((p) => p.id === id)!.options.find((o) => o.number === wanted)?.value
  const sized = { ...item.params, voltage: param('voltage', voltage) ?? item.params.voltage, current: param('current', currentMa) ?? item.params.current }
  // 고른 전원 예시를 종류로 기록한다. 예시 없이 전압·전류만 맞췄으면 기록된 제품과 달라졌는지 확인한다
  const params = supplyId && hasSupplyKind(module) ? syncSupplyKind(module, { ...sized, [SUPPLY_PARAM]: supplyId }) : syncSupplyKind(module, sized)
  const placed = state.placed.map((p) => (p === item ? { ...p, params } : p))
  // 보드 전원·다른 전원에 물려 있던 전원 핀은 새 전원으로 옮기고, 전류가 보드를 지나지 않도록 GND 전선도 전원 − 로 옮긴다.
  // 그 전원 핀에 함께 물린 부하(서보 드라이버 V+ 의 서보 전원선 등)는 그대로 둔다.
  const moved = new Set(pins)
  const grounds = new Set(primaryGrounds(pins, placed))
  const isSupplySide = (e: Endpoint) => e.kind === 'board' || resolveModulePin(placed, e)?.pin.role === 'source'
  const connections = state.connections.filter((c) => {
    const keys = [endpointKey(c.from), endpointKey(c.to)]
    if (keys.some((k) => moved.has(k))) return !(isSupplySide(c.from) || isSupplySide(c.to))
    return !(keys.some((k) => grounds.has(k)) && (c.from.kind === 'board' || c.to.kind === 'board'))
  })
  const circuit = { ...circuitOf(state), placed, connections }
  const scope = supplyScope(circuit, pins)
  scope.add(endpointKey(moduleEndpoint(item.instanceId, 'minus')))
  const result = autoAssign(circuit, state.nextConnSeq, { route, only: scope })
  // 보드에서 뗀 GND 가 다른 부품(서보 등)에 이미 물려 있으면 자동 배정이 건너뛰므로, 전원 − 와 이어졌는지 확인해 잇는다
  const minus = endpointKey(moduleEndpoint(item.instanceId, 'minus'))
  const after = buildNetlist({ ...circuit, connections: result.connections })
  const extra: Connection[] = []
  let seq = result.nextConnSeq
  for (const g of grounds) {
    if (after.netOf(g) === after.netOf(minus)) continue
    extra.push({ id: `w${seq++}`, from: parseEndpointKey(g)!, to: moduleEndpoint(item.instanceId, 'minus'), auto: false })
  }
  // 전원 핀이 이미 다른 부하(서보 전원선 등)에 물려 있으면 자동 배정이 건너뛰므로 + 에 직접 잇는다
  const plusPin = getModule(item.moduleId).pins.find((p) => p.role === 'source')
  if (plusPin) {
    const plus = endpointKey(moduleEndpoint(item.instanceId, plusPin.id))
    for (const key of pins) {
      if (after.netOf(key) === after.netOf(plus)) continue
      extra.push({ id: `w${seq++}`, from: parseEndpointKey(key)!, to: moduleEndpoint(item.instanceId, plusPin.id), auto: false })
    }
  }
  return {
    ...state,
    placed,
    connections: [...result.connections, ...extra],
    nextConnSeq: seq,
    selection: { kind: 'module', instanceId: item.instanceId },
    statusMessage: message.replace('{n}', String(result.added.length + extra.length)),
  }
}

/** 방금 놓은 외부 전원을 전원이 필요한 부품에 맞춰 연결한다 */
function autoConnectSupply(state: CircuitState, itemId: string, near: string | undefined, route: RouteMode): CircuitState {
  const item = state.placed.find((p) => p.instanceId === itemId)!
  const open = analyzePower(circuitOf(state)).needs.filter((n) => !n.servedBy && n.pins.length && n.examples.length)
  const touchesNear = (n: (typeof open)[number]) => !!near && (n.consumers.some((c) => c.instanceId === near) || n.pins.some((k) => k.startsWith(`module:${near}:`)))
  const need = open.find(touchesNear) ?? open[0]
  if (!need)
    return { ...state, statusMessage: `${item.label}을(를) 배치했습니다. 외부 전원이 필요한 부품이 아직 없어 연결하지 않았습니다 — 모터 드라이버나 큰 서보를 놓은 뒤 카드의 ⚡ 표시로 연결할 수 있습니다.` }
  const example = need.examples[0]
  const names = [...new Set(need.consumers.map((c) => c.label))].join(', ')
  return connectSupply(
    state,
    itemId,
    need.pins,
    route,
    example.voltage,
    example.maxCurrentMa,
    `${item.label}을(를) ${example.name}(${example.voltage} V · ${formatCurrent(example.maxCurrentMa)})로 맞춰 ${names} 전원에 연결했습니다 (전선 {n}개).`,
    example.id,
  )
}

/** 모터를 드라이버의 빈 채널에 잇고, 그 채널의 제어·전원 핀을 배정하고, 모터 카드를 드라이버 옆으로 옮긴다 */
function attachMotor(state: CircuitState, motorId: string, driverId: string, route: RouteMode): CircuitState {
  const plan = planMotorAttach(circuitOf(state), motorId, driverId)
  if (!plan.ok) return { ...state, statusMessage: plan.reason }
  const motor = state.placed.find((p) => p.instanceId === motorId)!
  const driver = state.placed.find((p) => p.instanceId === driverId)!
  const motorModule = getModule(motor.moduleId)
  const driverModule = getModule(driver.moduleId)
  const loads = motorPins(motorModule)
  // 서보 드라이버면 서보 전원은 드라이버 V+ 에, GND 는 드라이버 GND 에 잇는다
  const servoRail = plan.channel.accepts.includes('servo')
  const servoPower = servoRail ? motorModule.pins.filter((p) => p.role === 'power' || p.role === 'ground') : []
  const loadKeys = new Set([...loads, ...servoPower].map((p) => endpointKey(moduleEndpoint(motor.instanceId, p.id))))
  // 다른 드라이버(또는 보드)에 물려 있던 전선은 뗀다
  const kept = state.connections.filter((c) => ![c.from, c.to].some((e) => loadKeys.has(endpointKey(e))))
  let seq = state.nextConnSeq
  const wires: Connection[] = loads.map((p, i) => ({
    id: `w${seq++}`,
    from: moduleEndpoint(motor.instanceId, p.id),
    to: moduleEndpoint(driver.instanceId, plan.channel.outputs[i]),
    auto: false,
  }))
  const spot = clampToCanvas({ x: driver.x + MODULE_SIZE.width + 40, y: driver.y + (plan.used - 1) * (MODULE_SIZE.height + 16) })
  const placed = state.placed.map((p) => (p === motor ? { ...p, x: spot.x, y: spot.y, hostBoardId: driver.hostBoardId } : p))
  const driverPins = new Set(driverModule.pins.filter((p) => p.role !== 'drive').map((p) => endpointKey(moduleEndpoint(driver.instanceId, p.id))))
  const result = autoAssign({ ...circuitOf(state), placed, connections: [...kept, ...wires] }, seq, { route, only: driverPins })
  // 서보 전원·GND 는 드라이버 핀이 보드·전원에 배정된 뒤에 잇는다 (드라이버 GND 가 서보에만 물려 보드와 떨어지지 않게)
  const rail: Connection[] = []
  let next = result.nextConnSeq
  if (servoRail) {
    const driverGround = driverModule.pins.find((p) => p.role === 'ground')
    for (const p of servoPower) {
      const target = p.role === 'power' ? driverModule.driver!.supplyPin : driverGround?.id
      if (target) rail.push({ id: `w${next++}`, from: moduleEndpoint(motor.instanceId, p.id), to: moduleEndpoint(driver.instanceId, target), auto: false })
    }
  }
  const pending = result.failed.length ? ` · 남은 핀: ${result.failed.join(', ')}` : ''
  return {
    ...state,
    placed,
    connections: [...result.connections, ...rail],
    nextConnSeq: next,
    selection: { kind: 'module', instanceId: driver.instanceId },
    statusMessage: `${motor.label} → ${driver.label} ${plan.channel.label}에 연결했습니다 (${plan.used}/${plan.max}). ${servoRail ? '서보 전원·GND 를 드라이버에 잇고 ' : ''}제어 핀 ${result.added.length}개 배정${pending}`,
  }
}

function statusOfAssign(result: ReturnType<typeof autoAssign>): string {
  const parts = [`자동 핀 배정: 연결 ${result.added.length}개 추가`]
  if (result.removed.length) parts.push(`오류·충돌 연결 ${result.removed.length}개 재배치`)
  if (result.failed.length) parts.push(`배정 실패 ${result.failed.length}개 (${result.failed.join(', ')})`)
  return result.added.length || result.removed.length || result.failed.length ? parts.join(' · ') : '자동 핀 배정: 모든 핀이 이미 올바르게 연결되어 있습니다.'
}

function reduce(state: CircuitState, action: CircuitAction): CircuitState {
  switch (action.type) {
    case 'setBoard': {
      const instance = state.boards.find((b) => b.instanceId === action.boardInstanceId)
      if (!instance || action.boardId === instance.boardId) return state
      const board = getBoard(action.boardId)
      const missing = state.connections.filter((c) =>
        [c.from, c.to].some((e) => e.kind === 'board' && e.boardInstanceId === instance.instanceId && !boardHasPin(board, e.pinId)),
      ).length
      const who = state.boards.length > 1 ? `${instance.label}를 ` : '메인 보드를 '
      return {
        ...state,
        // 보드 인스턴스(위치 등)는 유지하고 어떤 보드 정의를 쓰는지만 바꾼다.
        boards: state.boards.map((b) => (b === instance ? { ...b, boardId: board.id } : b)),
        statusMessage:
          `${who}${board.name}(으)로 변경했습니다.` +
          (missing ? ` 새 보드에 없는 핀에 연결된 전선 ${missing}개가 있습니다 — [자동 핀 배정]으로 다시 연결하세요.` : ''),
      }
    }
    case 'addBoard': {
      const def = getBoard(action.boardId)
      const position = findBoardPosition(obstacleRects(state), state.placed, def.footprint.width)
      const instance = createBoardInstance(def.id, state.nextBoardSeq, position)
      return {
        ...state,
        boards: [...state.boards, instance],
        nextBoardSeq: state.nextBoardSeq + 1,
        selection: { kind: 'board', boardInstanceId: instance.instanceId },
        statusMessage: `${instance.label}(${def.name})를 추가했습니다. 연결 방식 창에서 보드 간 통신을 설정할 수 있습니다.`,
      }
    }
    case 'removeBoard': {
      const target = state.boards.find((b) => b.instanceId === action.boardInstanceId)
      if (!target) return state
      if (state.boards.length === 1) return { ...state, statusMessage: '보드가 하나뿐일 때는 삭제할 수 없습니다.' }
      const boards = state.boards.filter((b) => b !== target)
      const links = state.links.filter((l) => l.a.boardInstanceId !== target.instanceId && l.b.boardInstanceId !== target.instanceId)
      const removedLinks = new Set(state.links.filter((l) => !links.includes(l)).map((l) => l.id))
      const connections = state.connections.filter((c) => !touchesBoard(c, target.instanceId) && !(c.linkId && removedLinks.has(c.linkId)))
      const placed = state.placed.map((p) => (p.hostBoardId === target.instanceId ? { ...p, hostBoardId: boards[0].instanceId } : p))
      return keepSelection(
        {
          ...state,
          boards,
          links,
          connections,
          placed,
          statusMessage: `${target.label}를 삭제했습니다. 연결 ${state.connections.length - connections.length}개도 함께 제거했습니다.`,
        },
        state.selection,
      )
    }
    case 'moveBoard': {
      const target = state.boards.find((b) => b.instanceId === action.boardInstanceId)
      const def = target && findBoard(target.boardId)
      if (!target || !def) return state
      const position = clampToCanvas(action.position, def.footprint)
      return { ...state, boards: state.boards.map((b) => (b === target ? { ...b, x: position.x, y: position.y } : b)) }
    }
    case 'addModule': {
      const module = getModule(action.moduleId)
      const host = state.boards.find((b) => b.instanceId === action.hostBoardId) ?? activeBoardOf(state)
      const position = action.position ? clampToCanvas(action.position) : findFreePosition(state.placed, obstacleRects(state))
      const labelNo = (state.labelCounters[module.id] ?? 0) + 1
      const instance: PlacedModule = {
        instanceId: `${module.id}#${state.nextSeq}`,
        moduleId: module.id,
        label: `${module.name} ${labelNo}`,
        x: position.x,
        y: position.y,
        params: Object.fromEntries((module.parameters ?? []).map((p) => [p.id, p.defaultValue])),
        hostBoardId: host.instanceId,
      }
      const next: CircuitState = {
        ...state,
        placed: [...state.placed, instance],
        selection: { kind: 'module', instanceId: instance.instanceId },
        nextSeq: state.nextSeq + 1,
        labelCounters: { ...state.labelCounters, [module.id]: labelNo },
        statusMessage: `${instance.label}을(를) 배치했습니다.` + (state.boards.length > 1 ? ` (제어 보드: ${host.label})` : ''),
      }
      return action.autoConnect && module.id === 'external-power' ? autoConnectSupply(next, instance.instanceId, action.near, action.route ?? 'direct') : next
    }
    case 'moveModule': {
      const position = clampToCanvas(action.position)
      return {
        ...state,
        placed: state.placed.map((p) =>
          p.instanceId === action.instanceId ? { ...p, x: position.x, y: position.y } : p,
        ),
      }
    }
    case 'setHostBoard': {
      const board = state.boards.find((b) => b.instanceId === action.boardInstanceId)
      const target = state.placed.find((p) => p.instanceId === action.instanceId)
      if (!board || !target || target.hostBoardId === board.instanceId) return state
      return {
        ...state,
        placed: state.placed.map((p) => (p === target ? { ...p, hostBoardId: board.instanceId } : p)),
        statusMessage: `${target.label}의 제어 보드를 ${board.label}로 바꿨습니다. [자동 핀 배정]으로 다시 연결하세요.`,
      }
    }
    case 'select':
      if (!selectionExists(state, action.selection)) return state
      return { ...state, selection: action.selection }
    case 'removeModule': {
      const target = state.placed.find((p) => p.instanceId === action.instanceId)
      if (!target) return state
      const connections = state.connections.filter((c) => !touchesInstance(c, action.instanceId))
      return keepSelection(
        {
          ...state,
          placed: state.placed.filter((p) => p.instanceId !== action.instanceId),
          connections,
          statusMessage:
            `${target.label}을(를) 삭제했습니다.` +
            (connections.length < state.connections.length ? ` 연결 ${state.connections.length - connections.length}개도 함께 제거했습니다.` : ''),
        },
        state.selection,
      )
    }
    case 'setParam': {
      const target = state.placed.find((p) => p.instanceId === action.instanceId)
      const param = target && getModule(target.moduleId).parameters?.find((p) => p.id === action.paramId)
      if (!target || !param?.options.some((o) => o.value === action.value)) return state
      const module = getModule(target.moduleId)
      const next = { ...target.params, [action.paramId]: action.value }
      const supply = action.paramId === SUPPLY_PARAM ? findSupply(action.value) : undefined
      const params = supply ? paramsForSupply(module, next, supply) : action.paramId === SUPPLY_PARAM ? next : syncSupplyKind(module, next)
      return {
        ...state,
        placed: state.placed.map((p) => (p === target ? { ...p, params } : p)),
      }
    }
    case 'moveBreadboard':
      return { ...state, breadboard: clampToCanvas(action.position, BREADBOARD_SIZE) }
    case 'moveLayout': {
      const known = action.id === 'breadboard' || state.boards.some((b) => b.instanceId === action.id) || state.placed.some((p) => p.instanceId === action.id)
      if (!known) return state
      return { ...state, layout: { ...state.layout, [action.id]: { x: Math.round(action.position.x), y: Math.round(action.position.y) } } }
    }
    case 'connect': {
      const keys = [endpointKey(action.from), endpointKey(action.to)]
      const bothModules = action.from.kind === 'module' && action.to.kind === 'module' && action.from.instanceId !== action.to.instanceId
      if (bothModules && keys.some((k) => roleOfKey(circuitOf(state), k)) ) return sharePins(state, action.to, action.from, action.via)
      return connect(state, action.from, action.to, action.via)
    }
    case 'unsharePin': {
      const share = shareOf(circuitOf(state), action.key)
      if (!share) return state
      const target = shareBoardPin(circuitOf(state), share)
      const connections = state.connections.filter(
        (c) => !(target && [c.from, c.to].some((e) => endpointKey(e) === action.key) && [c.from, c.to].some((e) => e.kind === 'board' && e.boardInstanceId === target.boardInstanceId && e.pinId === target.pinId)),
      )
      const shares = state.shares.map((s) => (s === share ? { ...s, members: s.members.filter((k) => k !== action.key) } : s)).filter((s) => s.members.length >= 2)
      const e = parseEndpointKey(action.key)
      return { ...state, connections, shares, statusMessage: `${e ? describeEndpoint(e, circuitOf(state)) : action.key}의 핀 공유를 풀었습니다.` }
    }
    case 'connectAuto': {
      if (action.endpoint.kind !== 'module') return { ...state, statusMessage: '보드 핀은 부품 핀까지 끌어다 놓으세요.' }
      const target = resolveModulePin(state.placed, action.endpoint)
      if (!target) return state
      const key = endpointKey(action.endpoint)
      const connections = state.connections.filter((c) => endpointKey(c.from) !== key && endpointKey(c.to) !== key)
      const result = autoAssign({ ...circuitOf(state), connections }, state.nextConnSeq, { route: action.route, only: new Set([key]) })
      if (!result.added.length) return { ...state, statusMessage: `${target.placed.label} · ${target.pin.name}: 연결할 핀을 찾지 못했습니다. 보드 핀이나 부품 핀에 직접 놓으세요.` }
      const added = result.added[0]
      return {
        ...state,
        connections: result.connections,
        nextConnSeq: result.nextConnSeq,
        selection: { kind: 'connection', connectionId: added.id },
        statusMessage: `${describeEndpoint(added.from, circuitOf(state))} → ${describeEndpoint(added.to, circuitOf(state))} 연결했습니다.`,
      }
    }
    case 'setConnectionRoute': {
      if (!state.connections.some((c) => c.id === action.connectionId)) return state
      const connections = state.connections.map((c) => {
        if (c.id !== action.connectionId) return c
        const { via: _via, ...rest } = c
        return action.via === 'breadboard' ? { ...rest, via: 'breadboard' as const } : rest
      })
      return { ...state, connections, statusMessage: action.via === 'breadboard' ? '이 전선을 브레드보드 경유로 바꿨습니다.' : '이 전선을 보드 직결로 바꿨습니다.' }
    }
    case 'moveLead': {
      const routing = routeBreadboard(circuitOf(state))
      const lead = routing.leads.find((l) => l.key === action.key)
      if (!lead || holeId(lead.hole) === holeId(action.hole)) return state
      const check = checkLeadMove(routing, action.key, action.hole)
      if (!check.ok) return { ...state, statusMessage: check.reason }
      // 처음 옮길 때 지금 배치를 모두 기록해 두어, 손대지 않은 전선이 따라 움직이지 않게 한다
      const breadboardHoles = Object.fromEntries(routing.leads.map((l) => [l.key, holeId(l.hole)]))
      breadboardHoles[action.key] = holeId(action.hole)
      const e = parseEndpointKey(action.key)
      const who = e ? describeEndpoint(e, circuitOf(state)) : action.key
      const h = action.hole
      const polarity =
        h.kind === 'rail' && ((lead.kind === 'ground' && h.rail.endsWith('+')) || (lead.kind === 'power' && h.rail.endsWith('-')))
          ? ` 레일 표시(${h.rail.endsWith('+') ? '+' : '−'})와 반대인 ${lead.kind === 'ground' ? 'GND' : '전원'}이라 헷갈릴 수 있습니다.`
          : ''
      return { ...state, breadboardHoles, statusMessage: `${who} 전선을 ${holeLabel(h)}(으)로 옮겼습니다.${polarity}` }
    }
    case 'connectToHole':
      return connectToHole(state, action.endpoint, action.hole)
    case 'resetModuleWiring': {
      const target = state.placed.find((p) => p.instanceId === action.instanceId)
      if (!target) return state
      const connections = state.connections.filter((c) => !touchesInstance(c, action.instanceId))
      if (connections.length === state.connections.length) return { ...state, statusMessage: `${target.label}에는 지울 전선이 없습니다.` }
      return keepSelection(
        { ...state, connections, statusMessage: `${target.label}의 전선 ${state.connections.length - connections.length}개를 지웠습니다. 다시 연결하려면 [이 부품만 자동 배정]을 누르거나 핀을 끌어 연결하세요.` },
        state.selection,
      )
    }
    case 'autoAssignModule': {
      const target = state.placed.find((p) => p.instanceId === action.instanceId)
      if (!target) return state
      const only = new Set(getModule(target.moduleId).pins.map((p) => endpointKey(moduleEndpoint(target.instanceId, p.id))))
      const result = autoAssign(circuitOf(state), state.nextConnSeq, { route: action.route, only })
      return {
        ...state,
        connections: result.connections,
        nextConnSeq: result.nextConnSeq,
        statusMessage: `${target.label}: ${statusOfAssign(result)}`,
      }
    }
    case 'resetBreadboardLayout':
      if (!Object.keys(state.breadboardHoles).length) return { ...state, statusMessage: '이미 자동 배치입니다.' }
      return { ...state, breadboardHoles: {}, statusMessage: '브레드보드 배치를 자동 배치로 되돌렸습니다.' }
    case 'retargetWire': {
      const targets = state.connections.filter((c) => action.connectionIds.includes(c.id) && touches(c, action.from))
      if (!targets.length || sameEndpoint(action.from, action.to)) return state
      let next: CircuitState = { ...state, connections: state.connections.filter((c) => !targets.includes(c)) }
      let note = ''
      for (const c of targets) {
        const [a, b] = sameEndpoint(c.from, action.from) ? [action.to, c.to] : [c.from, action.to]
        // 같은 두 핀을 잇는 전선이 이미 있으면 그 전선으로 합친다
        if (next.connections.some((x) => (sameEndpoint(x.from, a) && sameEndpoint(x.to, b)) || (sameEndpoint(x.from, b) && sameEndpoint(x.to, a)))) continue
        const joined = connect(next, a, b, c.via, c.id)
        if (joined.connections === next.connections)
          return { ...state, statusMessage: joined.statusMessage !== next.statusMessage ? joined.statusMessage : `${describeEndpoint(action.to, circuitOf(state))}(으)로는 옮길 수 없습니다.` }
        const rest = joined.statusMessage.split('연결했습니다.')[1]?.trim()
        if (rest) note = ` ${rest}`
        next = joined
      }
      // 브레드보드에 꽂힌 자리는 새 핀의 전선이 이어받는다
      const fromKey = endpointKey(action.from)
      const toKey = endpointKey(action.to)
      const holes = { ...state.breadboardHoles }
      const stillUsed = next.connections.some((c) => c.via === 'breadboard' && touches(c, action.from))
      if (holes[fromKey] && !stillUsed) {
        if (!holes[toKey]) holes[toKey] = holes[fromKey]
        delete holes[fromKey]
      }
      const circuit = circuitOf(state)
      const kept = next.connections.find((c) => targets.some((t) => t.id === c.id))
      return {
        ...next,
        breadboardHoles: holes,
        selection: kept ? { kind: 'connection', connectionId: kept.id } : { kind: 'none' },
        statusMessage: `전선 끝을 ${describeEndpoint(action.from, circuit)} → ${describeEndpoint(action.to, circuit)}(으)로 옮겼습니다.${note}`,
      }
    }
    case 'attachMotor':
      return attachMotor(state, action.motorId, action.driverId, action.route)
    case 'addDriverFor': {
      const motor = state.placed.find((p) => p.instanceId === action.motorId)
      const def = motor && recommendDriver(getModule(motor.moduleId))
      if (!motor || !def) return { ...state, statusMessage: '이 부품에 맞는 모터 드라이버가 없습니다.' }
      const position = clampToCanvas({ x: motor.x - MODULE_SIZE.width - 40, y: motor.y })
      const added = reduce(state, { type: 'addModule', moduleId: def.id, position, hostBoardId: motor.hostBoardId })
      const driver = added.placed.at(-1)!
      const next = attachMotor(added, motor.instanceId, driver.instanceId, action.route)
      return { ...next, statusMessage: `${driver.label}을(를) 추가했습니다. ${next.statusMessage}` }
    }
    case 'removeConnection': {
      if (!state.connections.some((c) => c.id === action.connectionId)) return state
      const connections = state.connections.filter((c) => c.id !== action.connectionId)
      return keepSelection({ ...state, connections, statusMessage: '연결을 삭제했습니다.' }, state.selection)
    }
    case 'clearConnections':
      return keepSelection(
        { ...state, connections: [], links: [], statusMessage: `연결 ${state.connections.length}개를 모두 삭제했습니다.` },
        state.selection,
      )
    case 'autoAssign': {
      if (state.placed.length === 0) return { ...state, statusMessage: '배치된 부품이 없습니다.' }
      const result = autoAssign(circuitOf(state), state.nextConnSeq, { route: action.route })
      return keepSelection({ ...state, connections: result.connections, nextConnSeq: result.nextConnSeq, statusMessage: statusOfAssign(result) }, state.selection)
    }
    case 'applySupply': {
      const supply = findSupply(action.supplyId)
      if (!supply) return state
      const placedState = reduce(state, { type: 'addModule', moduleId: 'external-power' })
      const item = placedState.placed.at(-1)!
      return connectSupply(placedState, item.instanceId, action.pins, action.route, supply.voltage, supply.maxCurrentMa, `${supply.name}를 외부 전원으로 놓고 연결 {n}개를 만들었습니다.`, supply.id)
    }
    case 'mergeSupplies': {
      const keep = state.placed.find((p) => p.instanceId === action.keepId)
      const others = state.placed.filter((p) => action.otherIds.includes(p.instanceId) && p !== keep)
      if (!keep || !others.length) return state
      if (others.some((o) => o.moduleId !== keep.moduleId || o.params.voltage !== keep.params.voltage))
        return { ...state, statusMessage: '전압이 같은 외부 전원끼리만 합칠 수 있습니다.' }
      const gone = new Set(others.map((o) => o.instanceId))
      const swap = (e: Endpoint): Endpoint => (e.kind === 'module' && gone.has(e.instanceId) ? moduleEndpoint(keep.instanceId, e.pinId) : e)
      const connections: Connection[] = []
      for (const c of state.connections) {
        const next = { ...c, from: swap(c.from), to: swap(c.to) }
        if (sameEndpoint(next.from, next.to)) continue
        const dup = connections.some((x) => (sameEndpoint(x.from, next.from) && sameEndpoint(x.to, next.to)) || (sameEndpoint(x.from, next.to) && sameEndpoint(x.to, next.from)))
        if (!dup) connections.push(next)
      }
      // 두 전원이 내던 전류를 합한 만큼 낼 수 있는 용량을 고른다
      const options = getModule(keep.moduleId).parameters!.find((p) => p.id === 'current')!.options
      const total = [keep, ...others].reduce((sum, p) => sum + Number(p.params.current), 0)
      const option = options.find((o) => (o.number ?? 0) >= total) ?? options.at(-1)!
      const keepModule = getModule(keep.moduleId)
      const placed = state.placed
        .filter((p) => !gone.has(p.instanceId))
        .map((p) => (p === keep ? { ...p, params: syncSupplyKind(keepModule, { ...p.params, current: option.value }) } : p))
      const short = (option.number ?? 0) < total ? ` 필요한 ${formatCurrent(total)}를 낼 수 있는 선택지가 없어 ${option.label}로 정했습니다.` : ''
      return keepSelection(
        {
          ...state,
          placed,
          connections,
          selection: { kind: 'module', instanceId: keep.instanceId },
          statusMessage: `${others.map((o) => o.label).join(', ')}을(를) ${keep.label}에 합쳤습니다 (${keep.params.voltage} V · ${option.label}).${short}`,
        },
        { kind: 'module', instanceId: keep.instanceId },
      )
    }
    case 'addBoardLink': {
      const linkId = `link-${state.nextLinkSeq}`
      const plan = planBoardLink(circuitOf(state), action.request, linkId, state.nextConnSeq)
      if (!plan.ok) return { ...state, statusMessage: `통신 연결 실패: ${plan.error}` }
      const a = state.boards.find((b) => b.instanceId === plan.link.a.boardInstanceId)!
      const b = state.boards.find((x) => x.instanceId === plan.link.b.boardInstanceId)!
      return {
        ...state,
        links: [...state.links, plan.link],
        connections: [...state.connections, ...plan.connections],
        nextConnSeq: plan.nextConnSeq,
        nextLinkSeq: state.nextLinkSeq + 1,
        statusMessage: `${plan.link.protocol} 통신을 연결했습니다: ${a.label} ↔ ${b.label} (전선 ${plan.connections.length}개).`,
      }
    }
    case 'removeBoardLink': {
      const link = state.links.find((l) => l.id === action.linkId)
      if (!link) return state
      const connections = state.connections.filter((c) => c.linkId !== link.id)
      return keepSelection(
        {
          ...state,
          links: state.links.filter((l) => l !== link),
          connections,
          statusMessage: `${link.protocol} 통신 연결과 전선 ${state.connections.length - connections.length}개를 삭제했습니다.`,
        },
        state.selection,
      )
    }
    case 'insertLevelShifters': {
      const result = insertLevelShifters(circuitOf(state), state)
      if (!result.added.length)
        return {
          ...state,
          statusMessage: result.unresolved.length
            ? `레벨 변환: 자동으로 고칠 수 있는 연결이 없습니다 (${result.unresolved.length}건은 직접 확인하세요).`
            : '레벨 변환: 전압 레벨 오류가 없습니다.',
        }
      return keepSelection(
        {
          ...state,
          placed: result.placed,
          connections: result.connections,
          nextSeq: result.nextSeq,
          nextConnSeq: result.nextConnSeq,
          labelCounters: result.labelCounters,
          statusMessage:
            `레벨 변환: ${result.added.join(', ')} 추가` +
            (result.unresolved.length ? ` · 자동으로 고치지 못한 문제 ${result.unresolved.length}건` : ''),
        },
        state.selection,
      )
    }
    case 'arrangeModules':
      if (!state.placed.length) return { ...state, statusMessage: '배치된 부품이 없습니다.' }
      return { ...state, placed: arrangeModules(circuitOf(state)), statusMessage: '부품을 연결된 핀 순서대로 정렬했습니다.' }
    case 'setProjectName':
      return { ...state, projectName: action.name }
    case 'loadProject':
      return {
        ...createInitialState(action.data.boards[0]),
        projectName: action.data.name,
        boards: action.data.boards,
        placed: action.data.placed,
        connections: action.data.connections,
        links: action.data.links,
        breadboard: action.data.breadboard ?? findBreadboardPosition(action.data.boards.map((b) => ({ x: b.x, y: b.y, width: findBoard(b.boardId)?.footprint.width ?? 0, height: findBoard(b.boardId)?.footprint.height ?? 0 })), action.data.placed),
        nextSeq: action.data.nextSeq,
        nextConnSeq: action.data.nextConnSeq,
        nextBoardSeq: action.data.nextBoardSeq,
        nextLinkSeq: action.data.nextLinkSeq,
        labelCounters: action.data.labelCounters,
        breadboardHoles: action.data.breadboardHoles ?? {},
        shares: action.data.shares ?? [],
        layout: action.data.layout ?? {},
        statusMessage: action.message ?? `프로젝트 "${action.data.name}"을(를) 불러왔습니다.`,
      }
    case 'reset':
      return {
        ...createInitialState(state.boards[0]),
        projectName: state.projectName,
        past: state.past,
        future: state.future,
        statusMessage: '작업 공간을 초기화했습니다.',
      }
    case 'setStatus':
      return { ...state, statusMessage: action.message }
    case 'checkpoint':
    case 'undo':
    case 'redo':
      return state
  }
}

/**
 * 핀 공유: from 핀을 onto 핀과 같은 보드 핀에 잇고 한 그룹으로 묶는다.
 * 둘 다 보드에 연결되어 있지 않으면 onto 핀부터 맞는 보드 핀을 고른다.
 */
function sharePins(state: CircuitState, onto: Endpoint, from: Endpoint, via?: 'breadboard'): CircuitState {
  const circuit = circuitOf(state)
  const ka = endpointKey(onto)
  const kb = endpointKey(from)
  const groups = state.shares.filter((s) => s.members.includes(ka) || s.members.includes(kb))
  const members = [...new Set([ka, ...groups.flatMap((g) => g.members), kb])]
  const refusal = shareRefusal(circuit, members)
  if (refusal) return { ...state, statusMessage: refusal }
  const linkOf = (key: string, connections: Connection[]) => {
    const e = parseEndpointKey(key)
    return e?.kind === 'module' ? connections.map(asModuleBoardLink).find((l) => l && l.instanceId === e.instanceId && l.modulePinId === e.pinId) ?? null : null
  }
  let connections = state.connections
  let nextConnSeq = state.nextConnSeq
  let target = members.map((k) => linkOf(k, connections)).find(Boolean) ?? null
  if (!target) {
    // 아무도 연결되어 있지 않으면 끌어 놓은 대상 핀부터 자동 배정한다
    const result = autoAssign(circuit, nextConnSeq, { route: via ? 'breadboard' : 'direct', only: new Set([ka]) })
    connections = result.connections
    nextConnSeq = result.nextConnSeq
    target = linkOf(ka, connections)
    if (!target) return { ...state, statusMessage: `${describeEndpoint(onto, circuit)}: 함께 쓸 보드 핀을 찾지 못했습니다. 먼저 한 핀을 보드에 연결하세요.` }
  }
  const pin = { kind: 'board' as const, boardInstanceId: target.boardInstanceId, pinId: target.pinId }
  for (const key of members) {
    const link = linkOf(key, connections)
    if (link && link.boardInstanceId === target.boardInstanceId && link.pinId === target.pinId) continue
    const e = parseEndpointKey(key)!
    // 다른 보드 핀에 물려 있던 전선은 떼고 공유 핀에 잇는다
    connections = connections.filter((c) => !([c.from, c.to].some((x) => endpointKey(x) === key) && [c.from, c.to].some((x) => x.kind === 'board')))
    connections = [...connections, { id: `w${nextConnSeq++}`, from: e, to: pin, auto: false, ...(via ? { via } : {}) }]
  }
  const existing = groups[0]
  const id = existing?.id ?? `share-${Math.max(0, ...state.shares.map((s) => Number(s.id.match(/(\d+)$/)?.[1] ?? 0))) + 1}`
  const shares = [...state.shares.filter((s) => !groups.includes(s)), { id, members }]
  const labels = members.map((k) => describeEndpoint(parseEndpointKey(k)!, circuit)).join(', ')
  return {
    ...state,
    connections,
    nextConnSeq,
    shares,
    selection: { kind: 'module', instanceId: (from as { instanceId: string }).instanceId },
    statusMessage: `핀 공유: ${labels} 이(가) ${target.pinId} 를 함께 씁니다.`,
  }
}

/** 지워진 보드·부품의 실물 배치 위치를 지운다 */
function pruneLayout(state: CircuitState): CircuitState {
  const ids = Object.keys(state.layout)
  if (!ids.length) return state
  const live = (id: string) => id === 'breadboard' || state.boards.some((b) => b.instanceId === id) || state.placed.some((p) => p.instanceId === id)
  if (ids.every(live)) return state
  return { ...state, layout: Object.fromEntries(Object.entries(state.layout).filter(([id]) => live(id))) }
}

/** 지워진 부품의 핀을 공유 그룹에서 뺀다 */
function pruneShares(state: CircuitState): CircuitState {
  if (!state.shares.length) return state
  const ids = new Set(state.placed.map((p) => p.instanceId))
  const shares = state.shares
    .map((s) => ({ ...s, members: s.members.filter((k) => ids.has((parseEndpointKey(k) as { instanceId?: string } | null)?.instanceId ?? '')) }))
    .filter((s) => s.members.length >= 2)
  const same = shares.length === state.shares.length && shares.every((s, i) => s.members.length === state.shares[i].members.length)
  return same ? state : { ...state, shares }
}

/** 브레드보드를 거치지 않게 된 끝점의 구멍 기록을 지운다 */
function pruneHoles(state: CircuitState): CircuitState {
  const keys = Object.keys(state.breadboardHoles)
  if (!keys.length) return state
  const live = new Set(state.connections.filter((c) => c.via === 'breadboard').flatMap((c) => [endpointKey(c.from), endpointKey(c.to)]))
  if (keys.every((k) => live.has(k))) return state
  return { ...state, breadboardHoles: Object.fromEntries(Object.entries(state.breadboardHoles).filter(([k]) => live.has(k))) }
}

/** 기록을 건너뛸 수 있도록 현재 문서와 같은 스냅샷은 버린다 */
function popDifferent(stack: CircuitDocument[], current: CircuitDocument): [CircuitDocument | undefined, CircuitDocument[]] {
  const rest = [...stack]
  while (rest.length) {
    const doc = rest.pop()!
    if (!sameDocument(doc, current)) return [doc, rest]
  }
  return [undefined, rest]
}

export function circuitReducer(state: CircuitState, action: CircuitAction): CircuitState {
  if (action.type === 'checkpoint')
    return { ...state, past: [...state.past, documentOf(state)].slice(-HISTORY_LIMIT), future: [] }
  if (action.type === 'undo' || action.type === 'redo') {
    const undo = action.type === 'undo'
    const [doc, rest] = popDifferent(undo ? state.past : state.future, state)
    if (!doc) return { ...state, statusMessage: undo ? '되돌릴 작업이 없습니다.' : '다시 실행할 작업이 없습니다.' }
    const current = documentOf(state)
    return keepSelection(
      {
        ...state,
        ...doc,
        past: undo ? rest : [...state.past, current].slice(-HISTORY_LIMIT),
        future: undo ? [...state.future, current] : rest,
        statusMessage: undo ? '실행 취소했습니다.' : '다시 실행했습니다.',
      },
      state.selection,
    )
  }
  const next = pruneLayout(pruneShares(pruneHoles(reduce(state, action))))
  if (next === state || NOT_RECORDED.has(action.type) || sameDocument(next, state)) return next
  return { ...next, past: [...state.past, documentOf(state)].slice(-HISTORY_LIMIT), future: [] }
}

