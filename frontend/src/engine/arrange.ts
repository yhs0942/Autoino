import type { Board, PlacedModule } from '../types'
import { CANVAS_SIZE, MODULE_SIZE, breadboardRect, findFreePosition, type Rect } from '../utils/placement'
import { boardDefOf, type Circuit } from './circuit'
import { asModuleBoardLink } from './connections'

// 부품 자동 정렬 (배선 정리)
//
// 부품을 호스트 보드별로 묶고, 각 부품이 연결된 보드 핀의 평균 위치(헤더 순서) 순으로
// 보드 오른쪽에 격자로 다시 놓는다. 핀 순서와 부품 순서가 같아져 전선 교차가 줄어든다.
// 최적해를 보장하지 않는 휴리스틱이다.

const COLUMNS = 4
const GAP = 28

/** 보드 그림에서 핀이 놓이는 순서 (헤더 배열이 있으면 그 순서, 없으면 핀 목록 순서) */
function pinOrder(board: Board): Map<string, number> {
  const ids = board.headers ? board.headers.flatMap((h) => h.pinIds) : board.pins.map((p) => p.id)
  return new Map(ids.map((id, i) => [id, i]))
}

export function arrangeModules(circuit: Circuit): PlacedModule[] {
  const boardRects: Rect[] = circuit.boards.map((b) => {
    const def = boardDefOf(circuit, b.instanceId)
    return { x: b.x, y: b.y, width: def?.footprint.width ?? 0, height: def?.footprint.height ?? 0 }
  })
  if (circuit.breadboard) boardRects.push(breadboardRect(circuit.breadboard))
  const result: PlacedModule[] = []
  const done = new Set<string>()

  circuit.boards.forEach((instance, bi) => {
    const board = boardDefOf(circuit, instance.instanceId)
    if (!board) return
    const order = pinOrder(board)
    const mine = circuit.placed.filter((p) => (p.hostBoardId === instance.instanceId || (bi === 0 && !circuit.boards.some((b) => b.instanceId === p.hostBoardId))) && !done.has(p.instanceId))
    const score = (item: PlacedModule) => {
      const idx = circuit.connections
        .map(asModuleBoardLink)
        .filter((l) => l && l.instanceId === item.instanceId && l.boardInstanceId === instance.instanceId)
        .map((l) => order.get(l!.pinId))
        .filter((v): v is number => v !== undefined)
      return idx.length ? idx.reduce((a, b) => a + b, 0) / idx.length : Number.POSITIVE_INFINITY
    }
    const sorted = mine
      .map((item, i) => ({ item, s: score(item), i }))
      .sort((a, b) => a.s - b.s || a.i - b.i)
      .map((x) => x.item)
    sorted.forEach((item, i) => {
      const near = {
        x: Math.min(instance.x + board.footprint.width + 48 + (i % COLUMNS) * (MODULE_SIZE.width + GAP), CANVAS_SIZE.width - MODULE_SIZE.width),
        y: instance.y + Math.floor(i / COLUMNS) * (MODULE_SIZE.height + GAP),
      }
      const pos = findFreePosition(result, boardRects, near)
      result.push({ ...item, x: pos.x, y: pos.y })
      done.add(item.instanceId)
    })
  })
  // 원래 순서 유지
  return circuit.placed.map((p) => result.find((r) => r.instanceId === p.instanceId) ?? p)
}
