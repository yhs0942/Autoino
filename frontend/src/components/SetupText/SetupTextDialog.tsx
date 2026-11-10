import { useMemo, useRef, useState } from 'react'
import { getBoard } from '../../data/boards'
import type { Circuit } from '../../engine/circuit'
import { buildSetupText } from '../../engine/setupText'
import { loadPreference, savePreference } from '../../utils/preferences'
import { Modal } from '../common/Modal'
import './SetupTextDialog.css'

interface SetupTextDialogProps {
  circuit: Circuit
  /** 처음에 고를 보드 (없으면 모든 보드) */
  initialBoard?: string
  /** 시뮬레이션의 코드 편집기를 연다 (AI 가 만든 코드를 붙여 넣는 곳) */
  onOpenEditor: () => void
  onClose: () => void
}

/** 지금 회로 설정을 글로 정리해 보여 주는 창. 사용자가 복사해서 생성형 AI 에 보내는 글에 붙여 넣는다. */
export function SetupTextDialog({ circuit, initialBoard, onOpenEditor, onClose }: SetupTextDialogProps) {
  const [board, setBoard] = useState(initialBoard && circuit.boards.length > 1 ? initialBoard : '')
  const [simulator, setSimulator] = useState(() => loadPreference('setupTextSimulator') === 'on')
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const text = useMemo(() => buildSetupText(circuit, { board: board || undefined, simulator }), [circuit, board, simulator])

  const changeSimulator = (on: boolean) => {
    setSimulator(on)
    savePreference('setupTextSimulator', on ? 'on' : 'off')
  }

  const copy = async () => {
    let ok = false
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch {
      // 클립보드 API 를 막은 브라우저: 글자를 모두 골라 복사 명령으로
      const el = area.current
      if (el) {
        el.focus()
        el.select()
        try {
          ok = document.execCommand('copy')
        } catch {
          ok = false
        }
      }
    }
    setCopied(ok ? 'ok' : 'fail')
    window.setTimeout(() => setCopied(null), ok ? 1800 : 4000)
  }

  return (
    <Modal
      title="AI 에 붙여 넣을 회로 설정"
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            닫기
          </button>
          <button type="button" className="button" onClick={onOpenEditor} title="시뮬레이션의 [내 코드 실행] 편집기를 엽니다. AI 답변을 통째로 붙여 넣어도 코드만 골라 넣습니다." data-testid="setup-open-editor">
            AI 가 만든 코드 넣기
          </button>
          <button type="button" className="button button--primary" onClick={() => void copy()} data-testid="setup-copy">
            {copied === 'ok' ? '복사했습니다' : '설정 복사'}
          </button>
        </>
      }
    >
      <div className="setup-text" data-testid="setup-dialog">
        <p className="muted small">
          지금 회로의 보드·부품·핀 연결·전원을 글로 정리했습니다. 복사해서 ChatGPT · Gemini · Claude 같은 생성형 AI 에 보내는 글에 붙여 넣으세요. 예: “아래 회로로 버튼을 누르면 LED 가 3초 동안 켜지는 아두이노 코드를 만들어 줘.” 다음 줄에 붙여 넣기.
        </p>
        <div className="setup-text__options">
          {circuit.boards.length > 1 && (
            <label className="setup-text__field">
              정리할 보드
              <select value={board} onChange={(e) => setBoard(e.target.value)} data-testid="setup-board">
                <option value="">모든 보드</option>
                {circuit.boards.map((b) => (
                  <option key={b.instanceId} value={b.instanceId}>
                    {b.label} · {getBoard(b.boardId).name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="setup-text__check" title="AI 가 Autoino 시뮬레이터에서 바로 돌아가는 코드를 만들도록, 쓸 수 있는 라이브러리와 지원하지 않는 기능을 덧붙입니다">
            <input type="checkbox" checked={simulator} onChange={(e) => changeSimulator(e.target.checked)} data-testid="setup-simulator" /> 시뮬레이터 조건 덧붙이기 (쓸 수 있는 라이브러리 등)
          </label>
          <span className="muted small setup-text__count">{text.trimEnd().split('\n').length}줄</span>
        </div>
        <textarea ref={area} className="setup-text__body" readOnly value={text} rows={18} spellCheck={false} onFocus={(e) => e.currentTarget.select()} aria-label="회로 설정" data-testid="setup-text" />
        {copied === 'fail' && (
          <p className="setup-text__fail small" role="alert">
            이 브라우저에서는 자동 복사가 막혀 있습니다. 위 글이 모두 선택되어 있으니 Ctrl+C 로 복사하세요.
          </p>
        )}
        <p className="muted small">AI 가 만든 코드는 [AI 가 만든 코드 넣기] → 시뮬레이션의 코드 편집기에 붙여 넣으면 실행됩니다. 답변을 통째로 붙여 넣어도 코드 블록만 골라 넣습니다.</p>
      </div>
    </Modal>
  )
}
