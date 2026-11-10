import { useMemo, useState } from 'react'
import { getBoard } from '../../data/boards'
import { buildAiPrompt, extractSketches, type ExtractedSketch } from '../../engine/aiPrompt'
import type { Circuit } from '../../engine/circuit'
import { Modal } from '../common/Modal'
import './AiPromptDialog.css'

interface AiPromptDialogProps {
  circuit: Circuit
  /** 처음에 고를 보드 (없으면 모든 보드) */
  initialBoard?: string
  onApply: (sketches: ExtractedSketch[]) => void
  onClose: () => void
}

const EXAMPLES = ['버튼을 누를 때마다 LED 를 켜고 끄기', '가변저항을 돌리면 서보 각도가 따라가기', '초음파 센서 거리를 LCD 에 표시하고 20 cm 보다 가까우면 부저 울리기', '온습도를 1초마다 시리얼 모니터에 출력']

/** 다른 생성형 AI 로 코드를 만드는 창: ① 프롬프트 복사 → ② AI 답변 붙여넣기 → 시뮬레이션 */
export function AiPromptDialog({ circuit, initialBoard, onApply, onClose }: AiPromptDialogProps) {
  const [goal, setGoal] = useState('')
  const [board, setBoard] = useState(initialBoard && circuit.boards.length > 1 ? initialBoard : '')
  const [copied, setCopied] = useState(false)
  const [answer, setAnswer] = useState('')
  const prompt = useMemo(() => buildAiPrompt(circuit, { goal, board: board || undefined }), [circuit, goal, board])
  const boards = circuit.boards.map((b) => ({ instanceId: b.instanceId, label: b.label }))
  const found = useMemo(() => (answer.trim() ? extractSketches(answer, boards, board || undefined) : []), [answer, boards, board])

  const copy = async () => {
    let ok = false
    try {
      await navigator.clipboard.writeText(prompt)
      ok = true
    } catch {
      // 클립보드 API 를 막은 브라우저: 글자를 골라 복사 명령으로
      const area = document.querySelector<HTMLTextAreaElement>('[data-testid="ai-prompt"]')
      if (area) {
        area.focus()
        area.select()
        ok = document.execCommand('copy')
      }
    }
    setCopied(ok)
    if (ok) window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <Modal
      title="AI 로 아두이노 코드 만들기"
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            닫기
          </button>
          <button type="button" className="button button--primary" disabled={!found.length} onClick={() => onApply(found)} data-testid="ai-apply">
            코드 넣고 시뮬레이션
          </button>
        </>
      }
    >
      <div className="ai-prompt" data-testid="ai-prompt-dialog">
        <section className="ai-step">
          <h3>
            <span className="ai-step__no">1</span> 만들고 싶은 동작을 적고 프롬프트를 복사하세요
          </h3>
          <p className="muted small">지금 배선(보드·부품·핀 번호·전원·보드 간 통신)이 프롬프트에 들어갑니다. ChatGPT · Gemini · Claude 같은 생성형 AI 에 그대로 붙여 넣으면 이 회로에 맞는 코드를 받을 수 있습니다.</p>
          {circuit.boards.length > 1 && (
            <label className="ai-field">
              코드를 만들 보드
              <select value={board} onChange={(e) => setBoard(e.target.value)} data-testid="ai-board">
                <option value="">모든 보드 (보드마다 코드 하나씩)</option>
                {circuit.boards.map((b) => (
                  <option key={b.instanceId} value={b.instanceId}>
                    {b.label} · {getBoard(b.boardId).name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="ai-field">
            만들고 싶은 동작
            <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} placeholder="예: 버튼을 누르면 LED 가 3초 동안 켜지고, 그동안 서보가 90° 로 돌아간다" data-testid="ai-goal" />
          </label>
          <div className="ai-examples">
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="chip" onClick={() => setGoal(ex)}>
                {ex}
              </button>
            ))}
          </div>
          <div className="ai-prompt__head">
            <strong className="small">프롬프트</strong>
            <span className="muted small">{prompt.split('\n').length}줄</span>
            <button type="button" className="button button--small button--primary" onClick={() => void copy()} data-testid="ai-copy">
              {copied ? '복사했습니다' : '프롬프트 복사'}
            </button>
          </div>
          <textarea className="ai-prompt__text" readOnly value={prompt} rows={12} onFocus={(e) => e.currentTarget.select()} data-testid="ai-prompt" />
        </section>
        <section className="ai-step">
          <h3>
            <span className="ai-step__no">2</span> AI 의 답변을 그대로 붙여 넣으세요
          </h3>
          <p className="muted small">답변 전체를 붙여 넣어도 됩니다. 코드 블록(```)만 골라 {circuit.boards.length > 1 ? '보드 이름 주석(// 보드 1)을 보고 보드마다' : '보드에'} 넣습니다.</p>
          <textarea className="ai-answer" value={answer} onChange={(e) => setAnswer(e.target.value)} rows={8} placeholder={'```cpp\nvoid setup() { … }\nvoid loop() { … }\n```'} data-testid="ai-answer" />
          {answer.trim() && (
            <ul className="ai-found small" data-testid="ai-found">
              {found.length ? (
                found.map((f) => (
                  <li key={f.board}>
                    ✓ {circuit.boards.find((b) => b.instanceId === f.board)?.label}: 코드 {f.code.split('\n').length}줄
                  </li>
                ))
              ) : (
                <li className="is-bad">코드를 찾지 못했습니다. void setup() 이 들어 있는 코드를 붙여 넣으세요.</li>
              )}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  )
}
