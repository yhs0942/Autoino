import type { Point } from '../types'

// 작업 공간 확대·축소 계산 (배선도·실물 배치 공용)

export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 2
const BUTTON_STEP = 1.25

function clampZoom(zoom: number): number {
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))
  // 확대·축소를 오가며 생긴 아주 작은 오차는 정확히 100% 로
  return Math.abs(z - 1) < 1e-9 ? 1 : z
}

/**
 * 휠 한 번에 바뀐 배율. 휠을 위로(deltaY < 0) 굴리면 확대, 아래로 굴리면 축소한다.
 * 마우스 휠 한 칸(100 px)에 약 10%, 터치패드처럼 작게 여러 번 오는 값은 그만큼 조금씩.
 */
export function wheelZoom(zoom: number, deltaY: number, deltaMode = 0): number {
  // deltaMode: 0 = 픽셀, 1 = 줄(Firefox 마우스 휠, 한 칸에 3줄), 2 = 페이지
  const px = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 800 : deltaY
  const step = Math.max(-200, Math.min(200, px))
  return clampZoom(zoom * Math.exp(-step / 1000))
}

/** [+]·[−] 버튼으로 한 단계. 100% 를 지나칠 때는 100% 에 멈춘다 */
export function buttonZoom(zoom: number, direction: 1 | -1): number {
  const next = direction > 0 ? zoom * BUTTON_STEP : zoom / BUTTON_STEP
  if ((zoom < 1 && next > 1) || (zoom > 1 && next < 1)) return 1
  return clampZoom(next)
}

/**
 * 배율을 바꿀 때 포인터 아래에 있던 점이 그대로 남도록 하는 새 스크롤 위치.
 * scroll: 지금 스크롤 위치, pointer: 스크롤 영역 안에서의 포인터 위치.
 */
export function scrollForZoom(scroll: Point, pointer: Point, from: number, to: number): Point {
  return {
    x: ((scroll.x + pointer.x) / from) * to - pointer.x,
    y: ((scroll.y + pointer.y) / from) * to - pointer.y,
  }
}
