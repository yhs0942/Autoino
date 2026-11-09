import type { PinTableRow } from '../../engine/exporters'
import type { Selection } from '../../types'
import './PinTable.css'

interface PinTableProps {
  rows: PinTableRow[]
  boardName: string
  multiBoard?: boolean
  onSelect: (selection: Selection) => void
}

/** 모든 부품 핀의 보드 핀 배정 현황 */
export function PinTable({ rows, boardName, multiBoard, onSelect }: PinTableProps) {
  if (rows.length === 0) return <p className="empty-note">배치된 부품이 없습니다.</p>
  const required = rows.filter((r) => !r.optional)
  const assigned = required.filter((r) => r.boardPin).length
  return (
    <div data-testid="pin-table">
      <p className="muted small">
        {boardName} · 보드 핀에 연결된 부품 핀 {assigned}/{required.length}개
      </p>
      <table className="pin-table assignment-table">
        <thead>
          <tr>
            <th>부품</th>
            <th>핀</th>
            <th>보드 핀</th>
            <th>비고</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={`${r.instanceId}-${r.pinName}`}
              className={i > 0 && rows[i - 1].instanceId === r.instanceId ? 'is-continued' : ''}
              onClick={() => onSelect({ kind: 'module', instanceId: r.instanceId })}
              title={r.boardPinFeatures ? `${r.boardPin}: ${r.boardPinFeatures}` : undefined}
            >
              <td>{i > 0 && rows[i - 1].instanceId === r.instanceId ? '' : r.moduleLabel}</td>
              <td>{r.pinName}</td>
              <td>
                {r.boardPin ? (
                  <strong className="mono">
                    {multiBoard && r.boardName ? `${r.boardName} ` : ''}
                    {r.boardPin}
                  </strong>
                ) : r.optional ? (
                  <span className="muted">—</span>
                ) : (
                  <span className="badge badge--pending">미연결</span>
                )}
              </td>
              <td className="muted">{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
