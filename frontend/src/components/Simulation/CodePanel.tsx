import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import type { CodeStatus } from '../../engine/sim/codeRuntime'
import { pastedSketches } from '../../engine/setupText'
import { downloadText } from '../../utils/download'

// 보드마다 아두이노 코드를 넣고 실행하는 편집기 (시뮬레이션 막대 안)

export interface CodeBoard {
  instanceId: string
  label: string
  boardName: string
}

interface CodePanelProps {
  boards: CodeBoard[]
  /** 실행에 쓰는 (저장된) 코드 */
  sketches: Record<string, string>
  status: CodeStatus[] | null
  /** 고친 코드로 다시 실행 */
  onRun: (drafts: Record<string, string>) => void
  /** 백엔드가 만든 예시 코드 (없으면 null) */
  onLoadExample: (boardId: string) => Promise<string | null>
  /** 회로 설정 글 (AI 에 붙여 넣을 것) */
  onOpenSetupText: () => void
}

const STATE_LABEL: Record<CodeStatus['state'], string> = {
  'no-code': '코드 없음',
  'compile-error': '컴파일 오류',
  running: '실행 중',
  error: '실행 중 멈춤',
  stopped: '끝남',
}

export function CodePanel({ boards, sketches, status, onRun, onLoadExample, onOpenSetupText }: CodePanelProps) {
  const [picked, setActive] = useState(boards[0]?.instanceId ?? '')
  const active = boards.some((b) => b.instanceId === picked) ? picked : (boards[0]?.instanceId ?? '')
  const [drafts, setDrafts] = useState<Record<string, string>>(sketches)
  const [loading, setLoading] = useState(false)
  const [note, setNote] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)
  const gutter = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [committed, setCommitted] = useState(sketches)

  // 밖에서 코드가 바뀌면 (AI 답변 붙여넣기, 예시 코드로 실행 등) 편집 중이 아닌 보드는 따라간다
  if (committed !== sketches) {
    const next = { ...drafts }
    for (const b of boards) if ((drafts[b.instanceId] ?? '') === (committed[b.instanceId] ?? '')) next[b.instanceId] = sketches[b.instanceId] ?? ''
    setCommitted(sketches)
    setDrafts(next)
  }

  const code = drafts[active] ?? ''
  const st = status?.find((s) => s.board === active)
  const lines = code.split('\n').length
  const errorLines = new Set([...(st?.errors ?? []).map((e) => e.line), ...(st?.fault ? [st.fault.line] : [])])
  const warnLines = new Set((st?.warnings ?? []).map((w) => w.line))
  const dirty = boards.some((b) => (drafts[b.instanceId] ?? '') !== (sketches[b.instanceId] ?? ''))

  const setCode = (value: string) => setDrafts((d) => ({ ...d, [active]: value }))
  const run = () => {
    onRun(drafts)
    setNote('')
  }
  const jump = (line: number) => {
    const el = area.current
    if (!el) return
    const parts = code.split('\n')
    const start = parts.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0)
    el.focus()
    el.setSelectionRange(start, start + (parts[line - 1]?.length ?? 0))
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 16
    el.scrollTop = Math.max(0, (line - 4) * lineHeight)
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      run()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const el = e.currentTarget
      const { selectionStart: s, selectionEnd: t } = el
      const next = `${code.slice(0, s)}  ${code.slice(t)}`
      setCode(next)
      requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2))
    }
  }
  // AI 답변을 통째로 붙여 넣으면 설명은 빼고 코드 블록만 (보드마다 블록이 있으면 나눠서)
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const found = pastedSketches(e.clipboardData.getData('text/plain'), boards, active)
    if (!found) return
    e.preventDefault()
    const { selectionStart: s, selectionEnd: t } = e.currentTarget
    const next = { ...drafts }
    for (const f of found) next[f.board] = f.board === active ? `${code.slice(0, s)}${f.code}${code.slice(t)}` : f.code
    setDrafts(next)
    const others = found.filter((f) => f.board !== active).map((f) => boards.find((b) => b.instanceId === f.board)?.label)
    setNote(`붙여 넣은 글에서 코드 블록만 골라 넣었습니다${others.length ? ` (${others.join(', ')} 코드는 그 보드 탭에)` : ''}. [▶ 고친 코드로 실행] 을 누르세요.`)
  }
  const loadExample = async () => {
    setLoading(true)
    setNote('')
    try {
      const example = await onLoadExample(active)
      if (example) setCode(example)
      else setNote('예시 코드를 만들려면 서버(백엔드)가 필요합니다.')
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }
  const board = boards.find((b) => b.instanceId === active)

  return (
    <div className="code-panel" data-testid="code-panel">
      <div className="code-panel__bar">
        {boards.length > 1 && (
          <div className="segmented" role="tablist" aria-label="코드를 넣을 보드">
            {boards.map((b) => {
              const s = status?.find((x) => x.board === b.instanceId)
              return (
                <button key={b.instanceId} type="button" role="tab" aria-selected={b.instanceId === active} aria-pressed={b.instanceId === active} onClick={() => setActive(b.instanceId)} data-testid={`code-tab-${b.instanceId}`}>
                  <span className={`code-dot is-${s?.state ?? 'no-code'}`} /> {b.label}
                </button>
              )
            })}
          </div>
        )}
        <span className="code-panel__board small">
          {board?.label} · {board?.boardName}
        </span>
        <span className={`code-state is-${st?.state ?? 'no-code'}`} data-testid="code-state">
          {STATE_LABEL[st?.state ?? 'no-code']}
          {st?.state === 'running' && st.lagMs > 300 ? ' · 실제보다 느림' : ''}
        </span>
        <span className="sim-bar__spacer" />
        <button type="button" className="button button--small button--primary" onClick={run} title="Ctrl+Enter" data-testid="code-run">
          ▶ {dirty ? '고친 코드로 실행' : '다시 실행'}
        </button>
        <button type="button" className="button button--small" onClick={() => void loadExample()} disabled={loading} data-testid="code-example">
          {loading ? '불러오는 중…' : '예시 코드 불러오기'}
        </button>
        <button type="button" className="button button--small" onClick={onOpenSetupText} title="회로 설정을 글로 정리해 ChatGPT 같은 AI 에 붙여 넣을 수 있게 합니다" data-testid="code-setup-text">
          AI용 설정 복사
        </button>
        <button type="button" className="button button--small" onClick={() => fileRef.current?.click()}>
          .ino 열기
        </button>
        <button type="button" className="button button--small" onClick={() => downloadText(`${(board?.label ?? 'board').replace(/\s+/g, '_')}.ino`, code, 'text/plain')} disabled={!code.trim()}>
          .ino 저장
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".ino,.cpp,.c,.txt"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) setCode(await file.text())
          }}
        />
      </div>
      <div className="code-editor">
        <div className="code-editor__gutter" ref={gutter} aria-hidden="true">
          {Array.from({ length: lines }, (_, i) => (
            <div key={i} className={errorLines.has(i + 1) ? 'is-error' : warnLines.has(i + 1) ? 'is-warn' : ''}>
              {i + 1}
            </div>
          ))}
        </div>
        <textarea
          ref={area}
          className="code-editor__text"
          value={code}
          spellCheck={false}
          wrap="off"
          placeholder={'void setup() {\n  pinMode(13, OUTPUT);\n}\n\nvoid loop() {\n  digitalWrite(13, HIGH);\n  delay(500);\n  digitalWrite(13, LOW);\n  delay(500);\n}\n\n여기에 아두이노 코드를 붙여 넣으세요 (AI 답변을 통째로 붙여 넣어도 코드만 골라 넣습니다). [AI용 설정 복사] 로 회로 설정을 AI 에 알려 줄 수 있습니다.'}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop
          }}
          aria-label={`${board?.label ?? ''} 코드`}
          data-testid="code-editor"
        />
      </div>
      {(note || dirty || st) && (
        <div className="code-messages" data-testid="code-messages">
          {note && <div className="code-msg is-warn" data-testid="code-note">{note}</div>}
          {dirty && <div className="code-msg is-info">코드를 고쳤습니다. [▶ 고친 코드로 실행] 을 누르면 처음부터 다시 실행합니다.</div>}
          {st?.errors.map((e, i) => (
            <button key={`e${i}`} type="button" className="code-msg is-error" onClick={() => jump(e.line)} data-testid="code-error">
              <strong>{e.line}번째 줄</strong> {e.message}
            </button>
          ))}
          {st?.fault && (
            <button type="button" className="code-msg is-error" onClick={() => jump(st.fault!.line)} data-testid="code-fault">
              <strong>실행 중 멈춤 · {st.fault.line}번째 줄</strong> {st.fault.message}
            </button>
          )}
          {st?.warnings.map((w, i) => (
            <button key={`w${i}`} type="button" className="code-msg is-warn" onClick={() => w.line && jump(w.line)}>
              {w.line ? <strong>{w.line}번째 줄</strong> : null} {w.message}
            </button>
          ))}
          {st?.hints.map((h, i) => (
            <div key={`h${i}`} className="code-msg is-info" data-testid="code-hint">
              배선 확인: {h}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
