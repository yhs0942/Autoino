import { DEFAULT_BOARD_ID, findBoard, getBoard } from '../data/boards'
import { getModule } from '../data/modules'
import { findSupply } from '../data/supplies'
import { arrangeModules } from '../engine/arrange'
import { autoAssign } from '../engine/autoAssign'
import { planBoardLink, type LinkRequest } from '../engine/boardLinks'
import { resolveBoardPin, type Circuit } from '../engine/circuit'
import {
  boardHasPin,
  describeEndpoint,
  endpointKey,
  moduleEndpoint,
  resolveModulePin,
  sameEndpoint,
  touches,
  touchesBoard,
  touchesInstance,
} from '../engine/connections'
import { boardToBoardError, linkError } from '../engine/electrical'
import { insertLevelShifters } from '../engine/levelShift'
import { primaryGrounds, supplyScope } from '../engine/power'
import type { ProjectData } from '../engine/project'
import type { Connection, Endpoint, PlacedBoard, PlacedModule, Point, RouteMode, Selection } from '../types'
import {
  BOARD_POSITION,
  BREADBOARD_POSITION,
  BREADBOARD_SIZE,
  breadboardRect,
  clampToCanvas,
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
  | { type: 'addModule'; moduleId: string; position?: Point; hostBoardId?: string }
  | { type: 'moveModule'; instanceId: string; position: Point }
  | { type: 'setHostBoard'; instanceId: string; boardInstanceId: string }
  | { type: 'select'; selection: Selection }
  | { type: 'removeModule'; instanceId: string }
  | { type: 'setParam'; instanceId: string; paramId: string; value: string }
  | { type: 'connect'; from: Endpoint; to: Endpoint; via?: 'breadboard' }
  /** 끌어 놓은 핀에 맞는 상대 핀을 자동으로 골라 연결한다 (브레드보드에 놓았을 때) */
  | { type: 'connectAuto'; endpoint: Endpoint; route: RouteMode }
  | { type: 'setConnectionRoute'; connectionId: string; via: RouteMode }
  | { type: 'removeConnection'; connectionId: string }
  | { type: 'clearConnections' }
  | { type: 'autoAssign'; route?: RouteMode }
  /** 전원 예시를 외부 전원 부품으로 놓고 지정한 전원 핀에 연결한다 */
  | { type: 'applySupply'; supplyId: string; pins: string[]; route: RouteMode }
  | { type: 'moveBreadboard'; position: Point }
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
  'select', 'setStatus', 'moveModule', 'moveBoard', 'moveBreadboard', 'setProjectName', 'loadProject', 'checkpoint', 'undo', 'redo',
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
  const { projectName, boards, placed, connections, links, breadboard, nextSeq, nextConnSeq, nextBoardSeq, nextLinkSeq, labelCounters } = state
  return { projectName, boards, placed, connections, links, breadboard, nextSeq, nextConnSeq, nextBoardSeq, nextLinkSeq, labelCounters }
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
    nextSeq: d.nextSeq,
    nextConnSeq: d.nextConnSeq,
    nextBoardSeq: d.nextBoardSeq,
    nextLinkSeq: d.nextLinkSeq,
    labelCounters: d.labelCounters,
  }
}

export function circuitOf(state: CircuitDocument): Circuit {
  return { boards: state.boards, placed: state.placed, connections: state.connections, links: state.links, breadboard: state.breadboard }
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

function connect(state: CircuitState, from: Endpoint, to: Endpoint, via?: 'breadboard'): CircuitState {
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
  const connection: Connection = { id: `w${state.nextConnSeq}`, from: a, to: b, auto: false, ...(via ? { via } : {}) }
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
    nextConnSeq: state.nextConnSeq + 1,
    selection: { kind: 'connection', connectionId: connection.id },
    statusMessage: message,
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
      return {
        ...state,
        placed: [...state.placed, instance],
        selection: { kind: 'module', instanceId: instance.instanceId },
        nextSeq: state.nextSeq + 1,
        labelCounters: { ...state.labelCounters, [module.id]: labelNo },
        statusMessage: `${instance.label}을(를) 배치했습니다.` + (state.boards.length > 1 ? ` (제어 보드: ${host.label})` : ''),
      }
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
      return {
        ...state,
        placed: state.placed.map((p) =>
          p === target ? { ...p, params: { ...p.params, [action.paramId]: action.value } } : p,
        ),
      }
    }
    case 'moveBreadboard':
      return { ...state, breadboard: clampToCanvas(action.position, BREADBOARD_SIZE) }
    case 'connect':
      return connect(state, action.from, action.to, action.via)
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
      const param = (id: string, wanted: number) => getModule(item.moduleId).parameters!.find((p) => p.id === id)!.options.find((o) => o.number === wanted)?.value
      const params = { ...item.params, voltage: param('voltage', supply.voltage) ?? item.params.voltage, current: param('current', supply.maxCurrentMa) ?? item.params.current }
      const placed = placedState.placed.map((p) => (p === item ? { ...p, params } : p))
      // 보드 전원에 물려 있던 전원 핀은 새 전원으로 옮기고, 전류가 보드를 지나지 않도록 GND 전선도 전원 − 로 옮긴다
      const moved = new Set(action.pins)
      const grounds = new Set(primaryGrounds(action.pins, placed))
      const connections = state.connections.filter((c) => {
        const keys = [endpointKey(c.from), endpointKey(c.to)]
        if (keys.some((k) => moved.has(k))) return false
        return !(keys.some((k) => grounds.has(k)) && (c.from.kind === 'board' || c.to.kind === 'board'))
      })
      const circuit = { ...circuitOf(placedState), placed, connections }
      const scope = supplyScope(circuit, action.pins)
      scope.add(endpointKey(moduleEndpoint(item.instanceId, 'minus')))
      const result = autoAssign(circuit, state.nextConnSeq, { route: action.route, only: scope })
      return {
        ...placedState,
        placed,
        connections: result.connections,
        nextConnSeq: result.nextConnSeq,
        selection: { kind: 'module', instanceId: item.instanceId },
        statusMessage: `${supply.name}를 외부 전원으로 놓고 연결 ${result.added.length}개를 만들었습니다.`,
      }
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
  const next = reduce(state, action)
  if (next === state || NOT_RECORDED.has(action.type) || sameDocument(next, state)) return next
  return { ...next, past: [...state.past, documentOf(state)].slice(-HISTORY_LIMIT), future: [] }
}

