import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { getModule } from '../../data/modules'
import { checkLeadMove, holeLabel, type BreadboardRouting, type Hole } from '../../engine/breadboard'
import { holeAt, holeXY, nodeBox, renderBreadboardBody } from '../../engine/breadboardSvg'
import { describeEndpoint, endpointKey, isPinConnected, moduleEndpoint, parseEndpointKey, requiredPins, resolveModulePin } from '../../engine/connections'
import { compatiblePins, sourceLimitMa, sourceVoltage } from '../../engine/electrical'
import { isServo, motorDriverOf, driverUsage, planMotorAttach, recommendDriver, type AttachPlan } from '../../engine/motorAttach'
import { focusOf } from '../../engine/focus'
import { supplyOf } from '../../engine/supplyInfo'
import { SUPPLY_KIND_LABELS } from '../../data/supplies'
import { roleOfKey, shareBoardPin, shareOf, shareRole } from '../../engine/shares'
import { formatCurrent, type PowerNeed, type PowerReport, type SupplyExample } from '../../engine/power'
import type { Circuit } from '../../engine/circuit'
import { NeedQuick } from '../PowerPanel/PowerPanel'
import type { SeriesResistorResult } from '../../engine/resistor'
import type { Issue } from '../../engine/validate'
import type { Board, Connection, Endpoint, Module, ModulePinRole, PinShare, PlacedBoard, PlacedModule, Point, RouteMode, Selection } from '../../types'
import { assetUrl } from '../../utils/assetUrl'
import { BREADBOARD_SIZE, CANVAS_SIZE, MODULE_SIZE } from '../../utils/placement'
import { MODULE_DRAG_TYPE } from '../ModuleLibrary/ModuleLibrary'
import { BoardGraphic } from './BoardGraphic'
import { WireLayer, type Grip } from './WireLayer'
import { wirePath, type Anchor, type WireStyle } from './wireGeometry'
import { wireTones } from './wireTones'
import './CircuitCanvas.css'

export interface CanvasBoard {
  /** 작업 공간에 배치된 보드 인스턴스 (위치) */
  instance: PlacedBoard
  /** 보드 정의 */
  def: Board
}

interface CircuitCanvasProps {
  boards: CanvasBoard[]
  placed: PlacedModule[]
  connections: Connection[]
  /** 핀 공유 그룹 */
  shares: PinShare[]
  selection: Selection
  issues: Issue[]
  resistors: SeriesResistorResult[]
  wireStyle: WireStyle
  /** 새 전선의 경로 */
  route: RouteMode
  routing: BreadboardRouting
  breadboard: Point
  power: PowerReport
  onSelect: (selection: Selection) => void
  /** near: 놓은 자리에 있던 부품 카드 (외부 전원을 카드에 놓으면 그 부품에 연결) */
  onDropModule: (moduleId: string, position: Point, near?: string) => void
  onMoveModule: (instanceId: string, position: Point) => void
  onMoveBoard: (boardInstanceId: string, position: Point) => void
  onMoveBreadboard: (position: Point) => void
  /** 드래그가 실제로 시작되었을 때 (실행 취소 기록용) */
  onCheckpoint: () => void
  onConnect: (from: Endpoint, to: Endpoint) => void
  /** 전선을 브레드보드 위에 놓았을 때: 맞는 상대 핀을 자동으로 고른다 */
  onConnectAuto: (endpoint: Endpoint) => void
  /** 브레드보드에 꽂힌 전선 끝을 다른 구멍으로 옮긴다 */
  onMoveLead: (key: string, hole: Hole) => void
  /** 전선 끝을 다른 핀으로 옮긴다 */
  onRetarget: (connectionIds: string[], from: Endpoint, to: Endpoint) => void
  /** 모터 카드를 드라이버 카드에 놓았을 때 */
  onAttachMotor: (motorId: string, driverId: string) => void
  /** 모터에 맞는 드라이버를 새로 놓고 연결한다 */
  onAddDriver: (motorId: string) => void
  onApplySupply: (need: PowerNeed, example: SupplyExample) => void
  /** 전원 탭 열기 */
  onShowPower: () => void
  /** 핀에서 끈 전선을 브레드보드 구멍에 놓았을 때 */
  onConnectToHole: (endpoint: Endpoint, hole: Hole) => void
  onDeleteWire: (connectionId: string) => void
}

interface MoveState {
  kind: 'module' | 'board' | 'breadboard'
  id: string
  /** 끌기 시작 전 위치 (연결할 수 없는 드라이버에 놓으면 되돌린다) */
  origin: Point
  offsetX: number
  offsetY: number
  startX: number
  startY: number
  recorded: boolean
}

interface WireDrag {
  from: Endpoint
  start: Point
  pointer: Point
  moved: boolean
}

/** 이미 있는 전선의 끝을 끄는 중 */
interface GripDrag {
  grip: Grip
  start: Point
  pointer: Point
  moved: boolean
  /** 핀 끝을 끌 때 포인터 아래의 핀 */
  over: Endpoint | null
}

function sameAnchors(a: Record<string, Anchor>, b: Record<string, Anchor>): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  const sameCard = (p: Anchor['card'], q: Anchor['card']) =>
    p === q || (!!p && !!q && p.id === q.id && p.left === q.left && p.top === q.top && p.right === q.right && p.bottom === q.bottom)
  return ka.every((k) => b[k] && a[k].x === b[k].x && a[k].y === b[k].y && a[k].dir === b[k].dir && a[k].half === b[k].half && sameCard(a[k].card, b[k].card))
}

/** 핀을 가리키는 중(끝점 키) 또는 전선을 가리키는 중(연결 ID 들) */
type Hover = { kind: 'pin'; key: string } | { kind: 'wire'; ids: string[] } | null

/** 전선 끝 등이 겹쳐 있어도 그 아래의 핀을 찾는다. */
function endpointAt(clientX: number, clientY: number): Endpoint | null {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const key = (el as HTMLElement).closest?.<HTMLElement>('[data-endpoint]')?.dataset.endpoint
    if (key) return parseEndpointKey(key)
  }
  return null
}

/** 포인터 아래에 있는 (exclude 가 아닌) 부품 카드 */
function cardAt(clientX: number, clientY: number, exclude: string): string | null {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const id = (el as HTMLElement).closest?.<HTMLElement>('[data-instance-id]')?.dataset.instanceId
    if (id && id !== exclude) return id
  }
  return null
}

function isOverBreadboard(clientX: number, clientY: number): boolean {
  return document.elementsFromPoint(clientX, clientY).some((el) => (el as HTMLElement).closest?.('[data-breadboard]'))
}

/** 전선을 끌 때 강조할 상대 부품 핀의 역할 */
const PEER_ROLE: Partial<Record<ModulePinRole, ModulePinRole>> = { load: 'drive', drive: 'load', source: 'power', power: 'source' }

/** 외부 전원 카드에 표시할 전압·전류 */
function sourceSummary(module: Module, item: PlacedModule): string | null {
  const pin = module.pins.find((p) => p.role === 'source')
  if (!pin || module.pins.filter((p) => p.role === 'source').length > 1) return null
  const volts = sourceVoltage(module, item, pin)
  const limit = sourceLimitMa(module, item, pin)
  const supply = supplyOf(item)
  const figures = volts === null ? null : `${volts} V${limit === null ? '' : ` · ${formatCurrent(limit)}`}`
  return figures && supply ? `${SUPPLY_KIND_LABELS[supply.kind]} · ${figures}` : figures
}

export function CircuitCanvas({
  boards,
  placed,
  connections,
  shares,
  selection,
  issues,
  resistors,
  wireStyle,
  route,
  routing,
  breadboard,
  power,
  onSelect,
  onDropModule,
  onMoveModule,
  onMoveBoard,
  onMoveBreadboard,
  onCheckpoint,
  onConnect,
  onConnectAuto,
  onMoveLead,
  onRetarget,
  onAttachMotor,
  onAddDriver,
  onApplySupply,
  onShowPower,
  onConnectToHole,
  onDeleteWire,
}: CircuitCanvasProps) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const moveRef = useRef<MoveState | null>(null)
  const [anchors, setAnchors] = useState<Record<string, Anchor>>({})
  const [wireDrag, setWireDrag] = useState<WireDrag | null>(null)
  const [gripDrag, setGripDrag] = useState<GripDrag | null>(null)
  const [hover, setHover] = useState<Hover>(null)
  /** 모터 카드를 드라이버 카드 위로 끄는 중 */
  const [attach, setAttach] = useState<{ motorId: string; driverId: string; plan: AttachPlan } | null>(null)
  /** 카드 옆에 띄운 전원·드라이버 안내 */
  const [popover, setPopover] = useState<{ kind: 'power' | 'driver'; instanceId: string } | null>(null)
  const circuit: Circuit = useMemo(() => ({ boards: boards.map((b) => b.instance), placed, connections, links: [], shares }), [boards, placed, connections, shares])
  const gripDragRef = useRef<GripDrag | null>(null)
  const [layoutTick, remeasure] = useReducer((n: number) => n + 1, 0)
  // 창 단위 리스너에서 최신 값을 읽기 위한 참조
  const wireDragRef = useRef<WireDrag | null>(null)
  const callbacksRef = useRef({ onConnect, onConnectAuto, onConnectToHole, onSelect, onMoveLead, onRetarget, breadboard })
  useLayoutEffect(() => {
    wireDragRef.current = wireDrag
    gripDragRef.current = gripDrag
    callbacksRef.current = { onConnect, onConnectAuto, onConnectToHole, onSelect, onMoveLead, onRetarget, breadboard }
  })
  const breadboardBody = useMemo(() => renderBreadboardBody(routing), [routing])
  const isWiring = wireDrag !== null
  const isGripping = gripDrag !== null

  /** 화면 좌표를 캔버스 좌표로 변환한다 (스크롤 반영). */
  const toCanvasPoint = (clientX: number, clientY: number): Point => {
    const rect = surfaceRef.current!.getBoundingClientRect()
    return { x: clientX - rect.left, y: clientY - rect.top }
  }

  // 렌더링 후 핀 위치를 측정해 전선 끝점으로 사용한다. 값이 같으면 상태를 바꾸지 않아 반복 렌더링이 없다.
  useLayoutEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const origin = surface.getBoundingClientRect()
    const next: Record<string, Anchor> = {}
    surface.querySelectorAll<HTMLElement>('[data-endpoint]').forEach((el) => {
      const r = el.getBoundingClientRect()
      const anchor: Anchor = {
        x: Math.round(r.left - origin.left + r.width / 2),
        y: Math.round(r.top - origin.top + r.height / 2),
        dir: Number(el.dataset.dir ?? 1),
      }
      // 부품 카드의 핀 칩: 전선이 칩 가장자리에서 시작해 반대쪽 끝을 향한 카드 가장자리로 나가게 한다
      const card = el.closest<HTMLElement>('.placed-module')
      if (card) {
        const c = card.getBoundingClientRect()
        anchor.half = Math.round(r.height / 2)
        anchor.card = {
          id: card.dataset.instanceId ?? '',
          left: Math.round(c.left - origin.left),
          top: Math.round(c.top - origin.top),
          right: Math.round(c.right - origin.left),
          bottom: Math.round(c.bottom - origin.top),
        }
      }
      next[el.dataset.endpoint!] = anchor
    })
    setAnchors((prev) => (sameAnchors(prev, next) ? prev : next))
  }, [boards, placed, layoutTick])

  // 웹 폰트 적용 후 보드 핀 위치가 바뀔 수 있으므로 다시 측정한다.
  useEffect(() => {
    document.fonts?.ready.then(remeasure).catch(() => {})
  }, [])

  // 부품·보드가 새로 추가되면 화면 밖에 있더라도 보이도록 스크롤한다 (좁은 화면 대응).
  const lastInstanceId = placed.at(-1)?.instanceId
  const lastBoardId = boards.at(-1)?.instance.instanceId
  const countsRef = useRef({ placed: placed.length, boards: boards.length })
  useEffect(() => {
    const grewModules = placed.length > countsRef.current.placed
    const grewBoards = boards.length > countsRef.current.boards
    countsRef.current = { placed: placed.length, boards: boards.length }
    const selector = grewModules && lastInstanceId
      ? `[data-instance-id="${CSS.escape(lastInstanceId)}"]`
      : grewBoards && lastBoardId
        ? `[data-board-instance="${CSS.escape(lastBoardId)}"]`
        : null
    if (!selector) return
    surfaceRef.current?.querySelector(selector)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [placed.length, boards.length, lastInstanceId, lastBoardId])

  // 전선 끌기: 창 전체에서 포인터를 추적하고, 놓은 위치의 핀에 연결한다.
  useEffect(() => {
    if (!isWiring) return
    const onMove = (e: PointerEvent) => {
      const p = toCanvasPoint(e.clientX, e.clientY)
      setWireDrag((d) => d && { ...d, pointer: p, moved: d.moved || Math.hypot(p.x - d.start.x, p.y - d.start.y) > 4 })
    }
    const onUp = (e: PointerEvent) => {
      const drag = wireDragRef.current
      setWireDrag(null)
      if (!drag) return
      const { onConnect, onConnectAuto, onConnectToHole, onSelect, breadboard: at } = callbacksRef.current
      const to = endpointAt(e.clientX, e.clientY)
      if (to && endpointKey(to) !== endpointKey(drag.from)) {
        onConnect(drag.from, to)
        return
      }
      if (drag.moved && isOverBreadboard(e.clientX, e.clientY)) {
        // 구멍 위에 놓으면 그 구멍에 꽂고, 구멍 사이에 놓으면 맞는 핀을 자동으로 고른다
        const p = toCanvasPoint(e.clientX, e.clientY)
        const hole = holeAt(p.x - at.x, p.y - at.y)
        if (hole) onConnectToHole(drag.from, hole)
        else onConnectAuto(drag.from)
        return
      }
      // 끌지 않고 클릭만 했다면 해당 부품/보드를 선택한다.
      if (drag.from.kind === 'board') onSelect({ kind: 'board', boardInstanceId: drag.from.boardInstanceId })
      else onSelect({ kind: 'module', instanceId: drag.from.instanceId })
    }
    const onCancel = () => setWireDrag(null)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [isWiring])

  // 전선 끝 옮기기: 구멍 끝은 다른 구멍에, 핀 끝은 다른 핀에 놓는다.
  useEffect(() => {
    if (!isGripping) return
    const onMove = (e: PointerEvent) => {
      const p = toCanvasPoint(e.clientX, e.clientY)
      setGripDrag((d) => d && { ...d, pointer: p, moved: d.moved || Math.hypot(p.x - d.start.x, p.y - d.start.y) > 4, over: d.grip.kind === 'pin' ? endpointAt(e.clientX, e.clientY) : null })
    }
    const onUp = (e: PointerEvent) => {
      const drag = gripDragRef.current
      setGripDrag(null)
      if (!drag) return
      const { onMoveLead, onRetarget, onSelect, breadboard: at } = callbacksRef.current
      if (!drag.moved) {
        onSelect({ kind: 'connection', connectionId: drag.grip.connectionIds[0] })
        return
      }
      const p = toCanvasPoint(e.clientX, e.clientY)
      if (drag.grip.kind === 'hole') {
        const hole = holeAt(p.x - at.x, p.y - at.y)
        if (hole) onMoveLead(drag.grip.key, hole)
        return
      }
      const to = endpointAt(e.clientX, e.clientY)
      if (to && endpointKey(to) !== endpointKey(drag.grip.endpoint)) onRetarget(drag.grip.connectionIds, drag.grip.endpoint, to)
    }
    const onCancel = () => setGripDrag(null)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [isGripping])

  const pressGrip = (e: ReactPointerEvent, grip: Grip) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const p = toCanvasPoint(e.clientX, e.clientY)
    setGripDrag({ grip, start: p, pointer: p, moved: false, over: null })
  }

  /** 전선을 누르면 선택한다. 단, 전선 끝이 핀 위에 있으면 그 핀에서 새 전선을 시작한다. */
  const pressWire = (e: ReactPointerEvent, connectionId: string) => {
    const pin = endpointAt(e.clientX, e.clientY)
    if (pin) startWire(e, pin)
    else {
      e.stopPropagation()
      onSelect({ kind: 'connection', connectionId })
    }
  }

  const startWire = (e: ReactPointerEvent, from: Endpoint) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const p = toCanvasPoint(e.clientX, e.clientY)
    setWireDrag({ from, start: p, pointer: p, moved: false })
  }

  const handleDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes(MODULE_DRAG_TYPE)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  const handleDrop = (e: DragEvent) => {
    const moduleId = e.dataTransfer.getData(MODULE_DRAG_TYPE)
    if (!moduleId) return
    e.preventDefault()
    const p = toCanvasPoint(e.clientX, e.clientY)
    onDropModule(moduleId, { x: p.x - MODULE_SIZE.width / 2, y: p.y - MODULE_SIZE.height / 2 }, cardAt(e.clientX, e.clientY, '') ?? undefined)
  }

  const startMove = (e: ReactPointerEvent<HTMLDivElement>, kind: MoveState['kind'], id: string, at: Point) => {
    if (e.button !== 0) return
    e.stopPropagation()
    onSelect(kind === 'module' ? { kind: 'module', instanceId: id } : kind === 'board' ? { kind: 'board', boardInstanceId: id } : { kind: 'breadboard' })
    const p = toCanvasPoint(e.clientX, e.clientY)
    moveRef.current = { kind, id, origin: { x: at.x, y: at.y }, offsetX: p.x - at.x, offsetY: p.y - at.y, startX: p.x, startY: p.y, recorded: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const continueMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const move = moveRef.current
    if (!move) return
    const p = toCanvasPoint(e.clientX, e.clientY)
    // 실제로 움직이기 시작할 때 한 번만 실행 취소 기록을 남긴다 (클릭만으로는 기록하지 않음)
    if (!move.recorded) {
      if (Math.hypot(p.x - move.startX, p.y - move.startY) < 3) return
      move.recorded = true
      onCheckpoint()
    }
    const position = { x: p.x - move.offsetX, y: p.y - move.offsetY }
    if (move.kind === 'module') {
      onMoveModule(move.id, position)
      // 모터 카드를 드라이버 카드 위로 가져가면 연결할 수 있는지 미리 보여 준다
      const target = cardAt(e.clientX, e.clientY, move.id)
      const moving = placed.find((x) => x.instanceId === move.id)
      const movingModule = moving && getModule(moving.moduleId)
      const over = target ? placed.find((x) => x.instanceId === target) : undefined
      if (movingModule && (movingModule.motor || isServo(movingModule)) && over && getModule(over.moduleId).driver) {
        if (attach?.driverId !== over.instanceId) setAttach({ motorId: move.id, driverId: over.instanceId, plan: planMotorAttach(circuit, move.id, over.instanceId) })
      } else if (attach) setAttach(null)
    }
    else if (move.kind === 'board') onMoveBoard(move.id, position)
    else onMoveBreadboard(position)
  }

  const endMove = () => {
    const move = moveRef.current
    moveRef.current = null
    if (move && attach && attach.motorId === move.id) {
      if (!attach.plan.ok) onMoveModule(move.id, move.origin)
      onAttachMotor(attach.motorId, attach.driverId)
    }
    if (attach) setAttach(null)
  }

  /** 카드의 전원 필요 표시: 이 부품의 전원 핀에 아직 외부 전원이 없다 */
  const needOf = (instanceId: string): PowerNeed | undefined =>
    power.needs.find((n) => !n.servedBy && n.pins.some((k) => k.startsWith(`module:${instanceId}:`)))

  /** 끄는 전선을 받을 수 있는 부품 핀 역할 */
  const peerRole = wireDrag?.from.kind === 'module' ? PEER_ROLE[resolveModulePin(placed, wireDrag.from)?.pin.role ?? 'signal'] : undefined
  /** 끄는 핀이 핀 공유에 쓸 수 있는 종류면 같은 종류의 다른 부품 핀을 강조한다 */
  const shareDrag = wireDrag?.from.kind === 'module' ? roleOfKey(circuit, endpointKey(wireDrag.from)) : null
  const dragInstance = wireDrag?.from.kind === 'module' ? wireDrag.from.instanceId : null

  /** 보드 인스턴스별로 연결된 보드 핀 */
  const usedBoardPins = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const c of connections)
      for (const e of [c.from, c.to])
        if (e.kind === 'board') map.set(e.boardInstanceId, (map.get(e.boardInstanceId) ?? new Set()).add(e.pinId))
    return map
  }, [connections])

  /** 핀 끝을 옮기는 전선의 반대쪽 부품 핀 (보드 핀 강조용) */
  const gripPeer = useMemo((): Endpoint | null => {
    if (gripDrag?.grip.kind !== 'pin' || gripDrag.grip.endpoint.kind !== 'board') return null
    const moving = endpointKey(gripDrag.grip.endpoint)
    const c = connections.find((x) => x.id === gripDrag.grip.connectionIds[0])
    const other = c && (endpointKey(c.from) === moving ? c.to : c.from)
    return other?.kind === 'module' ? other : null
  }, [gripDrag, connections])

  // 모듈 핀에서 전선을 끄는 중이면 각 보드에서 연결 가능한 핀을 강조한다.
  const highlightFrom = wireDrag?.from.kind === 'module' ? wireDrag.from : gripPeer
  const highlight = useMemo(() => {
    if (!highlightFrom) return null
    const r = resolveModulePin(placed, highlightFrom)
    if (!r) return null
    return new Map(boards.map((b) => [b.instance.instanceId, new Set(compatiblePins(b.def, r.module, r.pin, r.placed))]))
  }, [highlightFrom, placed, boards])

  /** 구멍 끝을 끄는 중이면 놓을 구멍과 가능 여부. 새 전선을 구멍 위로 끌 때도 놓을 구멍을 보여 준다 */
  const holeTarget = useMemo(() => {
    if (gripDrag?.grip.kind === 'hole' && gripDrag.moved) {
      const hole = holeAt(gripDrag.pointer.x - breadboard.x, gripDrag.pointer.y - breadboard.y)
      return hole ? { hole, check: checkLeadMove(routing, gripDrag.grip.key, hole), pointer: gripDrag.pointer } : null
    }
    if (wireDrag?.moved) {
      const hole = holeAt(wireDrag.pointer.x - breadboard.x, wireDrag.pointer.y - breadboard.y)
      return hole ? { hole, check: { ok: true as const }, pointer: wireDrag.pointer } : null
    }
    return null
  }, [gripDrag, wireDrag, breadboard, routing])

  /** 고른 부품의 전선과 메인보드까지의 경로 */
  const focus = useMemo(() => {
    if (selection.kind !== 'module') return null
    const f = focusOf(circuit, selection.instanceId)
    const pins = new Map<string, Set<string>>()
    for (const key of f.boardPins) {
      const e = parseEndpointKey(key)
      if (e?.kind === 'board') pins.set(e.boardInstanceId, (pins.get(e.boardInstanceId) ?? new Set()).add(e.pinId))
    }
    return { lit: f.wires, path: f.path, pins }
  }, [selection, circuit])

  /** 전선 색 (전선과 핀 칩의 색 점이 같은 색을 쓴다) */
  const tones = useMemo(() => wireTones(connections, placed, routing), [connections, placed, routing])

  /** 가리키는 핀·전선과 고른 전선: 카드 위로 올려 보여 줄 전선과, 반대쪽 끝에서 함께 표시할 핀 */
  const selectedWire = selection.kind === 'connection' ? selection.connectionId : null
  const hoverView = useMemo(() => {
    const raised = new Set<string>()
    const ends = new Set<string>()
    if (hover && !wireDrag && !gripDrag) {
      const ids = hover.kind === 'wire' ? hover.ids : connections.filter((c) => endpointKey(c.from) === hover.key || endpointKey(c.to) === hover.key).map((c) => c.id)
      for (const c of connections) {
        if (!ids.includes(c.id)) continue
        raised.add(c.id)
        for (const e of [c.from, c.to]) if (hover.kind === 'wire' || endpointKey(e) !== hover.key) ends.add(endpointKey(e))
      }
    }
    const picked = selectedWire ? connections.find((c) => c.id === selectedWire) : undefined
    if (picked) {
      raised.add(picked.id)
      ends.add(endpointKey(picked.from))
      ends.add(endpointKey(picked.to))
    }
    return { raised, ends }
  }, [hover, wireDrag, gripDrag, connections, selectedWire])
  /** 보드마다 빛낼 핀: 고른 부품의 경로 끝 + 가리킨 전선의 끝 */
  const litBoardPins = (boardInstanceId: string) => {
    const pins = new Set(focus?.pins.get(boardInstanceId) ?? [])
    for (const key of hoverView.ends) {
      const e = parseEndpointKey(key)
      if (e?.kind === 'board' && e.boardInstanceId === boardInstanceId) pins.add(e.pinId)
    }
    return pins.size ? pins : undefined
  }
  /** 핀 칩 설명에 붙일 연결 상대 */
  const peersOf = (key: string) =>
    connections
      .filter((c) => endpointKey(c.from) === key || endpointKey(c.to) === key)
      .map((c) => describeEndpoint(endpointKey(c.from) === key ? c.to : c.from, circuit))

  const errorConnections = new Set(issues.filter((i) => i.severity === 'error' && i.connectionId).map((i) => i.connectionId!))
  const errorCount = (instanceId: string) =>
    issues.filter((i) => i.severity === 'error' && i.instanceId === instanceId).length

  const dragAnchor = wireDrag ? anchors[endpointKey(wireDrag.from)] : undefined
  const multi = boards.length > 1
  const first = boards[0]

  return (
    <section className="circuit-canvas" aria-label="회로 설계 작업 공간">
      <div className="circuit-canvas__scroll">
        <div
          ref={surfaceRef}
          className={`circuit-canvas__surface${wireDrag || gripDrag?.grip.kind === 'pin' ? ' is-wiring' : ''}${gripDrag ? ' is-gripping' : ''}`}
          style={{ width: CANVAS_SIZE.width, height: CANVAS_SIZE.height }}
          data-testid="canvas-surface"
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onPointerDown={() => {
            setPopover(null)
            onSelect({ kind: 'none' })
          }}
        >
          <WireLayer
            width={CANVAS_SIZE.width}
            height={CANVAS_SIZE.height}
            connections={connections}
            anchors={anchors}
            selectedId={selection.kind === 'connection' ? selection.connectionId : null}
            errorIds={errorConnections}
            resistors={resistors}
            wireStyle={wireStyle}
            routing={routing}
            breadboard={breadboard}
            dragging={gripDrag?.moved ? gripDrag.grip : null}
            focus={focus}
            tones={tones}
            raised={hoverView.raised}
            onHoverWire={(ids) => setHover(ids ? { kind: 'wire', ids } : null)}
            onDeleteWire={onDeleteWire}
            onPressWire={pressWire}
            onPressGrip={pressGrip}
          />

          <div
            className={`circuit-canvas__breadboard${selection.kind === 'breadboard' ? ' is-selected' : ''}${wireDrag ? ' is-drop-target' : ''}${route === 'breadboard' ? ' is-active' : ''}`}
            style={{ left: breadboard.x, top: breadboard.y, width: BREADBOARD_SIZE.width, height: BREADBOARD_SIZE.height }}
            role="button"
            tabIndex={0}
            aria-label="브레드보드"
            aria-pressed={selection.kind === 'breadboard'}
            data-breadboard
            data-testid="breadboard"
            onPointerDown={(e) => startMove(e, 'breadboard', 'breadboard', breadboard)}
            onPointerMove={continueMove}
            onPointerUp={endMove}
            onPointerCancel={endMove}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect({ kind: 'breadboard' })
              }
            }}
          >
            {/* SVG 는 앱이 데이터로부터 만든 문자열이며 모든 텍스트는 이스케이프되어 있다 */}
            <svg width={BREADBOARD_SIZE.width} height={BREADBOARD_SIZE.height} viewBox={`0 0 ${BREADBOARD_SIZE.width} ${BREADBOARD_SIZE.height}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: breadboardBody }} />
          </div>

          {boards.map(({ instance, def }) => (
            <div
              key={instance.instanceId}
              className="circuit-canvas__board"
              style={{ left: instance.x, top: instance.y }}
              data-board-instance={instance.instanceId}
              onPointerMove={continueMove}
              onPointerUp={endMove}
              onPointerCancel={endMove}
            >
              <BoardGraphic
                board={def}
                boardInstanceId={instance.instanceId}
                instanceLabel={multi ? instance.label : undefined}
                selected={selection.kind === 'board' && selection.boardInstanceId === instance.instanceId}
                usedPins={usedBoardPins.get(instance.instanceId) ?? new Set()}
                compatiblePins={highlight?.get(instance.instanceId) ?? null}
                litPins={litBoardPins(instance.instanceId)}
                onPinHover={(pinId) => setHover(pinId ? { kind: 'pin', key: `board:${instance.instanceId}:${pinId}` } : null)}
                onSelect={() => onSelect({ kind: 'board', boardInstanceId: instance.instanceId })}
                onBodyPointerDown={(e) => startMove(e, 'board', instance.instanceId, instance)}
                onPinPointerDown={(e, pinId) => startWire(e, { kind: 'board', boardInstanceId: instance.instanceId, pinId })}
              />
            </div>
          ))}

          {placed.map((item) => {
            const module = getModule(item.moduleId)
            const isSelected = selection.kind === 'module' && selection.instanceId === item.instanceId
            const needed = requiredPins(connections, item.instanceId, module)
            const done = needed.filter((p) => isPinConnected(connections, item.instanceId, p.id)).length
            const summary = sourceSummary(module, item)
            const errors = errorCount(item.instanceId)
            const host = multi ? boards.find((b) => b.instance.instanceId === item.hostBoardId)?.instance.label : undefined
            const usage = driverUsage(circuit, item)
            const need = needOf(item.instanceId)
            const needsDriver = !!module.motor && !motorDriverOf(circuit, item)
            const target = attach?.driverId === item.instanceId ? (attach.plan.ok ? ' is-attach-ok' : ' is-attach-bad') : ''
            return (
              <div
                key={item.instanceId}
                className={`placed-module${isSelected ? ' is-selected' : ''}${errors ? ' has-error' : ''}${module.pins.length > 6 ? ' placed-module--dense' : ''}${module.pins.length > 16 ? ' placed-module--xdense' : ''}${target}`}
                style={{ left: item.x, top: item.y, width: MODULE_SIZE.width, height: MODULE_SIZE.height }}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-label={item.label}
                data-instance-id={item.instanceId}
                onPointerDown={(e) => startMove(e, 'module', item.instanceId, item)}
                onPointerMove={continueMove}
                onPointerUp={endMove}
                onPointerCancel={endMove}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect({ kind: 'module', instanceId: item.instanceId })
                  }
                }}
              >
                <div className="placed-module__top">
                  <img src={assetUrl(module.icon)} alt="" draggable={false} />
                  <div className="placed-module__titles">
                    <span className="placed-module__label">{item.label}</span>
                    <span className={`placed-module__sub${done === needed.length ? ' is-done' : ''}`}>
                      {errors ? `오류 ${errors}개 · ` : ''}
                      {usage ? `${usage} · ` : ''}
                      {summary ?? `연결 ${done}/${needed.length}`}
                      {host ? ` · ${host}` : ''}
                    </span>
                  </div>
                </div>
                {(need || needsDriver) && (
                  <div className="card-badges">
                    {need && (
                      <button
                        type="button"
                        className="card-badge card-badge--power"
                        data-testid={`need-power-${item.instanceId}`}
                        title="외부 전원이 필요합니다. 눌러서 맞는 전원을 바로 연결하세요."
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          setPopover({ kind: 'power', instanceId: item.instanceId })
                        }}
                      >
                        ⚡ 전원 필요
                      </button>
                    )}
                    {needsDriver && (
                      <button
                        type="button"
                        className="card-badge card-badge--driver"
                        data-testid={`need-driver-${item.instanceId}`}
                        title="모터 드라이버가 필요합니다. 눌러서 드라이버를 추가하거나, 이 카드를 드라이버 카드에 끌어다 놓으세요."
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          setPopover({ kind: 'driver', instanceId: item.instanceId })
                        }}
                      >
                        드라이버 필요
                      </button>
                    )}
                  </div>
                )}
                <div className="placed-module__pins">
                  {module.pins.map((pin) => {
                    const connected = isPinConnected(connections, item.instanceId, pin.id)
                    const key = endpointKey(moduleEndpoint(item.instanceId, pin.id))
                    const share = shareOf(circuit, key)
                    const sharedAt = share ? shareBoardPin(circuit, share)?.pinId : undefined
                    const sharable = !!shareDrag && dragInstance !== item.instanceId && shareRole(module, pin) === shareDrag
                    const peers = connected ? peersOf(key) : []
                    const title =
                      (share
                        ? `${pin.name}: 핀 공유 그룹${sharedAt ? ` (${sharedAt})` : ''} — ${share.members.map((k) => placed.find((p) => k.startsWith(`module:${p.instanceId}:`))?.label ?? k).join(', ')}`
                        : `${pin.name}: ${pin.description} (끌어서 연결${shareRole(module, pin) ? ' · 같은 종류 부품 핀에 놓으면 핀 공유' : ''})`) +
                      (peers.length ? `\n연결: ${peers.join(', ')}` : '')
                    const wireColor = tones.ends.get(key)
                    return (
                      <span
                        key={pin.id}
                        className={`module-pin module-pin--${pin.role}${connected ? ' is-connected' : ''}${peerRole === pin.role || sharable ? ' is-compatible' : ''}${share ? ' is-shared' : ''}${wireColor ? ' has-wire' : ''}${hoverView.ends.has(key) ? ' is-wire-end' : ''}`}
                        style={wireColor ? ({ '--wire-color': wireColor } as CSSProperties) : undefined}
                        title={title}
                        data-endpoint={key}
                        data-dir={1}
                        onPointerDown={(e) => startWire(e, moduleEndpoint(item.instanceId, pin.id))}
                        onPointerEnter={() => setHover({ kind: 'pin', key })}
                        onPointerLeave={() => setHover(null)}
                      >
                        {pin.name.split(' ')[0]}
                      </span>
                    )
                  })}
                </div>
              </div>
            )
          })}

          {attach && (() => {
            const t = placed.find((x) => x.instanceId === attach.driverId)
            if (!t) return null
            return (
              <div className={`attach-tip${attach.plan.ok ? '' : ' is-bad'}`} style={{ left: t.x, top: t.y + MODULE_SIZE.height + 6 }} data-testid="attach-tip">
                {attach.plan.ok ? `놓으면 ${attach.plan.channel.label}에 연결 (${attach.plan.used}/${attach.plan.max})` : attach.plan.reason}
              </div>
            )
          })()}

          {popover && (() => {
            const item = placed.find((x) => x.instanceId === popover.instanceId)
            if (!item) return null
            const module = getModule(item.moduleId)
            const style = { left: Math.min(item.x + MODULE_SIZE.width + 10, CANVAS_SIZE.width - 320), top: item.y }
            const need = popover.kind === 'power' ? needOf(item.instanceId) : undefined
            const recommended = popover.kind === 'driver' ? recommendDriver(module) : null
            const ready = popover.kind === 'driver'
              ? placed.filter((d) => d !== item && getModule(d.moduleId).driver).map((d) => ({ d, plan: planMotorAttach(circuit, item.instanceId, d.instanceId) })).filter((x) => x.plan.ok)
              : []
            return (
              <div
                className="card-popover"
                style={style}
                role="dialog"
                aria-label={popover.kind === 'power' ? `${item.label} 외부 전원` : `${item.label} 모터 드라이버`}
                data-testid="card-popover"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <header className="card-popover__head">
                  <strong>{popover.kind === 'power' ? '외부 전원 연결' : '모터 드라이버 연결'}</strong>
                  <button type="button" className="card-popover__close" aria-label="닫기" onClick={() => setPopover(null)}>
                    ×
                  </button>
                </header>
                {popover.kind === 'power' ? (
                  need ? (
                    <NeedQuick
                      need={need}
                      onApply={(n, ex) => {
                        onApplySupply(n, ex)
                        setPopover(null)
                      }}
                      onMore={() => {
                        onShowPower()
                        setPopover(null)
                      }}
                    />
                  ) : (
                    <p className="muted small">외부 전원이 연결되었습니다.</p>
                  )
                ) : (
                  <div className="driver-quick">
                    {ready.map(({ d, plan }) => (
                      <button
                        key={d.instanceId}
                        type="button"
                        className="button button--small"
                        onClick={() => {
                          onAttachMotor(item.instanceId, d.instanceId)
                          setPopover(null)
                        }}
                      >
                        {d.label} {plan.ok ? plan.channel.label : ''}에 연결
                      </button>
                    ))}
                    {recommended && (
                      <button
                        type="button"
                        className="button button--small button--primary"
                        data-testid="add-driver"
                        onClick={() => {
                          onAddDriver(item.instanceId)
                          setPopover(null)
                        }}
                      >
                        {recommended.name} 추가하고 연결
                      </button>
                    )}
                    <p className="muted small">또는 이 모터 카드를 드라이버 카드 위로 끌어다 놓으면 빈 채널에 연결됩니다.</p>
                  </div>
                )}
              </div>
            )
          })()}

          {(gripDrag?.moved || (wireDrag?.moved && holeTarget)) && (
            <svg className="wire-layer wire-layer--overlay" width={CANVAS_SIZE.width} height={CANVAS_SIZE.height} aria-hidden="true">
              {gripDrag?.moved && <path className="wire-preview" d={wirePath(gripDrag.grip.fixed, { ...gripDrag.pointer, dir: -gripDrag.grip.fixed.dir })} />}
              {holeTarget && (() => {
                const box = nodeBox(holeTarget.hole)
                const at = holeXY(holeTarget.hole)
                const tone = holeTarget.check.ok ? 'is-ok' : 'is-bad'
                return (
                  <g className={`hole-target ${tone}`} data-testid="hole-target" data-ok={holeTarget.check.ok}>
                    <rect className="hole-target__node" x={breadboard.x + box.x} y={breadboard.y + box.y} width={box.width} height={box.height} rx={3} />
                    <rect className="hole-target__hole" x={breadboard.x + at.x - 4} y={breadboard.y + at.y - 4} width={8} height={8} rx={2} />
                  </g>
                )
              })()}
            </svg>
          )}
          {holeTarget && (
            <div
              className={`hole-tip${holeTarget.check.ok ? '' : ' is-bad'}`}
              style={{ left: holeTarget.pointer.x + 14, top: holeTarget.pointer.y + 14 }}
              data-testid="hole-tip"
            >
              <strong>{holeLabel(holeTarget.hole)}</strong>
              {!holeTarget.check.ok && <span>{holeTarget.check.reason}</span>}
            </div>
          )}

          {wireDrag && dragAnchor && (
            <svg className="wire-layer wire-layer--overlay" width={CANVAS_SIZE.width} height={CANVAS_SIZE.height} aria-hidden="true">
              <path className="wire-preview" d={wirePath(dragAnchor, { ...wireDrag.pointer, dir: -dragAnchor.dir })} />
            </svg>
          )}

          {placed.length === 0 && first && (
            <div
              className="circuit-canvas__empty"
              style={{ left: first.instance.x + first.def.footprint.width + 48, top: first.instance.y }}
            >
              <strong>작업 공간이 비어 있습니다</strong>
              <span>왼쪽 라이브러리에서 부품을 끌어다 놓거나 [추가] 버튼을 누르세요.</span>
            </div>
          )}
        </div>
      </div>
      {placed.length > 0 && (
        <p className="circuit-canvas__hint">
          {selection.kind === 'connection'
            ? '선택한 전선 끝의 동그라미를 끌어 다른 핀에 놓으면 그 핀으로 옮겨집니다. 브레드보드에 꽂힌 끝은 다른 구멍으로 옮길 수 있습니다.'
            : route === 'breadboard'
              ? '새 전선은 브레드보드를 거칩니다. 부품 핀을 보드 핀에 놓거나, 브레드보드에 놓으면 맞는 핀을 자동으로 고릅니다. 꽂힌 전선 끝은 끌어서 다른 구멍으로 옮길 수 있습니다.'
              : '부품의 핀을 끌어 보드 핀에 놓으면 바로 연결됩니다. 전선을 클릭하면 끝을 다른 핀으로 옮기거나 삭제할 수 있고, 보드와 부품은 끌어서 옮길 수 있습니다.'}
        </p>
      )}
    </section>
  )
}
