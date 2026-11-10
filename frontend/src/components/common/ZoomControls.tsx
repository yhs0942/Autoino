import { ZOOM_MAX, ZOOM_MIN } from '../../utils/zoom'
import type { PanZoom } from './usePanZoom'
import './ZoomControls.css'

/** 작업 공간 오른쪽 위의 확대·축소 단추 */
export function ZoomControls({ view }: { view: PanZoom }) {
  return (
    <div className="zoom-controls" role="group" aria-label="확대·축소" title="마우스 휠로 확대·축소, 바탕을 끌어 화면 이동">
      <button type="button" onClick={() => view.zoomStep(-1)} disabled={view.zoom <= ZOOM_MIN} aria-label="축소" data-testid="zoom-out">
        −
      </button>
      <button type="button" className="zoom-controls__value" onClick={view.resetZoom} title="100% 로 되돌리기" data-testid="zoom-reset">
        {Math.round(view.zoom * 100)}%
      </button>
      <button type="button" onClick={() => view.zoomStep(1)} disabled={view.zoom >= ZOOM_MAX} aria-label="확대" data-testid="zoom-in">
        +
      </button>
    </div>
  )
}
