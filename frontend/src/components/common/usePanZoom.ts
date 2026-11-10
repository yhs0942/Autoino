import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { Point } from '../../types'
import { buttonZoom, scrollForZoom, wheelZoom } from '../../utils/zoom'

// 작업 공간 화면 이동(바탕을 눌러 끌기)과 확대·축소(마우스 휠). 배선도와 실물 배치가 함께 쓴다.
// 화면은 스크롤 영역(scrollRef) 안의 캔버스를 CSS transform 으로 키우거나 줄이고, 이동은 스크롤 위치로 한다.

export interface PanZoom {
  /** 배율 (1 = 100%) */
  zoom: number
  /** 바탕을 끌어 화면을 옮기는 중 */
  panning: boolean
  /** 바탕을 눌렀을 때 부른다. 끌면 화면을 옮기고, 끌지 않고 떼면 onClick */
  startPan: (e: ReactPointerEvent, onClick?: () => void) => void
  zoomStep: (direction: 1 | -1) => void
  resetZoom: () => void
}

export function usePanZoom(scrollRef: RefObject<HTMLDivElement | null>): PanZoom {
  const [zoom, setZoom] = useState(1)
  const [panning, setPanning] = useState(false)
  const zoomRef = useRef(1)
  /** 다음 렌더링 뒤에 맞출 스크롤 위치 (배율이 바뀐 크기로 그린 다음에 옮겨야 한다) */
  const pendingScroll = useRef<Point | null>(null)

  const applyZoom = useCallback(
    (to: number, pointer?: Point) => {
      const el = scrollRef.current
      const from = zoomRef.current
      if (!el || to === from) return
      const at = pointer ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 }
      const base = pendingScroll.current ?? { x: el.scrollLeft, y: el.scrollTop }
      pendingScroll.current = scrollForZoom(base, at, from, to)
      zoomRef.current = to
      setZoom(to)
    },
    [scrollRef],
  )

  useLayoutEffect(() => {
    const el = scrollRef.current
    const s = pendingScroll.current
    if (!el || !s) return
    pendingScroll.current = null
    el.scrollLeft = s.x
    el.scrollTop = s.y
  }, [zoom, scrollRef])

  // 휠: 포인터가 가리키는 곳을 중심으로 확대·축소 (화면 스크롤 대신)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.deltaY) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      applyZoom(wheelZoom(zoomRef.current, e.deltaY, e.deltaMode), { x: e.clientX - r.left - el.clientLeft, y: e.clientY - r.top - el.clientTop })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [scrollRef, applyZoom])

  const startPan = useCallback(
    (e: ReactPointerEvent, onClick?: () => void) => {
      // 왼쪽 버튼: 바탕을 끌어 이동 (끌지 않으면 클릭), 가운데 버튼: 어디서든 끌어 이동
      if (e.button !== 0 && e.button !== 1) return
      const el = scrollRef.current
      if (!el) return
      if (e.button === 1) e.preventDefault()
      const id = e.pointerId
      const button = e.button
      const start = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop }
      let moved = false
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return
        const dx = ev.clientX - start.x
        const dy = ev.clientY - start.y
        if (!moved) {
          if (Math.hypot(dx, dy) < 4) return
          moved = true
          setPanning(true)
          window.getSelection()?.removeAllRanges()
        }
        el.scrollLeft = start.left - dx
        el.scrollTop = start.top - dy
      }
      const end = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', end)
        window.removeEventListener('pointercancel', end)
        if (moved) setPanning(false)
        else if (ev.type === 'pointerup' && button === 0) onClick?.()
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', end)
      window.addEventListener('pointercancel', end)
    },
    [scrollRef],
  )

  const zoomStep = useCallback((direction: 1 | -1) => applyZoom(buttonZoom(zoomRef.current, direction)), [applyZoom])
  const resetZoom = useCallback(() => applyZoom(1), [applyZoom])

  return { zoom, panning, startPan, zoomStep, resetZoom }
}
