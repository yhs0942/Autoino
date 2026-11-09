import { countIssues, type Issue, type Severity } from '../../engine/validate'
import type { Selection } from '../../types'
import './ValidationPanel.css'

const SEVERITY_LABEL: Record<Severity, string> = { error: '오류', warning: '경고', info: '정보' }
const SEVERITY_ICON: Record<Severity, string> = { error: '✕', warning: '!', info: 'i' }

interface ValidationPanelProps {
  issues: Issue[]
  placedCount: number
  onSelect: (selection: Selection) => void
}

export function IssueList({ issues, onSelect }: { issues: Issue[]; onSelect?: (selection: Selection) => void }) {
  return (
    <ul className="issue-list">
      {issues.map((issue) => {
        const target: Selection | null = issue.connectionId
          ? { kind: 'connection', connectionId: issue.connectionId }
          : issue.instanceId
            ? { kind: 'module', instanceId: issue.instanceId }
            : null
        const content = (
          <>
            <span className={`issue__icon issue__icon--${issue.severity}`} aria-label={SEVERITY_LABEL[issue.severity]}>
              {SEVERITY_ICON[issue.severity]}
            </span>
            <span className="issue__text">
              <span>{issue.message}</span>
              {issue.hint && <span className="issue__hint">{issue.hint}</span>}
            </span>
          </>
        )
        return (
          <li key={issue.id} className={`issue issue--${issue.severity}`} data-severity={issue.severity}>
            {target && onSelect ? (
              <button type="button" className="issue__button" onClick={() => onSelect(target)}>
                {content}
              </button>
            ) : (
              <div className="issue__button">{content}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function ValidationPanel({ issues, placedCount, onSelect }: ValidationPanelProps) {
  const counts = countIssues(issues)
  return (
    <div className="validation-panel" data-testid="validation-panel">
      <div className="validation-summary">
        <span className="validation-summary__item validation-summary__item--error">오류 {counts.error}</span>
        <span className="validation-summary__item validation-summary__item--warning">경고 {counts.warning}</span>
        <span className="validation-summary__item validation-summary__item--info">정보 {counts.info}</span>
      </div>
      {placedCount === 0 ? (
        <p className="empty-note">부품을 배치하면 전기적 검사 결과가 표시됩니다.</p>
      ) : counts.error + counts.warning === 0 ? (
        <p className="callout callout--ok">오류나 경고가 없습니다.</p>
      ) : null}
      <IssueList issues={issues} onSelect={onSelect} />
      <p className="muted small validation-panel__disclaimer">
        이 검사는 부품 데이터의 규칙과 대표값을 기준으로 합니다. 실제 제품 사양은 데이터시트로 확인하세요.
      </p>
    </div>
  )
}
