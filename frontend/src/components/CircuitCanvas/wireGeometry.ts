import type { Point } from '../../types'

// 전선 경로 계산
// - curved    : 3차 베지어 곡선
// - orthogonal: 직각 배선. 꼭 필요한 만큼만 꺾는다 (마주 보면 Z자 2번, 같은 쪽을 보면 ㄷ자 2번, 등지면 4번).
//
// 부품 카드의 핀 칩에서 나오는 전선은 반대쪽 끝을 향한 카드 가장자리(위·아래)로 나간다.
// 칩에서 가장자리까지는 카드 밑에 가려지므로, 같은 가장자리로 나가는 전선들은 가장자리에서 서로 다른 자리(출구)로
// 벌려 놓아 겹치지 않게 한다. 출구는 칩의 가로 위치 순서를 따른다.

export type WireStyle = 'curved' | 'orthogonal'

/** 부품 카드의 위치 (캔버스 좌표) */
export interface CardBox {
  id: string
  left: number
  top: number
  right: number
  bottom: number
}

export interface Anchor extends Point {
  /** 전선이 핀에서 뻗어 나가는 방향 (위: -1, 아래: 1). 카드 안의 칩이면 반대쪽 끝에 따라 다시 정한다 */
  dir: number
  /** 핀 칩 높이의 절반. 전선을 칩 가장자리에서 시작해 핀 이름을 가리지 않게 한다 */
  half?: number
  /** 핀이 부품 카드 안에 있으면 그 카드 */
  card?: CardBox
}

export interface WireShape {
  d: string
  /** 저항 표시·삭제 단추를 놓을 위치 */
  mid: Point
  /** 경로의 꼭짓점 (곡선이면 대략의 점) */
  points: Point[]
  /** 양 끝이 카드에서 나오는 자리 (카드가 아니면 핀 위치) */
  exit: [Point, Point]
  /** 카드 밖 구간 (출구에서 출구까지) */
  outer: string
  /** 카드 안 구간 (칩에서 출구까지). 카드 위에 올려 그릴 때 다른 칩 이름을 가리지 않게 얇게 그린다 */
  inner: string[]
}

export interface WireSpec {
  id: string
  a: Anchor
  b: Anchor
  /** 평행한 전선이 겹치지 않게 주는 차선 번호 */
  lane: number
}

/** 카드 가장자리 출구 사이 최소 간격 */
const PORT_GAP = 8
/** 출구가 카드 모서리에 붙지 않게 두는 여백 */
const PORT_PAD = 6
/** 카드 가장자리 안쪽에서 출구로 옆걸음하는 깊이 (카드에 가려진다) */
const INSET = 3
/** 이 정도로 가로 위치가 같으면 곧게 잇는다 */
const STRAIGHT = 3

/** 카드 안 칩이 반대쪽 끝을 향해 나갈 방향 */
function faceDir(a: Anchor, b: Anchor): number {
  if (!a.card) return a.dir
  const top = b.card ? b.card.top : b.y
  const bottom = b.card ? b.card.bottom : b.y
  if (top >= a.card.bottom) return 1
  if (bottom <= a.card.top) return -1
  // 옆에 나란히 있으면 반대쪽과 같은 방향으로 나가 ㄷ자로 잇는다
  return b.card ? 1 : b.dir
}

/** 원하는 위치를 순서대로 두고, 최소 간격을 지키며 [lo, hi] 안에 넣는다 */
function spread(xs: number[], lo: number, hi: number, gap: number): number[] {
  const n = xs.length
  if (n === 0) return []
  if (n > 1 && (n - 1) * gap > hi - lo) return xs.map((_, i) => Math.round(lo + ((hi - lo) * i) / (n - 1)))
  const out = xs.map((x) => Math.min(hi, Math.max(lo, x)))
  for (let i = 1; i < n; i++) out[i] = Math.max(out[i], out[i - 1] + gap)
  if (out[n - 1] > hi) {
    out[n - 1] = hi
    for (let i = n - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - gap)
  }
  return out.map((x) => Math.round(x))
}

interface Port extends Point {
  dir: number
  /** 칩에서 출구까지의 점 (카드 밖이면 핀 위치 하나) */
  lead: Point[]
  onCard: boolean
}

function portsFor(wires: WireSpec[]): Map<string, [Port, Port]> {
  const dirs = new Map<string, [number, number]>()
  for (const w of wires) dirs.set(w.id, [faceDir(w.a, w.b), faceDir(w.b, w.a)])

  // 카드 가장자리마다 출구를 모아 칩의 가로 순서대로 벌린다
  const groups = new Map<string, { id: string; side: 0 | 1; x: number; far: number }[]>()
  for (const w of wires) {
    ;[w.a, w.b].forEach((end, side) => {
      if (!end.card) return
      const key = `${end.card.id}:${dirs.get(w.id)![side]}`
      const far = side === 0 ? w.b : w.a
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push({ id: w.id, side: side as 0 | 1, x: end.x, far: far.x })
    })
  }
  const exitX = new Map<string, number>()
  for (const [key, list] of groups) {
    const card = wires.flatMap((w) => [w.a.card, w.b.card]).find((c) => c && key.startsWith(`${c.id}:`))!
    list.sort((p, q) => p.x - q.x || p.far - q.far)
    const xs = spread(list.map((p) => p.x), card.left + PORT_PAD, card.right - PORT_PAD, PORT_GAP)
    list.forEach((p, i) => exitX.set(`${p.id}:${p.side}`, xs[i]))
  }

  const result = new Map<string, [Port, Port]>()
  for (const w of wires) {
    const ports = [w.a, w.b].map((end, side): Port => {
      const dir = dirs.get(w.id)![side]
      const start = { x: end.x, y: Math.round(end.y + dir * (end.half ?? 0)) }
      if (!end.card) return { ...start, dir, lead: [start], onCard: false }
      const edge = dir > 0 ? end.card.bottom : end.card.top
      const x = exitX.get(`${w.id}:${side}`) ?? end.x
      const inner = dir > 0 ? Math.max(start.y, edge - INSET) : Math.min(start.y, edge + INSET)
      return { x, y: edge, dir, lead: [start, { x: start.x, y: inner }, { x, y: inner }, { x, y: edge }], onCard: true }
    })
    result.set(w.id, [ports[0], ports[1]])
  }
  return result
}

/** 두 출구 사이의 직각 경로. 꼭 필요한 만큼만 꺾는다 */
function orthogonalRoute(p: Port, q: Port, lane: number): Point[] {
  const stub = (port: Port) => (port.onCard ? 10 : 16) + lane * 5
  const dx = Math.abs(p.x - q.x)
  const facing = (p.dir > 0 && q.dir < 0 && q.y > p.y) || (p.dir < 0 && q.dir > 0 && q.y < p.y)
  if (facing) {
    if (dx <= STRAIGHT) return [p, q]
    const lo = Math.min(p.y, q.y) + 6
    const hi = Math.max(p.y, q.y) - 6
    const want = (p.y + q.y) / 2 + (lane - 3.5) * 5
    const y = Math.round(lo <= hi ? Math.min(hi, Math.max(lo, want)) : (p.y + q.y) / 2)
    return [p, { x: p.x, y }, { x: q.x, y }, q]
  }
  if (p.dir === q.dir) {
    if (dx <= STRAIGHT) return [p, q]
    const y = p.dir > 0 ? Math.max(p.y + stub(p), q.y + stub(q)) : Math.min(p.y - stub(p), q.y - stub(q))
    return [p, { x: p.x, y }, { x: q.x, y }, q]
  }
  // 서로 등지고 있으면 한 번 돌아 나가야 한다
  const y1 = p.y + p.dir * stub(p)
  const y2 = q.y + q.dir * stub(q)
  const minX = Math.min(p.x, q.x)
  const maxX = Math.max(p.x, q.x)
  const mx = Math.round(dx >= 24 ? Math.min(maxX - 6, Math.max(minX + 6, (p.x + q.x) / 2 + (lane - 3.5) * 5)) : maxX + 20 + lane * 5)
  return [p, { x: p.x, y: y1 }, { x: mx, y: y1 }, { x: mx, y: y2 }, { x: q.x, y: y2 }, q]
}

/** 같은 점·한 줄 위의 가운데 점을 지워 꺾이는 곳만 남긴다 */
function simplify(points: Point[]): Point[] {
  const out: Point[] = []
  for (const raw of points) {
    const p = { x: raw.x, y: raw.y }
    const last = out[out.length - 1]
    if (last && last.x === p.x && last.y === p.y) continue
    const prev = out[out.length - 2]
    if (prev && last && ((prev.x === last.x && last.x === p.x) || (prev.y === last.y && last.y === p.y))) out[out.length - 1] = p
    else out.push(p)
  }
  return out
}

function longestMid(points: Point[]): Point {
  let best = { x: points[0].x, y: points[0].y }
  let len = -1
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const l = Math.hypot(b.x - a.x, b.y - a.y)
    if (l > len) {
      len = l
      best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    }
  }
  return best
}

const polyline = (points: Point[]) => points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ')

/** 여러 전선의 경로를 한꺼번에 계산한다 (같은 카드 가장자리 출구를 서로 벌리기 위해) */
export function routeWires(wires: WireSpec[], style: WireStyle = 'curved'): Map<string, WireShape> {
  const ports = portsFor(wires)
  const shapes = new Map<string, WireShape>()
  for (const w of wires) {
    const [p, q] = ports.get(w.id)!
    const tail = [...q.lead].reverse()
    const exit: [Point, Point] = [{ x: p.x, y: p.y }, { x: q.x, y: q.y }]
    const inner = [p, q].filter((port) => port.onCard).map((port) => polyline(simplify(port.lead)))
    if (style === 'orthogonal') {
      const middle = simplify(orthogonalRoute(p, q, w.lane % 8))
      const points = simplify([...p.lead, ...middle, ...tail])
      shapes.set(w.id, { d: polyline(points), mid: longestMid(middle), points, exit, outer: polyline(middle), inner })
      continue
    }
    const k = Math.max(40, Math.abs(q.y - p.y) / 2)
    const c1 = { x: p.x, y: p.y + p.dir * k }
    const c2 = { x: q.x, y: q.y + q.dir * k }
    const head = simplify(p.lead)
    const end = simplify(tail)
    const d = `${polyline(head)} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${q.x} ${q.y}${end.length > 1 ? ' ' + end.slice(1).map((pt) => `L ${pt.x} ${pt.y}`).join(' ') : ''}`
    shapes.set(w.id, {
      d,
      mid: {
        x: 0.125 * p.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * q.x,
        y: 0.125 * p.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * q.y,
      },
      points: [...head, ...end],
      exit,
      outer: `M ${p.x} ${p.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${q.x} ${q.y}`,
      inner,
    })
  }
  return shapes
}

/** 끌고 있는 전선 미리보기 */
export function wirePath(a: Anchor, b: Anchor): string {
  const k = Math.max(40, Math.abs(b.y - a.y) / 2)
  return `M ${a.x} ${a.y} C ${a.x} ${a.y + a.dir * k}, ${b.x} ${b.y + b.dir * k}, ${b.x} ${b.y}`
}
