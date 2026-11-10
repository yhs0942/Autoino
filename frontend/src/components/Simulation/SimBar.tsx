import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CodePanel, type CodeBoard } from './CodePanel'
import type { SimMode, SimStore } from './simStore'
import './Simulation.css'

interface SimBarProps {
  store: SimStore
  boardLabels: Record<string, string>
  onStop: () => void
  /** 백엔드의 직류 회로 계산 (전압·전류) */
  onOpenAnalysis: () => void
  mode: SimMode
  onModeChange: (mode: SimMode) => void
  boards: CodeBoard[]
  sketches: Record<string, string>
  onRunCode: (drafts: Record<string, string>) => void
  onLoadExample: (boardId: string) => Promise<string | null>
  onOpenPrompt: () => void
}

const LF = String.fromCharCode(10)
const CRLF = String.fromCharCode(13, 10)

/** 부저가 울리는 동안 소리를 낸다 (켜 둔 경우) */
function useBuzzerSound(store: SimStore, enabled: boolean) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const views = [...snapshot.view.modules.values()]
  const on = enabled && snapshot.running && views.some((v) => v.kind === 'buzzer' && v.on)
  const audio = useRef<{ ctx: AudioContext; osc: OscillatorNode; gain: GainNode } | null>(null)
  useEffect(() => {
    if (!enabled) return
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = 2300
    gain.gain.value = 0
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    audio.current = { ctx, osc, gain }
    return () => {
      osc.stop()
      void ctx.close()
      audio.current = null
    }
  }, [enabled])
  useEffect(() => {
    if (audio.current) audio.current.gain.gain.value = on ? 0.03 : 0
  }, [on])
}

/** 시뮬레이션 조작 막대, 코드 편집기, 시리얼 모니터 */
export function SimBar({ store, boardLabels, onStop, onOpenAnalysis, mode, onModeChange, boards, sketches, onRunCode, onLoadExample, onOpenPrompt }: SimBarProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [monitor, setMonitor] = useState(true)
  const [editor, setEditor] = useState(true)
  const [sound, setSound] = useState(false)
  const [sendText, setSendText] = useState('')
  const [sendBoard, setSendBoard] = useState(boards[0]?.instanceId ?? '')
  const [ending, setEnding] = useState<string>(LF)
  const logRef = useRef<HTMLDivElement>(null)
  useBuzzerSound(store, sound)
  const seconds = (snapshot.view.t / 1000).toFixed(1)
  const views = [...snapshot.view.modules.values()]
  const bad = views.filter((v) => !v.ok).length
  const lines = snapshot.serial.slice(-150)
  const lastText = lines.at(-1)?.text
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length, lastText, monitor])
  const multi = Object.keys(boardLabels).length > 1
  const codeMode = mode === 'code'
  const code = snapshot.code ?? []
  const codeBad = code.filter((c) => c.state === 'compile-error' || c.state === 'error').length
  const noCode = codeMode && code.length > 0 && code.every((c) => c.state === 'no-code')
  const summary = codeMode && codeBad ? `코드 오류 ${codeBad}개 (아래 편집기를 확인하세요)` : noCode ? '코드가 없습니다 — 아래 편집기에 코드를 넣고 ▶ 실행' : bad ? `동작하지 않는 부품 ${bad}개 (카드의 ⚠ 를 확인하세요)` : `부품 ${views.length}개 모두 동작`

  return (
    <section className={`sim-bar${codeMode ? ' is-code' : ''}`} aria-label="시뮬레이션" data-testid="sim-bar">
      <div className="sim-bar__row">
        <strong className="sim-bar__title">
          <span className={`sim-dot${snapshot.running ? ' is-running' : ''}`} /> 시뮬레이션
        </strong>
        <div className="segmented" role="group" aria-label="무엇을 실행할지">
          <button type="button" aria-pressed={!codeMode} onClick={() => onModeChange('demo')} title="자동 생성 코드의 예시 동작을 그대로 보여 줍니다" data-testid="sim-mode-demo">
            예시 동작
          </button>
          <button type="button" aria-pressed={codeMode} onClick={() => onModeChange('code')} title="보드마다 넣은 아두이노 코드를 실제로 실행합니다" data-testid="sim-mode-code">
            내 코드 실행
          </button>
        </div>
        <button type="button" className="button button--small" onClick={() => store.setRunning(!snapshot.running)} data-testid="sim-pause">
          {snapshot.running ? '⏸ 일시 정지' : '▶ 계속'}
        </button>
        <button type="button" className="button button--small" onClick={() => store.restart()} data-testid="sim-restart">
          ⟲ 처음부터
        </button>
        <label className="sim-bar__speed">
          속도
          <select value={snapshot.speed} onChange={(e) => store.setSpeed(Number(e.target.value))}>
            {[0.25, 0.5, 1, 2, 4].map((s) => (
              <option key={s} value={s}>
                ×{s}
              </option>
            ))}
          </select>
        </label>
        <span className="sim-bar__time" data-testid="sim-time">
          {seconds} s
        </span>
        <span className={`sim-bar__summary${bad || codeBad || noCode ? ' is-bad' : ''}`} data-testid="sim-summary">
          {summary}
        </span>
        <span className="sim-bar__spacer" />
        <label className="sim-bar__check">
          <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> 소리
        </label>
        {codeMode && (
          <button type="button" className="button button--small" onClick={() => setEditor(!editor)} aria-pressed={editor} data-testid="sim-editor-toggle">
            코드 편집기
          </button>
        )}
        <button type="button" className="button button--small" onClick={() => setMonitor(!monitor)} aria-pressed={monitor} data-testid="sim-monitor-toggle">
          시리얼 모니터
        </button>
        <button type="button" className="button button--small" onClick={onOpenAnalysis} title="백엔드로 전압·전류를 계산합니다">
          전기 계산
        </button>
        <button type="button" className="button button--small button--primary" onClick={onStop} data-testid="sim-stop">
          종료
        </button>
      </div>
      <div className="sim-bar__body">
        {codeMode && editor && <CodePanel boards={boards} sketches={sketches} status={snapshot.code} onRun={onRunCode} onLoadExample={onLoadExample} onOpenPrompt={onOpenPrompt} />}
        {monitor && (
          <div className="sim-monitor-wrap">
            <div className="sim-monitor" ref={logRef} data-testid="sim-monitor" aria-live="off">
              {lines.length ? (
                lines.map((l, i) => (
                  <div key={`${l.t}-${i}`} className={l.text.startsWith('> ') ? 'is-sent' : ''}>
                    <span className="sim-monitor__t">{(l.t / 1000).toFixed(2)}</span>
                    {multi && <span className="sim-monitor__board">{boardLabels[l.board] ?? l.board}</span>}
                    {l.text}
                  </div>
                ))
              ) : (
                <div className="muted">아직 출력이 없습니다.</div>
              )}
            </div>
            {codeMode && (
              <form
                className="sim-monitor__send"
                onSubmit={(e) => {
                  e.preventDefault()
                  store.sendSerial(sendBoard || boards[0]?.instanceId, `${sendText}${ending}`)
                  setSendText('')
                }}
              >
                {multi && (
                  <select value={sendBoard} onChange={(e) => setSendBoard(e.target.value)} aria-label="보낼 보드">
                    {boards.map((b) => (
                      <option key={b.instanceId} value={b.instanceId}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                )}
                <input value={sendText} onChange={(e) => setSendText(e.target.value)} placeholder="보드로 보낼 글자 (Serial.read)" data-testid="sim-serial-input" />
                <select value={ending} onChange={(e) => setEnding(e.target.value)} aria-label="줄 끝">
                  <option value={LF}>새 줄(LF)</option>
                  <option value={CRLF}>CR+LF</option>
                  <option value="">없음</option>
                </select>
                <button type="submit" className="button button--small">
                  보내기
                </button>
              </form>
            )}
          </div>
        )}
      </div>
      <p className="sim-bar__note">
        {codeMode
          ? '보드마다 넣은 아두이노 코드를 실제로 실행합니다. 코드가 핀에 쓴 값이 배선을 따라 부품을 움직이고, 버튼·센서 조작은 코드가 읽는 값이 됩니다. Servo·LCD·OLED·NeoPixel·DHT 등 자주 쓰는 라이브러리를 지원합니다.'
          : '생성 코드의 예시 동작(LED 깜박임, 모터 정·역회전, 서보 왕복, 센서 값 출력 등)을 그대로 돌립니다. 센서·버튼은 카드에서 조작할 수 있고, 배선·전원이 맞지 않는 부품은 움직이지 않고 이유를 보여 줍니다. 시뮬레이션 중에는 배선을 고칠 수 없습니다.'}
      </p>
    </section>
  )
}
