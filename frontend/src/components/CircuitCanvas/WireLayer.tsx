import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type { BbLead, BreadboardRouting } from '../../engine/breadboard'
import { holeDirection, holeXY, leadColors } from '../../engine/breadboardSvg'
import { endpointKey, resolveModulePin } from '../../engine/connections'
import type { SeriesResistorResult } from '../../engine/resistor'
import { formatOhms } from '../../engine/resistor'
import type { Connection, PlacedModule, Point } from '../../types'
import { wireShape, type Anchor, type WireStyle } from './wireGeometry'

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
  onPressWire: (e: ReactPointerEvent, connectionId: string) => void
}

function leadTone(lead: BbLead): string {
  return lead.kind === 'power' ? 'wire--power' : lead.kind === 'ground' ? 'wire--ground' : 'wire--lead'
}

/** 연결된 전선을 그린다. 보드 위·부품 아래에 그려지며 전선 자체를 클릭해 선택할 수 있다. */
export function WireLayer({ width, height, connections, placed, anchors, selectedId, errorIds, resistors, wireStyle, routing, breadboard, onPressWire }: WireLayerProps) {
  let signalIndex = 0
  const colors = leadColors(routing)
  return (
    <svg className="wire-layer" width={width} height={height} aria-hidden="true">
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
        const classes = ['wire', `wire--${tone}`]
        if (c.id === selectedId) classes.push('is-selected')
        if (errorIds.has(c.id)) classes.push('has-error')
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
          </g>
        )
      })}
      {routing.leads.map((lead, index) => {
        const a = anchors[lead.key]
        if (!a) return null
        const hole = holeXY(lead.hole)
        const b: Anchor = { x: breadboard.x + hole.x, y: breadboard.y + hole.y, dir: holeDirection(lead.hole) }
        const shape = wireShape(a, b, wireStyle, index)
        const classes = ['wire', leadTone(lead)]
        if (selectedId && lead.connectionIds.includes(selectedId)) classes.push('is-selected')
        if (lead.connectionIds.some((id) => errorIds.has(id))) classes.push('has-error')
        const style = lead.kind === 'signal' ? ({ '--wire-color': colors.get(lead.key) } as CSSProperties) : undefined
        return (
          <g key={lead.key} className={classes.join(' ')} style={style} data-connection-id={lead.connectionIds[0]} data-lead={lead.key}>
            <path className="wire__hit" d={shape.d} onPointerDown={(e: ReactPointerEvent) => onPressWire(e, lead.connectionIds[0])} />
            <path className="wire__line" d={shape.d} />
            <circle className="wire__end" cx={b.x} cy={b.y} r={3} />
          </g>
        )
      })}
    </svg>
  )
}
