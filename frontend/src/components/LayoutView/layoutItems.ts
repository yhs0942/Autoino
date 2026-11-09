import { findBoard } from '../../data/boards'
import { findModule } from '../../data/modules'
import type { CircuitDocument } from '../../state/circuitState'
import type { Board } from '../../types'
import { CANVAS_SIZE } from '../../utils/placement'

// 실물 배치 모드에 그릴 것들: 보드·브레드보드·부품을 대표 실물 크기(mm)의 같은 비율로 놓는다.

/** 화면 픽셀 / mm */
export const LAYOUT_SCALE = 4
/** 830홀 브레드보드 크기 (mm) */
export const BREADBOARD_MM = { width: 165, height: 55 }
/** 크기 정보가 없는 부품의 대체 크기 (mm) */
const FALLBACK_MM = { width: 20, height: 20 }

export interface LayoutItem {
  /** 보드 인스턴스 ID, 부품 인스턴스 ID 또는 'breadboard' */
  id: string
  kind: 'board' | 'module' | 'breadboard'
  x: number
  y: number
  width: number
  height: number
  label: string
  /** 부품 그림 */
  icon?: string
  board?: Board
  sizeMm: { width: number; height: number }
}

export function layoutItems(doc: Pick<CircuitDocument, 'boards' | 'placed' | 'breadboard' | 'layout'>): LayoutItem[] {
  const at = (id: string, fallback: { x: number; y: number }) => {
    const pos = doc.layout[id] ?? fallback
    return { x: pos.x, y: pos.y }
  }
  const items: LayoutItem[] = []
  for (const b of doc.boards) {
    const def = findBoard(b.boardId)
    const mm = def?.sizeMm ?? FALLBACK_MM
    items.push({ id: b.instanceId, kind: 'board', ...at(b.instanceId, b), width: mm.width * LAYOUT_SCALE, height: mm.height * LAYOUT_SCALE, label: def ? `${b.label} · ${def.name}` : b.label, board: def, sizeMm: mm })
  }
  items.push({
    id: 'breadboard',
    kind: 'breadboard',
    ...at('breadboard', doc.breadboard),
    width: BREADBOARD_MM.width * LAYOUT_SCALE,
    height: BREADBOARD_MM.height * LAYOUT_SCALE,
    label: '브레드보드 (830홀)',
    sizeMm: BREADBOARD_MM,
  })
  for (const p of doc.placed) {
    const def = findModule(p.moduleId)
    const mm = def?.sizeMm ?? FALLBACK_MM
    items.push({ id: p.instanceId, kind: 'module', ...at(p.instanceId, p), width: mm.width * LAYOUT_SCALE, height: mm.height * LAYOUT_SCALE, label: p.label, icon: def?.icon, sizeMm: mm })
  }
  return spreadOut(
    items.map((i) => ({ ...i, x: Math.round(i.x), y: Math.round(i.y) })),
    new Set(Object.keys(doc.layout)),
  )
}

const GAP = 12

/** 아직 자리를 잡지 않은 것(배선도 위치를 빌려 쓴 것)이 앞의 것과 겹치면 오른쪽·아래로 비켜 놓는다 */
function spreadOut(items: LayoutItem[], saved: Set<string>): LayoutItem[] {
  const done: LayoutItem[] = []
  const hits = (a: LayoutItem) => done.find((b) => a.x < b.x + b.width + GAP && b.x < a.x + a.width + GAP && a.y < b.y + b.height + GAP && b.y < a.y + a.height + GAP)
  for (const item of items) {
    const next = { ...item }
    if (!saved.has(item.id)) {
      for (let guard = 0; guard < 400; guard++) {
        const block = hits(next)
        if (!block) break
        next.x = block.x + block.width + GAP
        if (next.x + next.width > CANVAS_SIZE.width) {
          next.x = 20
          next.y += 40
        }
      }
    }
    done.push(next)
  }
  return done
}
