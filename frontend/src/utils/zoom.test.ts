import { describe, expect, it } from 'vitest'
import { ZOOM_MAX, ZOOM_MIN, buttonZoom, scrollForZoom, wheelZoom } from './zoom'

describe('휠 확대·축소', () => {
  it('휠을 위로 굴리면 확대, 아래로 굴리면 축소 (한 칸에 약 10%)', () => {
    expect(wheelZoom(1, -100)).toBeGreaterThan(1.08)
    expect(wheelZoom(1, -100)).toBeLessThan(1.15)
    expect(wheelZoom(1, 100)).toBeLessThan(0.93)
    expect(wheelZoom(1, 100)).toBeGreaterThan(0.86)
  })

  it('줄 단위로 오는 휠(Firefox)도 한 칸에 비슷하게', () => {
    expect(wheelZoom(1, 3, 1)).toBeCloseTo(wheelZoom(1, 100), 1)
  })

  it('한 번에 너무 크게 바뀌지 않고, 최소·최대 배율을 넘지 않는다', () => {
    expect(wheelZoom(1, 5000)).toBeGreaterThan(0.75)
    let z = 1
    for (let i = 0; i < 100; i++) z = wheelZoom(z, 100)
    expect(z).toBe(ZOOM_MIN)
    for (let i = 0; i < 100; i++) z = wheelZoom(z, -100)
    expect(z).toBe(ZOOM_MAX)
  })

  it('확대했다가 같은 만큼 축소하면 정확히 100% 로 돌아온다', () => {
    let z = 1
    for (let i = 0; i < 3; i++) z = wheelZoom(z, -100)
    for (let i = 0; i < 3; i++) z = wheelZoom(z, 100)
    expect(z).toBe(1)
  })

  it('버튼: 한 단계씩, 100% 를 지나칠 때는 100% 에 멈춘다', () => {
    expect(buttonZoom(1, 1)).toBeCloseTo(1.25)
    expect(buttonZoom(1, -1)).toBeCloseTo(0.8)
    expect(buttonZoom(0.9, 1)).toBe(1)
    expect(buttonZoom(1.1, -1)).toBe(1)
    expect(buttonZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX)
  })
})

describe('확대·축소할 때 스크롤 위치', () => {
  it('포인터 아래에 있던 점이 그대로 포인터 아래에 남는다', () => {
    // 스크롤 (100, 50) + 포인터 (200, 100) → 캔버스 점 (300, 150). 2배가 되면 (600, 300) 이 포인터 아래 → 스크롤 (400, 200)
    expect(scrollForZoom({ x: 100, y: 50 }, { x: 200, y: 100 }, 1, 2)).toEqual({ x: 400, y: 200 })
    const back = scrollForZoom({ x: 400, y: 200 }, { x: 200, y: 100 }, 2, 1)
    expect(back).toEqual({ x: 100, y: 50 })
  })
})
