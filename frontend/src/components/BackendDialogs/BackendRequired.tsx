import type { BackendStatus } from '../../api/useBackend'

interface BackendRequiredProps {
  status: BackendStatus
  feature: string
  onRecheck: () => void
}

/** 백엔드가 꺼져 있을 때 보여 주는 안내 */
export function BackendRequired({ status, feature, onRecheck }: BackendRequiredProps) {
  if (status.state === 'checking') return <p className="muted">백엔드 서버 연결을 확인하는 중…</p>
  return (
    <div className="backend-required" data-testid="backend-required">
      <p className="callout callout--warning">
        {feature}은(는) 파이썬 백엔드 서버가 필요합니다. 지금은 서버에 연결되어 있지 않습니다. 회로 편집·검사·내보내기는 서버 없이도 됩니다.
      </p>
      <p className="small">저장소 루트에서 서버를 실행한 뒤 다시 확인하세요.</p>
      <pre className="code-block code-block--small">{'cd backend\npython -m venv .venv && .venv/bin/pip install -r requirements.txt\n.venv/bin/python -m autoino serve'}</pre>
      <button type="button" className="button button--small" onClick={onRecheck} data-testid="backend-recheck">
        다시 확인
      </button>
    </div>
  )
}
