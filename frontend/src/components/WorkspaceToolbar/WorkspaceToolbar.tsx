import type { Board, RouteMode } from '../../types'
import { BoardSelector } from '../BoardSelector/BoardSelector'
import type { WireStyle } from '../CircuitCanvas/wireGeometry'
import './WorkspaceToolbar.css'

interface WorkspaceToolbarProps {
  boards: Board[]
  /** 툴바가 편집하는 보드 (선택된 보드 또는 첫 번째 보드) */
  board: Board
  /** 보드가 여러 개일 때 그 보드의 인스턴스 이름 */
  boardLabel?: string
  boardCount: number
  placedCount: number
  connectionCount: number
  canUndo: boolean
  canRedo: boolean
  wireStyle: WireStyle
  /** 새 전선의 경로 */
  route: RouteMode
  /** 작업 화면: 배선도 또는 실물 배치 */
  view: 'wiring' | 'layout'
  onViewChange: (view: 'wiring' | 'layout') => void
  onBoardChange: (boardId: string) => void
  onAddBoard: () => void
  onAutoAssign: () => void
  onInsertLevelShifters: () => void
  onArrange: () => void
  onClearConnections: () => void
  onWireStyleChange: (style: WireStyle) => void
  onRouteChange: (route: RouteMode) => void
  onOpenConnections: () => void
  onUndo: () => void
  onRedo: () => void
  onReset: () => void
}

export function WorkspaceToolbar(props: WorkspaceToolbarProps) {
  const { boards, board, boardLabel, boardCount, placedCount, connectionCount, canUndo, canRedo, wireStyle, route, view } = props
  return (
    <div className="workspace-toolbar" role="toolbar" aria-label="작업 공간 도구">
      <div className="workspace-toolbar__row">
        <BoardSelector boards={boards} board={board} instanceLabel={boardLabel} onChange={props.onBoardChange} />
        <div className="workspace-toolbar__right">
          <span className="workspace-toolbar__count">
            보드 <strong data-testid="board-count">{boardCount}</strong> · 부품 <strong data-testid="placed-count">{placedCount}</strong>개 · 연결{' '}
            <strong data-testid="connection-count">{connectionCount}</strong>개
          </span>
          <span className="workspace-toolbar__route-label">보기</span>
          <div className="segmented" role="group" aria-label="작업 화면">
            <button type="button" aria-pressed={view === 'wiring'} onClick={() => props.onViewChange('wiring')} title="부품 핀과 전선을 보여 주는 배선도" data-testid="view-wiring">
              배선도
            </button>
            <button
              type="button"
              aria-pressed={view === 'layout'}
              onClick={() => props.onViewChange('layout')}
              title="전선과 설명 없이 보드·부품을 실제 상대 크기로 보여 주고 끌어서 자리를 잡습니다"
              data-testid="view-layout"
            >
              실물 배치
            </button>
          </div>
          <span className="workspace-toolbar__route-label">새 전선</span>
          <div className="segmented" role="group" aria-label="새 전선의 경로">
            <button type="button" aria-pressed={route === 'direct'} onClick={() => props.onRouteChange('direct')} title="부품 핀을 보드 핀에 바로 연결합니다" data-testid="route-direct">
              보드 직결
            </button>
            <button
              type="button"
              aria-pressed={route === 'breadboard'}
              onClick={() => props.onRouteChange('breadboard')}
              title="전선을 끌기 전에 고르세요. 새 전선은 배선도 위 브레드보드를 거쳐 연결됩니다"
              data-testid="route-breadboard"
            >
              브레드보드 경유
            </button>
          </div>
        </div>
      </div>
      <div className="workspace-toolbar__row workspace-toolbar__actions">
        <button
          type="button"
          className="button button--primary"
          onClick={props.onAutoAssign}
          disabled={placedCount === 0}
          title="연결되지 않은 핀을 자동으로 배정하고, 오류·충돌이 있는 연결을 재배치합니다"
        >
          자동 핀 배정
        </button>
        <button
          type="button"
          className="button"
          onClick={props.onInsertLevelShifters}
          disabled={connectionCount === 0}
          title="3.3 V 보드에 5 V 신호가 들어가는 연결에 전압 분배기·레벨 시프터를 자동으로 넣습니다"
        >
          레벨 변환
        </button>
        <button type="button" className="button" onClick={props.onArrange} disabled={placedCount === 0} title="부품을 연결된 핀 순서대로 정렬해 전선 교차를 줄입니다">
          부품 정렬
        </button>
        <div className="segmented" role="group" aria-label="배선 모양">
          <button type="button" aria-pressed={wireStyle === 'curved'} onClick={() => props.onWireStyleChange('curved')}>
            곡선
          </button>
          <button type="button" aria-pressed={wireStyle === 'orthogonal'} onClick={() => props.onWireStyleChange('orthogonal')} data-testid="wire-orthogonal">
            직각
          </button>
        </div>
        <button type="button" className="button" onClick={props.onClearConnections} disabled={connectionCount === 0} title="모든 전선과 보드 간 통신 연결을 삭제합니다 (부품은 유지)">
          배선 지우기
        </button>
        <span className="workspace-toolbar__sep" aria-hidden="true" />
        <button type="button" className="button" onClick={props.onAddBoard} title="메인 보드를 하나 더 배치합니다">
          보드 추가
        </button>
        <button type="button" className="button" onClick={props.onOpenConnections}>
          연결 방식
        </button>
        <span className="workspace-toolbar__sep" aria-hidden="true" />
        <button type="button" className="button button--icon" onClick={props.onUndo} disabled={!canUndo} title="실행 취소 (Ctrl+Z)" aria-label="실행 취소">
          ↶
        </button>
        <button type="button" className="button button--icon" onClick={props.onRedo} disabled={!canRedo} title="다시 실행 (Ctrl+Shift+Z / Ctrl+Y)" aria-label="다시 실행">
          ↷
        </button>
        <button
          type="button"
          className="button button--danger-outline"
          onClick={props.onReset}
          disabled={placedCount === 0 && connectionCount === 0 && boardCount === 1}
          title={placedCount === 0 ? '배치된 부품이 없습니다' : '배치된 부품을 모두 제거합니다'}
        >
          초기화
        </button>
      </div>
    </div>
  )
}
