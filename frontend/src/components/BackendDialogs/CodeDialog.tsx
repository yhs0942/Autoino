import { useEffect, useState } from 'react'
import { api, type Sketch } from '../../api/client'
import type { BackendStatus } from '../../api/useBackend'
import type { ProjectFile } from '../../engine/project'
import { downloadText } from '../../utils/download'
import { Modal } from '../common/Modal'
import { BackendRequired } from './BackendRequired'
import './BackendDialogs.css'

interface CodeDialogProps {
  status: BackendStatus
  project: ProjectFile
  errorCount: number
  onRecheck: () => void
  onClose: () => void
}

type Load = { state: 'loading' } | { state: 'done'; sketches: Sketch[] } | { state: 'error'; message: string }

/** 보드별 Arduino 스케치 (백엔드 /api/codegen) */
export function CodeDialog({ status, project, errorCount, onRecheck, onClose }: CodeDialogProps) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [active, setActive] = useState(0)
  const [copied, setCopied] = useState(false)
  const online = status.state === 'online'

  useEffect(() => {
    if (!online) return
    let cancelled = false
    api
      .codegen(project)
      .then((r) => !cancelled && setLoad({ state: 'done', sketches: r.sketches }))
      .catch((err: unknown) => !cancelled && setLoad({ state: 'error', message: err instanceof Error ? err.message : String(err) }))
    return () => {
      cancelled = true
    }
  }, [online, project])

  const sketch = load.state === 'done' ? load.sketches[Math.min(active, load.sketches.length - 1)] : undefined

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Modal
      title="Arduino 코드 생성"
      size="wide"
      onClose={onClose}
      footer={
        <button type="button" className="button" onClick={onClose}>
          닫기
        </button>
      }
    >
      {!online ? (
        <BackendRequired status={status} feature="코드 생성" onRecheck={onRecheck} />
      ) : load.state === 'loading' ? (
        <p className="muted">코드를 만드는 중…</p>
      ) : load.state === 'error' ? (
        <p className="callout callout--error" data-testid="code-error">
          {load.message}
        </p>
      ) : sketch ? (
        <>
          {errorCount > 0 && (
            <p className="callout callout--error">검사 오류가 {errorCount}개 있습니다. 배선을 고친 뒤 다시 생성하는 것이 좋습니다.</p>
          )}
          {load.sketches.length > 1 && (
            <div className="segmented backend-boards" role="group" aria-label="보드 선택">
              {load.sketches.map((s, i) => (
                <button key={s.boardInstanceId} type="button" aria-pressed={s === sketch} onClick={() => setActive(i)} data-testid={`code-board-${i}`}>
                  {s.boardLabel} · {s.boardName}
                </button>
              ))}
            </div>
          )}
          <div className="code-toolbar">
            <span className="small">
              <strong>{sketch.filename}</strong> · {sketch.boardName} ({sketch.core} 코어)
            </span>
            <span className="code-toolbar__buttons">
              <button type="button" className="button button--small" onClick={() => void copy(sketch.code)}>
                {copied ? '복사됨' : '복사'}
              </button>
              <button
                type="button"
                className="button button--primary button--small"
                data-testid="code-download"
                onClick={() => downloadText(sketch.filename, sketch.code, 'text/plain')}
              >
                .ino 받기
              </button>
            </span>
          </div>
          {sketch.warnings.length > 0 && (
            <ul className="callout callout--warning backend-list" data-testid="code-warnings">
              {sketch.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <pre className="code-block" data-testid="code-view">
            {sketch.code}
          </pre>
          <h3 className="small-heading">필요한 라이브러리</h3>
          {sketch.libraries.length ? (
            <ul className="backend-list small">
              {sketch.libraries.map((lib) => (
                <li key={lib.name}>
                  <strong>{lib.name}</strong> — {lib.install}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">추가 라이브러리가 필요 없습니다.</p>
          )}
          <p className="muted small">
            생성된 코드는 배선을 확인하기 위한 동작 예시입니다. Arduino IDE 에서 보드를 선택하고 컴파일해 확인하세요. Autoino 는 실제 보드용 컴파일을 하지 않습니다.
          </p>
        </>
      ) : (
        <p className="muted">코드를 만들 보드가 없습니다.</p>
      )}
    </Modal>
  )
}
