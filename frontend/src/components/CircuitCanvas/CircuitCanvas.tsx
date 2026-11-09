import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { getModule } from '../../data/modules'
import type { BreadboardRouting } from '../../engine/breadboard'
import { renderBreadboardBody } from '../../engine/breadboardSvg'
import { endpointKey, isPinConnected, moduleEndpoint, parseEndpointKey, requiredPins, resolveModulePin } from '../../engine/connections'
import { compatiblePins, sourceLimitMa, sourceVoltage } from '../../engine/electrical'
import { formatCurrent } from '../../engine/power'
import type { SeriesResistorResult } from '../../engine/resistor'
import type { Issue } from '../../engine/validate'
import type { Board, Connection, Endpoint, Module, ModulePinRole, PlacedBoard, PlacedModule, Point, RouteMode, Selection } from '../../types'
import { assetUrl } from '../../utils/assetUrl'
import { BREADBOARD_SIZE, CANVAS_SIZE, MODULE_SIZE } from '../../utils/placement'
import { MODULE_DRAG_TYPE } from '../ModuleLibrary/ModuleLibrary'
import { BoardGraphic } from './BoardGraphic'
import { WireLayer } from './WireLayer'
import { wirePath, type Anchor, type WireStyle } from './wireGeometry'
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
  selection: Selection
  issues: Issue[]
  resistors: SeriesResistorResult[]
  wireStyle: WireStyle
  /** 새 전선의 경로 */
  route: RouteMode
  routing: BreadboardRouting
  breadboard: Point
  onSelect: (selection: Selection) => void
  onDropModule: (moduleId: string, position: Point) => void
  onMoveModule: (instanceId: string, position: Point) => void
  onMoveBoard: (boardInstanceId: string, position: Point) => void
  onMoveBreadboard: (position: Point) => void
  /** 드래그가 실제로 시작되었을 때 (실행 취소 기록용) */
  onCheckpoint: () => void
  onConnect: (from: Endpoint, to: Endpoint) => void
  /** 전선을 브레드보드 위에 놓았을 때: 맞는 상대 핀을 자동으로 고른다 */
  onConnectAuto: (endpoint: Endpoint) => void
}

interface MoveState {
  kind: 'module' | 'board' | 'breadboard'
  id: string
  offsetX: number
  offsetY: number
  startX: number
  startY: number
  recorded: boolean
}

interface WireDrag {
  from: Endpoint
  start: Point
  current: Point
  moved: boolean
}

function sameAnchors(a: Record<string, Anchor>, b: Record<string, Anchor>): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => b[k] && a[k].x === b[k].x && a[k].y === b[k].y && a[k].dir === b[k].dir)
}

/** 전선 끝 등이 겹쳐 있어도 그 아래의 핀을 찾는다. */
function endpointAt(clientX: number, clientY: number): Endpoint | null {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const key = (el as HTMLElement).closest?.<HTMLElement>('[data-endpoint]')?.dataset.endpoint
    if (key) return parseEndpointKey(key)
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
  return volts === null ? null : `${volts} V${limit === null ? '' : ` · ${formatCurrent(limit)}`}`
}

export function CircuitCanvas({
  boards,
  placed,
  connections,
  selection,
  issues,
  resistors,
  wireStyle,
  route,
  routing,
  breadboard,
  onSelect,
  onDropModule,
  onMoveModule,
  onMoveBoard,
  onMoveBreadboard,
  onCheckpoint,
  onConnect,
  onConnectAuto,
}: CircuitCanvasProps) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const moveRef = useRef<MoveState | null>(null)
  const [anchors, setAnchors] = useState<Record<string, Anchor>>({})
  const [wireDrag, setWireDrag] = useState<WireDrag | null>(null)
  const [layoutTick, remeasure] = useReducer((n: number) => n + 1, 0)
  // 창 단위 리스너에서 최신 값을 읽기 위한 참조
  const wireDragRef = useRef<WireDrag | null>(null)
  const callbacksRef = useRef({ onConnect, onConnectAuto, onSelect })
  useLayoutEffect(() => {
    wireDragRef.current = wireDrag
    callbacksRef.current = { onConnect, onConnectAuto, onSelect }
  })
  const breadboardBody = useMemo(() => renderBreadboardBody(routing), [routing])
  const isWiring = wireDrag !== null

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
      next[el.dataset.endpoint!] = {
        x: Math.round(r.left - origin.left + r.width / 2),
        y: Math.round(r.top - origin.top + r.height / 2),
        dir: Number(el.dataset.dir ?? 1),
      }
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
      setWireDrag((d) => d && { ...d, current: p, moved: d.moved || Math.hypot(p.x - d.start.x, p.y - d.start.y) > 4 })
    }
    const onUp = (e: PointerEvent) => {
      const drag = wireDragRef.current
      setWireDrag(null)
      if (!drag) return
      const { onConnect, onConnectAuto, onSelect } = callbacksRef.current
      const to = endpointAt(e.clientX, e.clientY)
      if (to && endpointKey(to) !== endpointKey(drag.from)) {
        onConnect(drag.from, to)
        return
      }
      if (drag.moved && isOverBreadboard(e.clientX, e.clientY)) {
        onConnectAuto(drag.from)
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
    setWireDrag({ from, start: p, current: p, moved: false })
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
    onDropModule(moduleId, { x: p.x - MODULE_SIZE.width / 2, y: p.y - MODULE_SIZE.height / 2 })
  }

  const startMove = (e: ReactPointerEvent<HTMLDivElement>, kind: MoveState['kind'], id: string, at: Point) => {
    if (e.button !== 0) return
    e.stopPropagation()
    onSelect(kind === 'module' ? { kind: 'module', instanceId: id } : kind === 'board' ? { kind: 'board', boardInstanceId: id } : { kind: 'breadboard' })
    const p = toCanvasPoint(e.clientX, e.clientY)
    moveRef.current = { kind, id, offsetX: p.x - at.x, offsetY: p.y - at.y, startX: p.x, startY: p.y, recorded: false }
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
    if (move.kind === 'module') onMoveModule(move.id, position)
    else if (move.kind === 'board') onMoveBoard(move.id, position)
    else onMoveBreadboard(position)
  }

  const endMove = () => {
    moveRef.current = null
  }

  /** 끄는 전선을 받을 수 있는 부품 핀 역할 */
  const peerRole = wireDrag?.from.kind === 'module' ? PEER_ROLE[resolveModulePin(placed, wireDrag.from)?.pin.role ?? 'signal'] : undefined

  /** 보드 인스턴스별로 연결된 보드 핀 */
  const usedBoardPins = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const c of connections)
      for (const e of [c.from, c.to])
        if (e.kind === 'board') map.set(e.boardInstanceId, (map.get(e.boardInstanceId) ?? new Set()).add(e.pinId))
    return map
  }, [connections])

  // 모듈 핀에서 전선을 끄는 중이면 각 보드에서 연결 가능한 핀을 강조한다.
  const highlight = useMemo(() => {
    if (!wireDrag || wireDrag.from.kind !== 'module') return null
    const r = resolveModulePin(placed, wireDrag.from)
    if (!r) return null
    return new Map(boards.map((b) => [b.instance.instanceId, new Set(compatiblePins(b.def, r.module, r.pin, r.placed))]))
  }, [wireDrag, placed, boards])

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
          className={`circuit-canvas__surface${wireDrag ? ' is-wiring' : ''}`}
          style={{ width: CANVAS_SIZE.width, height: CANVAS_SIZE.height }}
          data-testid="canvas-surface"
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onPointerDown={() => onSelect({ kind: 'none' })}
        >
          <WireLayer
            width={CANVAS_SIZE.width}
            height={CANVAS_SIZE.height}
            connections={connections}
            placed={placed}
            anchors={anchors}
            selectedId={selection.kind === 'connection' ? selection.connectionId : null}
            errorIds={errorConnections}
            resistors={resistors}
            wireStyle={wireStyle}
            routing={routing}
            breadboard={breadboard}
            onPressWire={pressWire}
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
            return (
              <div
                key={item.instanceId}
                className={`placed-module${isSelected ? ' is-selected' : ''}${errors ? ' has-error' : ''}${module.pins.length > 6 ? ' placed-module--dense' : ''}`}
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
                      {summary ?? `연결 ${done}/${needed.length}`}
                      {host ? ` · ${host}` : ''}
                    </span>
                  </div>
                </div>
                <div className="placed-module__pins">
                  {module.pins.map((pin) => {
                    const connected = isPinConnected(connections, item.instanceId, pin.id)
                    return (
                      <span
                        key={pin.id}
                        className={`module-pin module-pin--${pin.role}${connected ? ' is-connected' : ''}${peerRole === pin.role ? ' is-compatible' : ''}`}
                        title={`${pin.name}: ${pin.description} (끌어서 연결)`}
                        data-endpoint={endpointKey(moduleEndpoint(item.instanceId, pin.id))}
                        data-dir={1}
                        onPointerDown={(e) => startWire(e, moduleEndpoint(item.instanceId, pin.id))}
                      >
                        {pin.name.split(' ')[0]}
                      </span>
                    )
                  })}
                </div>
              </div>
            )
          })}

          {wireDrag && dragAnchor && (
            <svg className="wire-layer wire-layer--overlay" width={CANVAS_SIZE.width} height={CANVAS_SIZE.height} aria-hidden="true">
              <path className="wire-preview" d={wirePath(dragAnchor, { ...wireDrag.current, dir: -dragAnchor.dir })} />
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
          {route === 'breadboard'
            ? '새 전선은 브레드보드를 거칩니다. 부품 핀을 보드 핀에 놓거나, 브레드보드에 놓으면 맞는 핀을 자동으로 고릅니다.'
            : '부품의 핀을 끌어 보드 핀에 놓으면 바로 연결됩니다. 전선을 클릭하면 선택·삭제할 수 있고, 보드와 부품은 끌어서 옮길 수 있습니다.'}
        </p>
      )}
    </section>
  )
}
