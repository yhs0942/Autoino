import { useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { BEHAVIOR } from '../../engine/sim/behavior'
import type { ModuleView } from '../../engine/sim/runtime'
import type { SimStore } from './simStore'

// 시뮬레이션 중 부품 카드 안에 그리는 동작 모습과 입력 조작

const LED_COLORS: Record<string, string> = { red: '#ef4444', green: '#22c55e', blue: '#3b82f6', yellow: '#facc15', white: '#f8fafc', orange: '#f97316' }
const stop = (e: ReactPointerEvent) => e.stopPropagation()

/** 회전 각도 (보이는 속도는 너무 빠르지 않게 줄인다) */
function spinAngle(t: number, rpm: number, speed: number, cap: number): number {
  const rps = Math.min(Math.abs(rpm) / 60, cap)
  return ((t / 1000) * rps * 360 * Math.sign(speed)) % 360
}

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg className="sim-svg" viewBox="0 0 64 40" width={64} height={40} aria-hidden="true">
      {children}
    </svg>
  )
}

function Led({ on, color = '#ef4444', label }: { on: boolean; color?: string; label?: string }) {
  return (
    <span className={`sim-led${on ? ' is-on' : ''}`} style={{ ['--led' as string]: color }} title={label}>
      {label && <span className="sim-led__label">{label}</span>}
    </span>
  )
}

function Slider({ label, value, min, max, step = 1, unit = '', onChange, testId }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void; testId?: string }) {
  return (
    <label className="sim-slider">
      <span>
        {label} <strong>{Math.round(value * 10) / 10}{unit}</strong>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} onPointerDown={stop} data-testid={testId} />
    </label>
  )
}

function HoldButton({ label, active, onChange, testId }: { label: string; active: boolean; onChange: (on: boolean) => void; testId?: string }) {
  return (
    <button
      type="button"
      className={`sim-hold${active ? ' is-active' : ''}`}
      onPointerDown={(e) => {
        e.stopPropagation()
        e.currentTarget.setPointerCapture(e.pointerId)
        onChange(true)
      }}
      onPointerUp={() => onChange(false)}
      onPointerCancel={() => onChange(false)}
      data-testid={testId}
    >
      {label}
    </button>
  )
}

function Visual({ view, store, id, t }: { view: ModuleView; store: SimStore; id: string; t: number }) {
  const set = (patch: Parameters<SimStore['setInput']>[1]) => store.setInput(id, patch)
  const input = store.input(id)
  switch (view.kind) {
    case 'led': {
      const color = LED_COLORS[view.color] ?? '#ef4444'
      return (
        <div className="sim-row">
          <Svg>
            <circle cx={20} cy={20} r={12} fill={view.on ? color : '#cbd5e1'} opacity={view.on ? 0.35 + 0.65 * view.level : 0.6} className={view.on ? 'sim-glow' : ''} style={{ ['--glow' as string]: color }} />
            <path d="M14 32v6M26 32v4" stroke="#94a3b8" strokeWidth={2} />
          </Svg>
        </div>
      )
    }
    case 'button':
      return (
        <div className="sim-row">
          <HoldButton label={view.pressed ? '누르는 중' : '눌러 보기'} active={view.pressed} onChange={(on) => set({ pressed: on })} testId={`sim-press-${id}`} />
        </div>
      )
    case 'relay':
      return (
        <div className="sim-row">
          <Svg>
            <rect x={2} y={8} width={18} height={24} rx={3} fill="#2563eb" />
            <circle cx={11} cy={4} r={3} fill={view.on ? '#ef4444' : '#7f1d1d'} />
            <circle cx={30} cy={20} r={2.5} fill="#334155" />
            <circle cx={58} cy={10} r={2.5} fill="#334155" />
            <circle cx={58} cy={30} r={2.5} fill="#334155" />
            <line x1={30} y1={20} x2={56} y2={view.on ? 11 : 29} stroke="#f59e0b" strokeWidth={2.5} strokeLinecap="round" />
            <text x={30} y={34} fontSize={6} fill="#64748b">COM</text>
            <text x={48} y={6} fontSize={6} fill="#64748b">NO</text>
            <text x={48} y={39} fontSize={6} fill="#64748b">NC</text>
          </Svg>
        </div>
      )
    case 'buzzer':
      return (
        <div className="sim-row">
          <Svg>
            <circle cx={16} cy={20} r={12} fill="#111827" />
            <circle cx={16} cy={20} r={3} fill="#475569" />
            {view.on && [0, 1, 2].map((i) => <path key={i} d={`M${32 + i * 8} 10 q 6 10 0 20`} stroke="#f59e0b" strokeWidth={2} fill="none" opacity={((t / 150 + i) % 3) / 3 + 0.2} />)}
          </Svg>
        </div>
      )
    case 'servo': {
      const horn = view.spin ? spinAngle(t, 60 * Math.abs(view.spin), view.spin, 1) : view.angle - 90
      const jitter = view.jitter && view.spin === 0 ? Math.sin(t / 25) * 4 : 0
      return (
        <div className="sim-row">
          <Svg>
            <rect x={4} y={12} width={40} height={20} rx={3} fill="#1d4ed8" />
            <circle cx={16} cy={22} r={6} fill="#e2e8f0" />
            <g transform={`rotate(${horn + jitter} 16 22)`}>
              <rect x={14} y={2} width={4} height={20} rx={2} fill="#f8fafc" stroke="#64748b" strokeWidth={0.8} />
            </g>
          </Svg>
          <span className="sim-big">{view.spin ? (view.spin > 0 ? '⟳' : view.spin < 0 ? '⟲' : '■') : `${view.angle}°`}</span>
        </div>
      )
    }
    case 'motor': {
      const running = view.speed !== 0
      if (view.style === 'pump')
        return (
          <div className="sim-row">
            <Svg>
              <rect x={6} y={14} width={22} height={22} rx={4} fill="#0f172a" />
              <path d="M28 20h10v-14h8" stroke="#94a3b8" strokeWidth={3} fill="none" />
              {running && [0, 1, 2].map((i) => <circle key={i} cx={50} cy={((t / 12 + i * 12) % 36) + 2} r={2.2} fill="#38bdf8" />)}
            </Svg>
          </div>
        )
      if (view.style === 'vibration') {
        const dx = running ? Math.sin(t / 9) * 2.5 : 0
        return (
          <div className="sim-row">
            <Svg>
              <g transform={`translate(${dx} 0)`}>
                <circle cx={20} cy={20} r={13} fill="#94a3b8" stroke="#475569" />
                {running && <path d="M4 8l-3 -3M36 8l3 -3M4 32l-3 3M36 32l3 3" stroke="#f59e0b" strokeWidth={1.5} />}
              </g>
            </Svg>
          </div>
        )
      }
      const angle = spinAngle(t, view.rpm, view.speed, view.style === 'wheel' ? 2 : 6)
      const blur = view.style !== 'wheel' && Math.abs(view.rpm) > 600
      return (
        <div className="sim-row">
          <Svg>
            {view.style === 'wheel' ? (
              <g transform={`rotate(${angle} 20 20)`}>
                <circle cx={20} cy={20} r={17} fill="#1f2937" />
                <circle cx={20} cy={20} r={10} fill="#facc15" />
                {[0, 120, 240].map((a) => (
                  <rect key={a} x={19} y={10} width={2} height={10} fill="#78350f" transform={`rotate(${a} 20 20)`} />
                ))}
                <circle cx={20} cy={20} r={2.5} fill="#78350f" />
              </g>
            ) : (
              <g transform={`rotate(${angle} 20 20)`} opacity={blur ? 0.55 : 1}>
                {blur && <circle cx={20} cy={20} r={18} fill="#94a3b8" opacity={0.35} />}
                {[0, 120, 240].slice(0, view.style === 'prop' ? 2 : 3).map((a) => (
                  <ellipse key={a} cx={20} cy={9} rx={4} ry={10} fill="#64748b" transform={`rotate(${view.style === 'prop' ? a * 1.5 : a} 20 20)`} />
                ))}
                <circle cx={20} cy={20} r={3} fill="#0f172a" />
              </g>
            )}
            {running && <path d={view.speed > 0 ? 'M46 8a14 14 0 0 1 0 24l4-1m-4 1-1-4' : 'M58 8a14 14 0 0 0 0 24l-4-1m4 1 1-4'} stroke="#16a34a" strokeWidth={2} fill="none" />}
          </Svg>
        </div>
      )
    }
    case 'stepper':
      return (
        <div className="sim-row">
          <Svg>
            <rect x={2} y={2} width={36} height={36} rx={4} fill="#334155" />
            <circle cx={20} cy={20} r={12} fill="#e2e8f0" />
            <line x1={20} y1={20} x2={20 + 11 * Math.sin((view.angle * Math.PI) / 180)} y2={20 - 11 * Math.cos((view.angle * Math.PI) / 180)} stroke="#dc2626" strokeWidth={2.5} strokeLinecap="round" />
          </Svg>
          <span className="sim-big">{Math.round(view.angle)}°</span>
        </div>
      )
    case 'driver':
      return (
        <div className="sim-row sim-row--wrap">
          <Led on={view.powerLed} label="PWR" />
          {view.leds?.map((on, i) => <Led key={i} on={on} label={'ABCD'[i]} />)}
          {view.channels.map((c) => (
            <span key={c.label} className={`sim-chip${c.speed ? ' is-on' : ''}`}>
              {c.label} {c.speed > 0 ? '▶' : c.speed < 0 ? '◀' : '■'}
              {c.speed ? ` ${Math.round(Math.abs(c.speed) * 100)}%` : ''}
            </span>
          ))}
        </div>
      )
    case 'esc':
      return (
        <div className="sim-row">
          <span className="sim-meter">
            <span style={{ width: `${view.throttle * 100}%` }} />
          </span>
          <span className="small">{view.armed ? '준비됨' : '신호 없음'}</span>
        </div>
      )
    case 'lcd':
      return (
        <div className={`sim-lcd${view.backlight ? ' is-lit' : ''}`}>
          {[0, 1].map((i) => (
            <div key={i}>{(view.lines[i] ?? '').padEnd(16, ' ').slice(0, 16)}</div>
          ))}
        </div>
      )
    case 'oled':
      return (
        <div className="sim-oled">
          {view.lines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )
    case 'seg':
      return <div className="sim-seg">{view.text.padStart(4, ' ').replace(/ /g, ' ')}</div>
    case 'pixels':
      return (
        <div className="sim-row sim-pixels">
          {view.colors.slice(0, 16).map((c, i) => (
            <span key={i} style={{ background: c === 'off' ? '#1e293b' : c, boxShadow: c === 'off' ? 'none' : `0 0 6px ${c}` }} />
          ))}
        </div>
      )
    case 'sonar':
      return (
        <div className="sim-row">
          <Svg>
            <circle cx={10} cy={20} r={8} fill="#cbd5e1" stroke="#64748b" />
            <circle cx={30} cy={20} r={8} fill="#cbd5e1" stroke="#64748b" />
            {view.ping && [0, 1].map((i) => <path key={i} d={`M${42 + i * 7} 8 q 8 12 0 24`} stroke="#0ea5e9" strokeWidth={1.5} fill="none" />)}
          </Svg>
          <Slider label="거리" value={input.distance ?? 30} min={2} max={450} unit=" cm" onChange={(v) => set({ distance: v })} testId={`sim-distance-${id}`} />
        </div>
      )
    case 'gauge': {
      const labels = { value: '손잡이', light: '밝기', moisture: '흙 수분', gas: '가스' }
      return (
        <div className="sim-row">
          {view.control !== 'value' && <Led on={view.led} color="#22c55e" label="DO" />}
          <Slider label={labels[view.control]} value={Math.round(view.fraction * 100)} min={0} max={100} unit="%" onChange={(v) => set({ [view.control]: v / 100 })} testId={`sim-${view.control}-${id}`} />
          <span className="sim-raw" title={`analogRead 0–${view.max}`}>{view.raw}</span>
        </div>
      )
    }
    case 'joystick':
      return (
        <div className="sim-row">
          <Pad x={view.x} y={view.y} onChange={(x, y) => set({ x, y })} />
          <HoldButton label="SW" active={view.pressed} onChange={(on) => set({ pressed: on })} />
        </div>
      )
    case 'encoder':
      return (
        <div className="sim-row">
          <button type="button" className="sim-btn" onPointerDown={stop} onClick={() => store.rotate(id, -1)} aria-label="반시계로 한 칸">
            ◀
          </button>
          <Svg>
            <circle cx={20} cy={20} r={14} fill="#334155" />
            <line x1={20} y1={20} x2={20 + 12 * Math.sin((view.value * 18 * Math.PI) / 180)} y2={20 - 12 * Math.cos((view.value * 18 * Math.PI) / 180)} stroke="#f8fafc" strokeWidth={2.5} />
          </Svg>
          <button type="button" className="sim-btn" onPointerDown={stop} onClick={() => store.rotate(id, 1)} aria-label="시계 방향으로 한 칸" data-testid={`sim-rotate-${id}`}>
            ▶
          </button>
          <HoldButton label="SW" active={view.pressed} onChange={(on) => set({ pressed: on })} />
        </div>
      )
    case 'dht':
      return (
        <div className="sim-col">
          <Slider label="온도" value={view.temperature} min={0} max={50} unit=" °C" onChange={(v) => set({ temperature: v })} />
          <Slider label="습도" value={view.humidity} min={20} max={90} unit=" %" onChange={(v) => set({ humidity: v })} />
        </div>
      )
    case 'pir':
      return (
        <div className="sim-row">
          <Svg>
            <path d="M4 34a16 16 0 0 1 32 0z" fill="#f8fafc" stroke="#94a3b8" />
            {view.motion && <circle cx={52} cy={20} r={6} fill="#f97316" />}
          </Svg>
          <Led on={view.out} color="#f97316" label="OUT" />
          <HoldButton label="움직이기" active={view.motion} onChange={(on) => set({ motion: on })} testId={`sim-motion-${id}`} />
        </div>
      )
    case 'line':
      return (
        <div className="sim-row">
          <Led on={!view.out} color="#ef4444" label="LED" />
          <button type="button" className={`sim-toggle${view.onLine ? ' is-dark' : ''}`} onPointerDown={stop} onClick={() => set({ onLine: !view.onLine })}>
            {view.onLine ? '검은 선 위' : '흰 바닥'}
          </button>
        </div>
      )
    case 'imu':
      return (
        <div className="sim-col">
          <Slider label="X 기울기" value={view.tiltX} min={-90} max={90} unit="°" onChange={(v) => set({ tiltX: v })} />
          <Slider label="Y 기울기" value={view.tiltY} min={-90} max={90} unit="°" onChange={(v) => set({ tiltY: v })} />
        </div>
      )
    case 'bt':
      return <Bluetooth view={view} onConnect={(on) => set({ connected: on })} onSend={(text) => store.sendBluetooth(id, text)} />
    case 'rfid':
      return (
        <div className="sim-row">
          <button type="button" className="sim-btn sim-btn--wide" onPointerDown={stop} onClick={() => store.tapCard(id)} data-testid={`sim-card-${id}`}>
            💳 카드 대기
          </button>
          <span className={`small${view.flash ? ' sim-flash' : ''}`}>{view.uid}</span>
        </div>
      )
    case 'power':
      return (
        <div className="sim-row">
          <Led on={view.on && view.ok} color="#ef4444" label="ON" />
          <strong className="sim-big">{view.text}</strong>
        </div>
      )
    case 'mux':
      return (
        <div className="sim-mux">
          {view.channels.slice(0, 6).map((c) => (
            <span key={c.channel} className={c.channel === view.active ? 'is-active' : ''} title={c.label}>
              C{c.channel} {c.raw}
            </span>
          ))}
        </div>
      )
    case 'pass':
      return (
        <div className="sim-row">
          {view.active.map((on, i) => (
            <Led key={i} on={on} color="#22c55e" label={view.active.length > 1 ? String(i + 1) : undefined} />
          ))}
          <span className="small">{view.text}</span>
        </div>
      )
  }
}

/** 조이스틱: 패드를 끌면 움직이고 놓으면 가운데로 돌아온다 */
function Pad({ x, y, onChange }: { x: number; y: number; onChange: (x: number, y: number) => void }) {
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const nx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1))
    const ny = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1))
    onChange(Math.round(nx * 100) / 100, Math.round(-ny * 100) / 100)
  }
  return (
    <div
      className="sim-pad"
      onPointerDown={(e) => {
        e.stopPropagation()
        e.currentTarget.setPointerCapture(e.pointerId)
        move(e)
      }}
      onPointerMove={(e) => e.buttons && move(e)}
      onPointerUp={() => onChange(0, 0)}
      onPointerCancel={() => onChange(0, 0)}
      title="끌어서 기울이기"
    >
      <span style={{ left: `${(x + 1) * 50}%`, top: `${(1 - y) * 50}%` }} />
    </div>
  )
}

function Bluetooth({ view, onConnect, onSend }: { view: Extract<ModuleView, { kind: 'bt' }>; onConnect: (on: boolean) => void; onSend: (text: string) => void }) {
  const [text, setText] = useState('')
  return (
    <div className="sim-col">
      <div className="sim-row">
        <Led on={view.led} color="#ef4444" label="LED" />
        <button type="button" className="sim-btn" onPointerDown={stop} onClick={() => onConnect(!view.connected)}>
          📱 {view.connected ? '연결 끊기' : '휴대폰 연결'}
        </button>
      </div>
      <form
        className="sim-row"
        onSubmit={(e) => {
          e.preventDefault()
          if (text) onSend(text)
          setText('')
        }}
      >
        <input className="sim-text" value={text} onChange={(e) => setText(e.target.value)} onPointerDown={stop} placeholder={view.lastTx ? `받음: ${view.lastTx}` : '휴대폰에서 보내기'} disabled={!view.connected} />
      </form>
    </div>
  )
}

/** 부품 카드 안의 시뮬레이션 화면: 상태 한 줄 + 동작 모습·조작 */
export function SimCard({ store, instanceId, moduleId }: { store: SimStore; instanceId: string; moduleId: string }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const view = snapshot.view.modules.get(instanceId)
  if (!view) return null
  const note = view.ok ? view.warn : view.reason
  return (
    <div
      className={`sim-card${view.ok ? '' : ' is-bad'}${view.warn && view.ok ? ' has-warn' : ''}`}
      onPointerDown={stop}
      data-testid={`sim-${instanceId}`}
      data-ok={view.ok}
      title={[BEHAVIOR[moduleId]?.looks, note].filter(Boolean).join('\n')}
    >
      <div className="sim-card__status" data-testid={`sim-status-${instanceId}`}>
        {view.ok ? view.status : `⚠ ${view.reason}`}
      </div>
      <div className="sim-card__body">
        <Visual view={view} store={store} id={instanceId} t={snapshot.view.t} />
      </div>
    </div>
  )
}

/** 보드 위 LED: 전원(ON), 보드 LED(L · D13 / ESP32 GPIO2), 시리얼 송신(TX) */
export function SimBoardLeds({ store, boardInstanceId }: { store: SimStore; boardInstanceId: string }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const b = snapshot.view.boards.find((x) => x.instanceId === boardInstanceId)
  if (!b) return null
  return (
    <div className="sim-board-leds" data-testid={`sim-board-${boardInstanceId}`}>
      <Led on={b.on} color="#22c55e" label="ON" />
      <Led on={b.led} color="#f59e0b" label="L" />
      <Led on={b.tx} color="#facc15" label="TX" />
    </div>
  )
}
