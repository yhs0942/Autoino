import { useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { EMPTY_ROUTING } from '../../engine/breadboard'
import { renderBreadboardBody } from '../../engine/breadboardSvg'
import type { CircuitDocument } from '../../state/circuitState'
import type { Board, Point, Selection } from '../../types'
import { assetUrl } from '../../utils/assetUrl'
import { BREADBOARD_SIZE, CANVAS_SIZE } from '../../utils/placement'
import { LAYOUT_SCALE, layoutItems, type LayoutItem } from './layoutItems'
import { usePanZoom } from '../common/usePanZoom'
import { ZoomControls } from '../common/ZoomControls'
import './LayoutView.css'

// 실물 배치 모드: 전선과 설명 없이 보드·부품을 실제 상대 크기로 보여 주고, 끌어서 자리를 잡는다.
// 위치는 배선도와 따로 저장한다 (document.layout).

interface LayoutViewProps {
  doc: Pick<CircuitDocument, 'boards' | 'placed' | 'breadboard' | 'layout'>
  selection: Selection
  onSelect: (selection: Selection) => void
  onMove: (id: string, position: Point) => void
  onCheckpoint: () => void
}

/** 보드 실루엣: 기판, 핀 헤더, USB 단자, 칩 (글자 없음) */
function BoardShape({ board, width, height }: { board: Board | undefined; width: number; height: number }) {
  const esp = board?.core === 'arduino-esp32'
  const narrow = height / width < 0.5
  const pcb = esp ? '#1f2937' : '#0e7490'
  const header = '#111827'
  const s = LAYOUT_SCALE
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <rect x={0.5} y={0.5} width={width - 1} height={height - 1} rx={2 * s} fill={pcb} stroke="#0f172a" />
      {narrow ? (
        <>
          <rect x={4 * s} y={1 * s} width={width - 8 * s} height={2.5 * s} rx={0.5 * s} fill={header} />
          <rect x={4 * s} y={height - 3.5 * s} width={width - 8 * s} height={2.5 * s} rx={0.5 * s} fill={header} />
        </>
      ) : (
        <>
          <rect x={18 * s} y={1 * s} width={width - 22 * s} height={2.5 * s} rx={0.5 * s} fill={header} />
          <rect x={26 * s} y={height - 3.5 * s} width={width - 30 * s} height={2.5 * s} rx={0.5 * s} fill={header} />
          <circle cx={14 * s} cy={2.5 * s} r={1.6 * s} fill="#e5e7eb" />
          <circle cx={width - 4 * s} cy={height - 8 * s} r={1.6 * s} fill="#e5e7eb" />
        </>
      )}
      {/* USB 단자 */}
      <rect x={-1 * s} y={narrow ? height / 2 - 4 * s : 8 * s} width={(esp || narrow ? 6 : 16) * s} height={(narrow ? 8 : 12) * s} rx={s} fill="#cbd5e1" stroke="#64748b" />
      {/* 마이크로컨트롤러 */}
      <rect x={width / 2 - (esp ? 9 : 6) * s} y={height / 2 - (esp ? 9 : 4) * s} width={(esp ? 18 : 12) * s} height={(esp ? 18 : 8) * s} rx={esp ? s : 0.5 * s} fill={esp ? '#9ca3af' : '#0f172a'} />
    </svg>
  )
}

export function LayoutView({ doc, selection, onSelect, onMove, onCheckpoint }: LayoutViewProps) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const view = usePanZoom(scrollRef)
  const dragRef = useRef<{ id: string; dx: number; dy: number; sx: number; sy: number; recorded: boolean } | null>(null)
  const items = layoutItems(doc)
  const breadboardBody = useMemo(() => renderBreadboardBody(EMPTY_ROUTING), [])

  const point = (e: ReactPointerEvent) => {
    const surface = surfaceRef.current!
    const r = surface.getBoundingClientRect()
    const scale = r.width / surface.offsetWidth || 1
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }
  }
  const selected = (item: LayoutItem) =>
    (selection.kind === 'module' && selection.instanceId === item.id) ||
    (selection.kind === 'board' && selection.boardInstanceId === item.id) ||
    (selection.kind === 'breadboard' && item.kind === 'breadboard')
  const select = (item: LayoutItem) =>
    onSelect(item.kind === 'module' ? { kind: 'module', instanceId: item.id } : item.kind === 'board' ? { kind: 'board', boardInstanceId: item.id } : { kind: 'breadboard' })

  const start = (e: ReactPointerEvent<HTMLDivElement>, item: LayoutItem) => {
    if (e.button !== 0) return
    e.stopPropagation()
    select(item)
    const p = point(e)
    dragRef.current = { id: item.id, dx: p.x - item.x, dy: p.y - item.y, sx: p.x, sy: p.y, recorded: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: ReactPointerEvent<HTMLDivElement>, item: LayoutItem) => {
    const d = dragRef.current
    if (!d || d.id !== item.id) return
    const p = point(e)
    if (!d.recorded) {
      if (Math.hypot(p.x - d.sx, p.y - d.sy) < 3) return
      d.recorded = true
      onCheckpoint()
    }
    onMove(item.id, {
      x: Math.round(Math.min(Math.max(0, p.x - d.dx), CANVAS_SIZE.width - item.width)),
      y: Math.round(Math.min(Math.max(0, p.y - d.dy), CANVAS_SIZE.height - item.height)),
    })
  }
  const end = () => {
    dragRef.current = null
  }

  // 큰 것(보드·브레드보드)을 먼저 그려 작은 부품이 위에 오게 한다
  const ordered = [...items].sort((a, b) => b.width * b.height - a.width * a.height)
  return (
    <section className="layout-view" aria-label="실물 배치 작업 공간">
      <ZoomControls view={view} />
      <div ref={scrollRef} className={`layout-view__scroll is-pannable${view.panning ? ' is-panning' : ''}`}>
        <div className="zoom-box" style={{ width: CANVAS_SIZE.width * view.zoom, height: CANVAS_SIZE.height * view.zoom }}>
        <div
          ref={surfaceRef}
          className="layout-view__surface"
          style={{
            width: CANVAS_SIZE.width,
            height: CANVAS_SIZE.height,
            backgroundSize: `${10 * LAYOUT_SCALE}px ${10 * LAYOUT_SCALE}px`,
            ...(view.zoom !== 1 ? { transform: `scale(${view.zoom})`, transformOrigin: '0 0' } : {}),
          }}
          data-testid="layout-surface"
          // 바탕을 끌면 화면 이동, 끌지 않고 떼면 선택 해제
          onPointerDown={(e) => view.startPan(e, () => onSelect({ kind: 'none' }))}
        >
          {ordered.map((item) => (
            <div
              key={item.id}
              className={`layout-item layout-item--${item.kind}${selected(item) ? ' is-selected' : ''}`}
              style={{ left: item.x, top: item.y, width: item.width, height: item.height }}
              title={`${item.label} · 약 ${item.sizeMm.width} × ${item.sizeMm.height} mm`}
              aria-label={item.label}
              role="button"
              tabIndex={0}
              data-layout-id={item.id}
              onPointerDown={(e) => start(e, item)}
              onPointerMove={(e) => move(e, item)}
              onPointerUp={end}
              onPointerCancel={end}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  select(item)
                }
              }}
            >
              {item.kind === 'module' && item.icon && <img src={assetUrl(item.icon)} alt="" draggable={false} />}
              {item.kind === 'board' && <BoardShape board={item.board} width={item.width} height={item.height} />}
              {item.kind === 'breadboard' && (
                // SVG 는 앱이 만든 문자열이다 (브레드보드 구멍 그림)
                <svg width={item.width} height={item.height} viewBox={`0 0 ${BREADBOARD_SIZE.width} ${BREADBOARD_SIZE.height}`} preserveAspectRatio="none" aria-hidden="true" dangerouslySetInnerHTML={{ __html: breadboardBody }} />
              )}
            </div>
          ))}
          <div className="layout-view__scale" aria-hidden="true">
            <span style={{ width: 10 * LAYOUT_SCALE }} />
            10 mm
          </div>
        </div>
        </div>
      </div>
      <p className="circuit-canvas__hint">
        실물 배치: 보드와 부품을 대표 실물 크기(mm)의 같은 비율로 보여 줍니다. 끌어서 자리를 잡으세요. 이 위치는 배선도와 따로 저장됩니다. 실제 제품마다 크기가 조금씩 다릅니다.
      </p>
    </section>
  )
}
