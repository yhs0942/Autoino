import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type { BreadboardRouting } from '../../engine/breadboard'
import { holeDirection, holeXY } from '../../engine/breadboardSvg'
import { endpointKey, parseEndpointKey } from '../../engine/connections'
import type { SeriesResistorResult } from '../../engine/resistor'
import { formatOhms } from '../../engine/resistor'
import type { Connection, Endpoint, Point } from '../../types'
import { routeWires, type Anchor, type WireShape, type WireSpec, type WireStyle } from './wireGeometry'
import type { WireTones } from './wireTones'

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
  anchors: Record<string, Anchor>
  selectedId: string | null
  errorIds: Set<string>
  resistors: SeriesResistorResult[]
  wireStyle: WireStyle
  routing: BreadboardRouting
  breadboard: Point
  tones: WireTones
  /** 부품 카드 위로 올려 끝까지 보여 줄 전선 (가리킨 핀·전선, 고른 전선) */
  raised: Set<string>
  /** 끌고 있는 전선 끝 (그 전선은 흐리게 그린다) */
  dragging: Grip | null
  /** 고른 부품의 전선(lit)과 보드까지의 경로(path). 있으면 나머지 전선은 흐리게 그린다 */
  focus: { lit: Set<string>; path: Set<string> } | null
  onDeleteWire: (connectionId: string) => void
  onPressWire: (e: ReactPointerEvent, connectionId: string) => void
  onPressGrip: (e: ReactPointerEvent, grip: Grip) => void
  /** 전선 위에 포인터가 올라가거나(연결 ID 들) 벗어날 때(null) */
  onHoverWire: (connectionIds: string[] | null) => void
}

const leadId = (key: string) => `lead:${key}`

/**
 * 연결된 전선을 그린다. 전선은 보드 위·부품 카드 아래에 그려지고, 가리키거나 고른 전선은 카드 위에 한 번 더 그려
 * 어느 핀 칩에 물렸는지 끝까지 보이게 한다.
 */
export function WireLayer({ width, height, connections, anchors, selectedId, errorIds, resistors, wireStyle, routing, breadboard, tones, raised, dragging, focus, onDeleteWire, onPressWire, onPressGrip, onHoverWire }: WireLayerProps) {
  const focusTone = (ids: string[]) => (!focus ? '' : ids.some((id) => focus.lit.has(id)) ? 'is-lit' : ids.some((id) => focus.path.has(id)) ? 'is-path' : '')
  const holeAnchor = (lead: BreadboardRouting['leads'][number]): Anchor => {
    const hole = holeXY(lead.hole)
    return { x: breadboard.x + hole.x, y: breadboard.y + hole.y, dir: holeDirection(lead.hole) }
  }

  // 모든 전선을 한꺼번에 경로 계산해야 같은 카드 가장자리 출구를 서로 벌릴 수 있다
  const specs: WireSpec[] = []
  connections.forEach((c, index) => {
    if (c.via === 'breadboard') return
    const a = anchors[endpointKey(c.from)]
    const b = anchors[endpointKey(c.to)]
    if (a && b) specs.push({ id: c.id, a, b, lane: index })
  })
  routing.leads.forEach((lead, index) => {
    const a = anchors[lead.key]
    if (a) specs.push({ id: leadId(lead.key), a, b: holeAnchor(lead), lane: index })
  })
  const shapes = routeWires(specs, wireStyle)

  /** 선택한 전선 가운데에 놓을 삭제 단추 위치 (브레드보드 경유면 부품 쪽 전선의 가운데) */
  const deleteAt = (() => {
    const c = selectedId ? connections.find((x) => x.id === selectedId) : undefined
    if (!c) return null
    if (c.via !== 'breadboard') return shapes.get(c.id)?.mid ?? null
    const leads = routing.leads.filter((l) => l.connectionIds.includes(c.id))
    const pick = leads.find((l) => l.key.startsWith('module:')) ?? leads[0]
    return (pick && shapes.get(leadId(pick.key))?.mid) ?? null
  })()

  const draggingKey = dragging?.kind === 'hole' ? dragging.key : dragging ? endpointKey(dragging.endpoint) : null
  // 손잡이는 모든 전선 위에 그려야 다른 전선의 클릭 영역에 가려지지 않는다
  const holeGrips: { g: Grip; at: Point; label: string; testId: string; style?: CSSProperties }[] = []
  const pinGrips: { g: Grip; at: Point; label: string; testId: string; style?: CSSProperties }[] = []
  /** 카드 위에 다시 그릴 전선 */
  const lifted: { id: string; shape: WireShape; className: string; style?: CSSProperties; tips: Point[] }[] = []
  const tipsOf = (shape: WireShape, ends: (string | undefined)[]) =>
    [shape.points[0], shape.points[shape.points.length - 1]].filter((_, i) => ends[i]?.startsWith('module:'))

  const grip = (g: Grip, at: Point, label: string, testId: string) => (
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
  const hover = (ids: string[]) => ({
    onPointerEnter: () => onHoverWire(ids),
    onPointerLeave: () => onHoverWire(null),
  })

  const base = (
    <svg className={`wire-layer${focus ? ' has-focus' : ''}`} width={width} height={height} aria-hidden="true">
      {connections.map((c) => {
        if (c.via === 'breadboard') return null
        const shape = shapes.get(c.id)
        if (!shape) return null
        const a = anchors[endpointKey(c.from)]
        const b = anchors[endpointKey(c.to)]
        const tone = tones.wires.get(c.id)
        const resistor = resistors.find(
          (r) => r.status === 'ok' && [c.from, c.to].some((e) => e.kind === 'module' && e.instanceId === r.instanceId && e.pinId === r.pinId),
        )
        const selected = c.id === selectedId
        const classes = ['wire', tone?.className ?? 'wire--signal-0', focusTone([c.id])]
        if (selected) classes.push('is-selected')
        if (errorIds.has(c.id)) classes.push('has-error')
        if (dragging?.connectionIds.includes(c.id)) classes.push('is-dragging')
        if (raised.has(c.id)) lifted.push({ id: c.id, shape, className: classes.join(' '), tips: tipsOf(shape, [endpointKey(c.from), endpointKey(c.to)]) })
        if (selected && !c.linkId)
          pinGrips.push(
            { g: { kind: 'pin', endpoint: c.from, connectionIds: [c.id], fixed: b }, at: shape.points[0], label: '이 끝을 끌어 다른 핀으로 옮기기', testId: 'grip-from' },
            { g: { kind: 'pin', endpoint: c.to, connectionIds: [c.id], fixed: a }, at: shape.points[shape.points.length - 1], label: '이 끝을 끌어 다른 핀으로 옮기기', testId: 'grip-to' },
          )
        return (
          <g key={c.id} className={classes.join(' ')} data-connection-id={c.id}>
            <path className="wire__hit" d={shape.d} onPointerDown={(e: ReactPointerEvent) => onPressWire(e, c.id)} {...hover([c.id])} />
            <path className="wire__line" d={shape.d} />
            {resistor?.status === 'ok' && (
              <g className="wire__resistor" transform={`translate(${shape.mid.x} ${shape.mid.y})`}>
                <rect x={-26} y={-9} width={52} height={18} rx={4} />
                <text textAnchor="middle" dominantBaseline="central">
                  {formatOhms(resistor.choice.standardOhms).replace(' ', '')}
                </text>
              </g>
            )}
          </g>
        )
      })}
      {routing.leads.map((lead) => {
        const shape = shapes.get(leadId(lead.key))
        if (!shape) return null
        const b = holeAnchor(lead)
        const tone = tones.leads.get(lead.key)
        const selected = !!selectedId && lead.connectionIds.includes(selectedId)
        const classes = ['wire', tone?.className ?? 'wire--lead', focusTone(lead.connectionIds)]
        if (selected) classes.push('is-selected')
        if (lead.connectionIds.some((id) => errorIds.has(id))) classes.push('has-error')
        if (draggingKey === lead.key) classes.push('is-dragging')
        const style = lead.kind === 'signal' ? ({ '--wire-color': tone?.color } as CSSProperties) : undefined
        const endpoint = parseEndpointKey(lead.key)
        if (lead.connectionIds.some((id) => raised.has(id))) lifted.push({ id: leadId(lead.key), shape, className: classes.join(' '), style, tips: tipsOf(shape, [lead.key]) })
        holeGrips.push({ g: { kind: 'hole', key: lead.key, connectionIds: lead.connectionIds, fixed: anchors[lead.key] }, at: b, label: '끌어서 다른 구멍으로 옮기기', testId: `grip-hole-${lead.key}`, style })
        if (selected && endpoint)
          pinGrips.push({ g: { kind: 'pin', endpoint, connectionIds: lead.connectionIds, fixed: b }, at: shape.points[0], label: '이 끝을 끌어 다른 핀으로 옮기기', testId: `grip-pin-${lead.key}`, style })
        return (
          <g key={lead.key} className={classes.join(' ')} style={style} data-connection-id={lead.connectionIds[0]} data-lead={lead.key}>
            <path className="wire__hit" d={shape.d} onPointerDown={(e: ReactPointerEvent) => onPressWire(e, lead.connectionIds[0])} {...hover(lead.connectionIds)} />
            <path className="wire__line" d={shape.d} />
            <circle className="wire__end" cx={b.x} cy={b.y} r={3} />
          </g>
        )
      })}
      <g className="wire-grips">
        {holeGrips.map(({ g, at, label, testId, style }) => (
          <g key={testId} className="wire wire--grip" style={style}>
            {grip(g, at, label, testId)}
          </g>
        ))}
      </g>
    </svg>
  )

  return (
    <>
      {base}
      {/* 카드 위: 가리키거나 고른 전선을 핀 칩까지 보여 주고, 핀 쪽 손잡이와 삭제 단추를 둔다 */}
      <svg className="wire-layer wire-layer--raised" width={width} height={height} aria-hidden="true" data-testid="wire-raised">
        {lifted.map(({ id, shape, className, style, tips }) => (
          <g key={id} className={`${className} is-raised`} style={style} data-raised={id}>
            <path className="wire__line" d={shape.outer} />
            {shape.inner.map((d, i) => (
              <path key={i} className="wire__inner" d={d} />
            ))}
            {tips.map((p, i) => (
              <circle key={i} className="wire__tip" cx={p.x} cy={p.y} r={3.5} />
            ))}
          </g>
        ))}
        {pinGrips.map(({ g, at, label, testId, style }) => (
          <g key={testId} className="wire" style={style}>
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
      </svg>
    </>
  )
}
