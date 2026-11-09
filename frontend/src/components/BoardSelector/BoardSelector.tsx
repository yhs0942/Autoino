import { useId } from 'react'
import type { Board } from '../../types'
import './BoardSelector.css'

interface BoardSelectorProps {
  boards: Board[]
  board: Board
  /** 보드가 여러 개일 때 현재 편집 중인 보드 인스턴스 이름 */
  instanceLabel?: string
  onChange: (boardId: string) => void
}

export function BoardSelector({ boards, board, instanceLabel, onChange }: BoardSelectorProps) {
  const selectId = useId()
  return (
    <div className="board-selector">
      <label htmlFor={selectId} className="board-selector__label">
        {instanceLabel ? `메인 보드 · ${instanceLabel}` : '메인 보드'}
      </label>
      <select
        id={selectId}
        className="board-selector__select"
        value={board.id}
        onChange={(e) => onChange(e.target.value)}
      >
        {boards.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <dl className="board-selector__stats" aria-label={`${board.name} 핀 정보`}>
        <div>
          <dt>디지털</dt>
          <dd data-testid="stat-digital">{board.digitalIoCount}</dd>
        </div>
        <div>
          <dt>아날로그</dt>
          <dd data-testid="stat-analog">{board.analogInputCount}</dd>
        </div>
        <div>
          <dt>PWM</dt>
          <dd data-testid="stat-pwm">{board.pwmPins.length}</dd>
        </div>
      </dl>
    </div>
  )
}
