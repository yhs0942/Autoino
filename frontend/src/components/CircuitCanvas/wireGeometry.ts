import type { Point } from '../../types'

// 전선 경로 계산
// - curved    : 3차 베지어 곡선
// - orthogonal: 직각 배선. 전선마다 다른 "차선(lane)" 간격을 주어 평행한 전선이 겹치지 않게 한다.

export type WireStyle = 'curved' | 'orthogonal'

export interface Anchor extends Point {
  /** 전선이 핀에서 뻗어 나가는 방향 (위: -1, 아래: 1) */
  dir: number
}

export interface WireShape {
  d: string
  /** 저항 표시 등 라벨을 놓을 위치 */
  mid: Point
}

function curved(a: Anchor, b: Anchor): WireShape {
  const k = Math.max(40, Math.abs(b.y - a.y) / 2)
  const p1 = { x: a.x, y: a.y + a.dir * k }
  const p2 = { x: b.x, y: b.y + b.dir * k }
  return {
    d: `M ${a.x} ${a.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${b.x} ${b.y}`,
    mid: {
      x: 0.125 * a.x + 0.375 * p1.x + 0.375 * p2.x + 0.125 * b.x,
      y: 0.125 * a.y + 0.375 * p1.y + 0.375 * p2.y + 0.125 * b.y,
    },
  }
}

function orthogonal(a: Anchor, b: Anchor, lane: number): WireShape {
  const off = 18 + lane * 7
  const y1 = a.y + a.dir * off
  const y2 = b.y + b.dir * off
  if (a.dir === b.dir) {
    const y = a.dir > 0 ? Math.max(y1, y2) : Math.min(y1, y2)
    return { d: `M ${a.x} ${a.y} V ${y} H ${b.x} V ${b.y}`, mid: { x: (a.x + b.x) / 2, y } }
  }
  const mx = Math.round((a.x + b.x) / 2 + (lane - 4) * 7)
  return { d: `M ${a.x} ${a.y} V ${y1} H ${mx} V ${y2} H ${b.x} V ${b.y}`, mid: { x: mx, y: (y1 + y2) / 2 } }
}

export function wireShape(a: Anchor, b: Anchor, style: WireStyle = 'curved', lane = 0): WireShape {
  return style === 'orthogonal' ? orthogonal(a, b, lane % 8) : curved(a, b)
}

/** 끌고 있는 전선 미리보기 */
export function wirePath(a: Anchor, b: Anchor): string {
  return curved(a, b).d
}
