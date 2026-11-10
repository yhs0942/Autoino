import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SimStore } from './simStore'
import './Simulation.css'

interface SimBarProps {
  store: SimStore
  boardLabels: Record<string, string>
  onStop: () => void
  /** 백엔드의 직류 회로 계산 (전압·전류) */
  onOpenAnalysis: () => void
}

/** 부저가 울리는 동안 소리를 낸다 (켜 둔 경우) */
function useBuzzerSound(store: SimStore, enabled: boolean) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const on = enabled && snapshot.running && [...snapshot.view.modules.values()].some((v) => v.kind === 'buzzer' && v.on)
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

/** 시뮬레이션 조작 막대와 시리얼 모니터 */
export function SimBar({ store, boardLabels, onStop, onOpenAnalysis }: SimBarProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [monitor, setMonitor] = useState(true)
  const [sound, setSound] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  useBuzzerSound(store, sound)
  const seconds = (snapshot.view.t / 1000).toFixed(1)
  const views = [...snapshot.view.modules.values()]
  const bad = views.filter((v) => !v.ok).length
  const lines = snapshot.serial.slice(-120)
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length, monitor])
  const multi = Object.keys(boardLabels).length > 1
  return (
    <section className="sim-bar" aria-label="시뮬레이션" data-testid="sim-bar">
      <div className="sim-bar__row">
        <strong className="sim-bar__title">
          <span className={`sim-dot${snapshot.running ? ' is-running' : ''}`} /> 시뮬레이션
        </strong>
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
        <span className={`sim-bar__summary${bad ? ' is-bad' : ''}`} data-testid="sim-summary">
          {bad ? `동작하지 않는 부품 ${bad}개 (카드의 ⚠ 를 확인하세요)` : `부품 ${views.length}개 모두 동작`}
        </span>
        <span className="sim-bar__spacer" />
        <label className="sim-bar__check">
          <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> 소리
        </label>
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
      {monitor && (
        <div className="sim-monitor" ref={logRef} data-testid="sim-monitor" aria-live="off">
          {lines.length ? (
            lines.map((l, i) => (
              <div key={`${l.t}-${i}`}>
                <span className="sim-monitor__t">{(l.t / 1000).toFixed(2)}</span>
                {multi && <span className="sim-monitor__board">{boardLabels[l.board] ?? l.board}</span>}
                {l.text}
              </div>
            ))
          ) : (
            <div className="muted">아직 출력이 없습니다.</div>
          )}
        </div>
      )}
      <p className="sim-bar__note">
        생성 코드의 예시 동작(LED 깜박임, 모터 정·역회전, 서보 왕복, 센서 값 출력 등)을 그대로 돌립니다. 센서·버튼은 카드에서 조작할 수 있고, 배선·전원이 맞지 않는 부품은 움직이지 않고 이유를 보여 줍니다. 시뮬레이션 중에는 배선을 고칠 수 없습니다.
      </p>
    </section>
  )
}
