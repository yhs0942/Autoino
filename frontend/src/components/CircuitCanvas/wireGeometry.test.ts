import { describe, expect, it } from 'vitest'
import type { Point } from '../../types'
import { routeWires, type Anchor, type CardBox } from './wireGeometry'

/** 꺾인 횟수 (같은 방향으로 이어지는 점은 하나로 본다) */
function bends(points: Point[]): number {
  let count = 0
  let prev: string | null = null
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x
    const dy = points[i].y - points[i - 1].y
    if (dx === 0 && dy === 0) continue
    const dir = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'
    if (prev && dir !== prev) count++
    prev = dir
  }
  return count
}

const card = (id: string, left: number, top: number): CardBox => ({ id, left, top, right: left + 160, bottom: top + 104 })
/** 카드 안의 핀 칩 (칩 높이 14px) */
const chip = (box: CardBox, x: number, y: number): Anchor => ({ x, y, dir: 1, half: 7, card: box })
/** 보드 핀처럼 방향이 정해진 끝 */
const pin = (x: number, y: number, dir: number): Anchor => ({ x, y, dir })

const route = (a: Anchor, b: Anchor, lane = 0, style: 'orthogonal' | 'curved' = 'orthogonal') =>
  routeWires([{ id: 'w', a, b, lane }], style).get('w')!

describe('직각 배선', () => {
  it('마주 보는 두 핀은 두 번만 꺾는다', () => {
    const shape = route(pin(100, 100, 1), pin(300, 400, -1))
    expect(bends(shape.points)).toBe(2)
  })

  it('같은 세로줄에서 마주 보면 곧게 잇는다', () => {
    const shape = route(pin(100, 100, 1), pin(102, 400, -1), 5)
    expect(bends(shape.points)).toBe(0)
  })

  it('같은 쪽을 보는 두 핀은 ㄷ자로 두 번만 꺾는다', () => {
    const shape = route(pin(100, 100, 1), pin(300, 160, 1), 3)
    expect(bends(shape.points)).toBe(2)
    expect(Math.max(...shape.points.map((p) => p.y))).toBeGreaterThan(160)
  })

  it('부품 핀은 반대쪽 끝을 향한 카드 가장자리로 나가고, 카드 밖에서 처음 꺾는다', () => {
    const box = card('m1', 400, 500)
    const above = route(chip(box, 450, 590), pin(200, 120, 1))
    const outside = above.points.filter((p) => p.y < box.top)
    // 위쪽 보드 핀으로 가는 전선은 카드 위 가장자리로 나간다 (아래로 돌아 나가지 않는다)
    expect(Math.max(...above.points.map((p) => p.y))).toBeLessThanOrEqual(box.bottom)
    expect(outside.length).toBeGreaterThan(0)
    // 카드 밖에서 보이는 부분은 두 번만 꺾는다
    expect(bends([{ x: outside[0].x, y: box.top }, ...outside])).toBeLessThanOrEqual(2)

    const below = route(chip(box, 450, 520), pin(700, 900, -1))
    expect(Math.min(...below.points.map((p) => p.y))).toBeGreaterThanOrEqual(box.top)
    const visible = below.points.filter((p) => p.y > box.bottom)
    expect(bends([{ x: visible[0].x, y: box.bottom }, ...visible])).toBeLessThanOrEqual(2)
  })

  it('같은 세로줄의 칩들은 카드 가장자리에서 서로 다른 자리로 나온다', () => {
    const box = card('drv', 400, 500)
    const wires = [520, 545, 570].map((y, i) => ({ id: `w${i}`, a: chip(box, 430 + i, y), b: pin(300 + i * 40, 900, -1), lane: i }))
    const shapes = routeWires(wires, 'orthogonal')
    const exits = wires.map((w) => shapes.get(w.id)!.exit[0].x).sort((a, b) => a - b)
    expect(exits[1] - exits[0]).toBeGreaterThanOrEqual(7)
    expect(exits[2] - exits[1]).toBeGreaterThanOrEqual(7)
    for (const x of exits) {
      expect(x).toBeGreaterThan(box.left)
      expect(x).toBeLessThan(box.right)
    }
  })

  it('전선은 칩 가장자리에서 시작해 핀 이름을 가리지 않는다', () => {
    const box = card('m1', 400, 500)
    const shape = route(chip(box, 450, 520), pin(700, 900, -1))
    expect(shape.points[0]).toEqual({ x: 450, y: 527 })
  })

  it('카드 안 구간과 카드 밖 구간을 따로 알려 준다 (카드 위에 올려 그릴 때 안쪽은 얇게)', () => {
    const box = card('m1', 400, 500)
    const shape = route(chip(box, 450, 520), pin(700, 900, -1))
    expect(shape.inner).toHaveLength(1)
    expect(shape.inner[0].startsWith('M 450 527')).toBe(true)
    expect(shape.outer.startsWith(`M ${shape.exit[0].x} ${box.bottom}`)).toBe(true)
    expect(route(pin(100, 100, 1), pin(300, 400, -1)).inner).toHaveLength(0)
  })

  it('두 부품 카드가 위아래로 있으면 마주 보는 가장자리끼리 잇는다', () => {
    const top = card('a', 100, 100)
    const bottom = card('b', 400, 400)
    const shape = route(chip(top, 150, 130), chip(bottom, 450, 480))
    const ys = shape.points.map((p) => p.y)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(top.top)
    expect(Math.max(...ys)).toBeLessThanOrEqual(bottom.bottom)
    expect(bends(shape.points.filter((p) => p.y >= top.bottom && p.y <= bottom.top))).toBeLessThanOrEqual(2)
  })
})

describe('곡선 배선', () => {
  it('부품 핀은 반대쪽 끝을 향한 가장자리로 나간다', () => {
    const box = card('m1', 400, 500)
    const shape = route(chip(box, 450, 590), pin(200, 120, 1), 0, 'curved')
    expect(shape.exit[0].y).toBe(box.top)
    expect(shape.d.startsWith('M 450 583')).toBe(true)
  })
})
