import type { PlacedModule, Point } from '../types'

// 캔버스 좌표계 관련 상수와 기본 배치 위치 계산

export const CANVAS_SIZE = { width: 2400, height: 1400 }
export const MODULE_SIZE = { width: 160, height: 104 }
/** 새 보드 인스턴스의 기본 위치 */
export const BOARD_POSITION: Point = { x: 40, y: 40 }
/** 배선도 위 브레드보드의 크기와 기본 위치 (첫 보드 아래) */
export const BREADBOARD_SIZE = { width: 664, height: 180 }
export const BREADBOARD_POSITION: Point = { x: 40, y: 340 }

const GAP = 24

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

function moduleRect(p: Point): Rect {
  return { x: p.x, y: p.y, ...MODULE_SIZE }
}

export function breadboardRect(p: Point): Rect {
  return { x: p.x, y: p.y, ...BREADBOARD_SIZE }
}

/** 브레드보드 기본 위치. 저장된 위치가 없는 옛 프로젝트에서는 기존 배치 아래로 옮긴다 */
export function findBreadboardPosition(boards: Rect[], placed: PlacedModule[]): Point {
  const rects = [...boards, ...placed.map((p) => moduleRect(p))]
  const wanted = breadboardRect(BREADBOARD_POSITION)
  if (!rects.some((r) => overlaps(wanted, r))) return { ...BREADBOARD_POSITION }
  return clampToCanvas({ x: BREADBOARD_POSITION.x, y: Math.max(...rects.map((r) => r.y + r.height)) + 40 }, BREADBOARD_SIZE)
}

export function clampToCanvas(p: Point, size: { width: number; height: number } = MODULE_SIZE): Point {
  return {
    x: Math.round(Math.min(Math.max(0, p.x), CANVAS_SIZE.width - size.width)),
    y: Math.round(Math.min(Math.max(0, p.y), CANVAS_SIZE.height - size.height)),
  }
}

/**
 * 새 모듈의 기본 위치를 찾는다.
 * 첫 번째 보드 오른쪽 영역부터 격자 순서로 탐색하여 보드·기존 모듈과 겹치지 않는 첫 칸을 반환한다.
 * near 를 주면 그 위치에서 가까운 빈 칸을 고른다.
 * 빈 칸이 없으면 기존 배치에서 조금씩 어긋난 위치를 반환한다.
 */
export function findFreePosition(placed: PlacedModule[], boards: Rect[], near?: Point): Point {
  const obstacles: Rect[] = [
    // 보드 주변에 여유 공간을 둔다.
    ...boards.map((b) => ({ x: b.x - GAP, y: b.y - GAP, width: b.width + GAP * 2, height: b.height + GAP * 2 })),
    ...placed.map((p) => moduleRect(p)),
  ]
  const first = boards[0] ?? { x: BOARD_POSITION.x, y: BOARD_POSITION.y, width: 0, height: 0 }

  const stepX = MODULE_SIZE.width + GAP
  const stepY = MODULE_SIZE.height + GAP
  const startX = first.x + first.width + GAP * 2

  // 1순위: 첫 보드 오른쪽 열, 2순위: 보드 아래쪽을 포함한 전체 격자
  const candidates: Point[] = []
  for (let y = first.y; y + MODULE_SIZE.height <= CANVAS_SIZE.height; y += stepY) {
    for (let x = startX; x + MODULE_SIZE.width <= CANVAS_SIZE.width; x += stepX) {
      candidates.push({ x, y })
    }
  }
  for (let y = first.y; y + MODULE_SIZE.height <= CANVAS_SIZE.height; y += stepY) {
    for (let x = first.x; x < startX; x += stepX) {
      candidates.push({ x, y })
    }
  }
  if (near) {
    const d = (p: Point) => Math.hypot(p.x - near.x, p.y - near.y)
    candidates.sort((a, b) => d(a) - d(b))
  }

  const free = candidates.find((c) => {
    const rect = moduleRect(c)
    // 모듈 사이에도 GAP 만큼 여백을 확보한다.
    const padded = { x: rect.x - GAP / 2, y: rect.y - GAP / 2, width: rect.width + GAP, height: rect.height + GAP }
    return !obstacles.some((o) => overlaps(padded, o))
  })
  if (free) return free

  const offset = (placed.length % 10) * 16
  return clampToCanvas({ x: startX + offset, y: first.y + offset })
}

/** 새 보드의 위치: 왼쪽 열에서 기존 보드·부품 아래쪽 빈 공간 */
export function findBoardPosition(boards: Rect[], placed: PlacedModule[], width: number): Point {
  const column = { x: BOARD_POSITION.x, width }
  const inColumn = (r: Rect) => r.x < column.x + column.width + GAP && column.x < r.x + r.width + GAP
  const rects = [...boards, ...placed.map((p) => moduleRect(p))].filter(inColumn)
  if (!boards.length && !rects.length) return { ...BOARD_POSITION }
  const bottom = Math.max(BOARD_POSITION.y, ...rects.map((r) => r.y + r.height))
  return clampToCanvas({ x: BOARD_POSITION.x, y: bottom + 80 }, { width, height: 0 })
}
