import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type { BbLead, BreadboardRouting } from '../../engine/breadboard'
import { holeDirection, holeXY, leadColors } from '../../engine/breadboardSvg'
import { endpointKey, parseEndpointKey, resolveModulePin } from '../../engine/connections'
import type { SeriesResistorResult } from '../../engine/resistor'
import { formatOhms } from '../../engine/resistor'
import type { Connection, Endpoint, PlacedModule, Point } from '../../types'
import { wireShape, type Anchor, type WireStyle } from './wireGeometry'

/** 끌어서 옮길 수 있는 전선 끝 */
export type Grip =
  /** 브레드보드 구멍에 꽂힌 끝 → 다른 구멍으로 */
  | { kind: 'hole'; key: string; connectionIds: string[]; fixed: Anchor }
  /** 핀에 물린 끝 → 다른 핀으로. fixed 는 움직이지 않는 반대쪽 끝 */
  | { kind: 'pin'; endpoint: Endpoint; connectionIds: string[]; fixed: Anchor }

interface WireLayerProps {
  width: number
  height: number
  connections: Connection[]
  placed: PlacedModule[]
  anchors: Record<string, Anchor>
  selectedId: string | null
  errorIds: Set<string>
  resistors: SeriesResistorResult[]
  wireStyle: WireStyle
  routing: BreadboardRouting
  breadboard: Point
  /** 끌고 있는 전선 끝 (그 전선은 흐리게 그린다) */
  dragging: Grip | null
  /** 고른 부품의 전선(lit)과 보드까지의 경로(path). 있으면 나머지 전선은 흐리게 그린다 */
  focus: { lit: Set<string>; path: Set<string> } | null
  onDeleteWire: (connectionId: string) => void
  onPressWire: (e: ReactPointerEvent, connectionId: string) => void
  onPressGrip: (e: ReactPointerEvent, grip: Grip) => void
}

function leadTone(lead: BbLead): string {
  return lead.kind === 'power' ? 'wire--power' : lead.kind === 'ground' ? 'wire--ground' : 'wire--lead'
}

/** 연결된 전선을 그린다. 보드 위·부품 아래에 그려지며 전선 자체를 클릭해 선택할 수 있다. */
export function WireLayer({ width, height, connections, placed, anchors, selectedId, errorIds, resistors, wireStyle, routing, breadboard, dragging, focus, onDeleteWire, onPressWire, onPressGrip }: WireLayerProps) {
  const focusTone = (ids: string[]) => (!focus ? '' : ids.some((id) => focus.lit.has(id)) ? 'is-lit' : ids.some((id) => focus.path.has(id)) ? 'is-path' : '')
  /** 선택한 전선 가운데에 놓을 삭제 단추 위치 (브레드보드 경유면 부품 쪽 전선의 가운데) */
  const deleteAt = (() => {
    const c = selectedId ? connections.find((x) => x.id === selectedId) : undefined
    if (!c) return null
    if (c.via !== 'breadboard') {
      const a = anchors[endpointKey(c.from)]
      const b = anchors[endpointKey(c.to)]
      return a && b ? wireShape(a, b, wireStyle, connections.indexOf(c)).mid : null
    }
    const leads = routing.leads.map((l, i) => ({ l, i })).filter(({ l }) => l.connectionIds.includes(c.id))
    const pick = leads.find(({ l }) => l.key.startsWith('module:')) ?? leads[0]
    const a = pick && anchors[pick.l.key]
    if (!pick || !a) return null
    const hole = holeXY(pick.l.hole)
    return wireShape(a, { x: breadboard.x + hole.x, y: breadboard.y + hole.y, dir: holeDirection(pick.l.hole) }, wireStyle, pick.i).mid
  })()
  let signalIndex = 0
  const colors = leadColors(routing)
  const grip = (g: Grip, at: Anchor, label: string, testId: string) => (
    <circle
      className={`wire__grip wire__grip--${g.kind}`}
      cx={at.x}
      cy={at.y}
      r={g.kind === 'hole' ? 6 : 8}
      data-testid={testId}
      aria-label={label}
      onPointerDown={(e: ReactPointerEvent) => onPressGrip(e, g)}
    >
      <title>{label}</title>
    </circle>
  )
  const draggingKey = dragging?.kind === 'hole' ? dragging.key : dragging ? endpointKey(dragging.endpoint) : null
  // 손잡이는 모든 전선 위에 그려야 다른 전선의 클릭 영역에 가려지지 않는다
  const grips: { g: Grip; at: Anchor; label: string; testId: string; style?: CSSProperties }[] = []
  return (
    <svg className={`wire-layer${focus ? ' has-focus' : ''}`} width={width} height={height} aria-hidden="true">
      {connections.map((c, index) => {
        if (c.via === 'breadboard') return null
        const a = anchors[endpointKey(c.from)]
        const b = anchors[endpointKey(c.to)]
        if (!a || !b) return null
        const role = [c.from, c.to].map((e) => resolveModulePin(placed, e)?.pin.role).find(Boolean) ?? 'signal'
        const tone = c.linkId ? 'link' : role === 'power' || role === 'source' ? 'power' : role === 'ground' ? 'ground' : `signal-${signalIndex++ % 6}`
        const shape = wireShape(a, b, wireStyle, index)
        const resistor = resistors.find(
          (r) => r.status === 'ok' && [c.from, c.to].some((e) => e.kind === 'module' && e.instanceId === r.instanceId && e.pinId === r.pinId),
        )
        const selected = c.id === selectedId
        const classes = ['wire', `wire--${tone}`, focusTone([c.id])]
        if (selected) classes.push('is-selected')
        if (errorIds.has(c.id)) classes.push('has-error')
        if (dragging?.connectionIds.includes(c.id)) classes.push('is-dragging')
        return (
          <g key={c.id} className={classes.join(' ')} data-connection-id={c.id}>
            <path className="wire__hit" d={shape.d} onPointerDown={(e: ReactPointerEvent) => onPressWire(e, c.id)} />
            <path className="wire__line" d={shape.d} />
            {resistor?.status === 'ok' && (
              <g className="wire__resistor" transform={`translate(${shape.mid.x} ${shape.mid.y})`}>
                <rect x={-26} y={-9} width={52} height={18} rx={4} />
                <text textAnchor="middle" dominantBaseline="central">
                  {formatOhms(resistor.choice.standardOhms).replace(' ', '')}
                </text>
              </g>
            )}
            {selected &&
              !c.linkId &&
              grips.push(
                { g: { kind: 'pin', endpoint: c.from, connectionIds: [c.id], fixed: b }, at: a, label: '이 끝을 끌어 다른 핀으로 옮기기', testId: 'grip-from' },
                { g: { kind: 'pin', endpoint: c.to, connectionIds: [c.id], fixed: a }, at: b, label: '이 끝을 끌어 다른 핀으로 옮기기', testId: 'grip-to' },
              ) && null}
          </g>
        )
      })}
      {routing.leads.map((lead, index) => {
        const a = anchors[lead.key]
        if (!a) return null
        const hole = holeXY(lead.hole)
        const b: Anchor = { x: breadboard.x + hole.x, y: breadboard.y + hole.y, dir: holeDirection(lead.hole) }
        const shape = wireShape(a, b, wireStyle, index)
        const selected = !!selectedId && lead.connectionIds.includes(selectedId)
        const classes = ['wire', leadTone(lead), focusTone(lead.connectionIds)]
        if (selected) classes.push('is-selected')
        if (lead.connectionIds.some((id) => errorIds.has(id))) classes.push('has-error')
        if (draggingKey === lead.key) classes.push('is-dragging')
        const style = lead.kind === 'signal' ? ({ '--wire-color': colors.get(lead.key) } as CSSProperties) : undefined
        const endpoint = parseEndpointKey(lead.key)
        return (
          <g key={lead.key} className={classes.join(' ')} style={style} data-connection-id={lead.connectionIds[0]} data-lead={lead.key}>
            <path className="wire__hit" d={shape.d} onPointerDown={(e: ReactPointerEvent) => onPressWire(e, lead.connectionIds[0])} />
            <path className="wire__line" d={shape.d} />
            <circle className="wire__end" cx={b.x} cy={b.y} r={3} />
            {grips.push({ g: { kind: 'hole', key: lead.key, connectionIds: lead.connectionIds, fixed: a }, at: b, label: '끌어서 다른 구멍으로 옮기기', testId: `grip-hole-${lead.key}`, style }) && null}
            {selected &&
              endpoint &&
              grips.push({ g: { kind: 'pin', endpoint, connectionIds: lead.connectionIds, fixed: b }, at: a, label: '이 끝을 끌어 다른 핀으로 옮기기', testId: `grip-pin-${lead.key}`, style }) &&
              null}
          </g>
        )
      })}
      <g className="wire-grips">
        {grips.map(({ g, at, label, testId, style }) => (
          <g key={testId} className={`wire ${g.kind === 'hole' ? 'wire--grip' : ''}`} style={style}>
            {grip(g, at, label, testId)}
          </g>
        ))}
        {selectedId && deleteAt && (
          <g
            className="wire-delete"
            transform={`translate(${deleteAt.x} ${deleteAt.y})`}
            data-testid="wire-delete"
            onPointerDown={(e: ReactPointerEvent) => e.stopPropagation()}
            onClick={() => onDeleteWire(selectedId)}
          >
            <title>이 전선 삭제 (Delete)</title>
            <circle r={10} />
            <path d="M -4 -4 L 4 4 M 4 -4 L -4 4" />
          </g>
        )}
      </g>
    </svg>
  )
}
