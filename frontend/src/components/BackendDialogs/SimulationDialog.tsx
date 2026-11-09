import { useEffect, useState } from 'react'
import { api, type GpioOverride, type SimGpio, type SimulationOptions, type SimulationResult } from '../../api/client'
import type { BackendStatus } from '../../api/useBackend'
import { findModule } from '../../data/modules'
import { formatCurrent } from '../../engine/power'
import type { ProjectFile } from '../../engine/project'
import { Modal } from '../common/Modal'
import { BackendRequired } from './BackendRequired'
import './BackendDialogs.css'

interface SimulationDialogProps {
  status: BackendStatus
  project: ProjectFile
  onRecheck: () => void
  onClose: () => void
}

type Run = { state: 'loading' } | { state: 'done'; result: SimulationResult } | { state: 'error'; message: string }

const MODE_LABELS: Record<SimGpio['mode'], string> = {
  'output-high': '출력 HIGH',
  'output-low': '출력 LOW',
  input: '입력',
  'input-pullup': '입력 (풀업)',
}
const LOGIC_LABELS: Record<SimGpio['logic'], string> = {
  HIGH: 'HIGH',
  LOW: 'LOW',
  undefined: '불확실',
  floating: '떠 있음',
  'no-common-ground': 'GND 미공유',
}
const LED_LABELS = { on: '켜짐', off: '꺼짐', over: '과전류', unpowered: '연결 안 됨' } as const
const LOAD_LABELS = { ok: '정상', low: '전압 부족', unpowered: '전원 없음' } as const
const MOTOR_LABELS = { ok: '정상', low: '전압 부족', over: '전압 초과', unpowered: '전원 없음' } as const

function fmt(v: number | null, digits: number, unit: string): string {
  return v === null ? '—' : `${v.toFixed(digits)} ${unit}`
}

function toggle(list: string[] | undefined, id: string, on: boolean): string[] {
  const rest = (list ?? []).filter((x) => x !== id)
  return on ? [...rest, id] : rest
}

/** DC 시뮬레이션 (백엔드 /api/simulate) */
export function SimulationDialog({ status, project, onRecheck, onClose }: SimulationDialogProps) {
  const [options, setOptions] = useState<SimulationOptions>({ gpio: {}, pressed: [], moduleOutputs: {}, servoMoving: [], motorsStalled: [], includeSeriesResistors: true })
  const [run, setRun] = useState<Run>({ state: 'loading' })
  const online = status.state === 'online'
  const multi = project.boards.length > 1
  const boardName = (id: string) => (multi ? `${project.boards.find((b) => b.instanceId === id)?.label ?? id} ` : '')
  const modules = (moduleId: string) => project.modules.filter((m) => m.moduleId === moduleId)

  useEffect(() => {
    if (!online) return
    let cancelled = false
    api
      .simulate(project, options)
      .then((result) => !cancelled && setRun({ state: 'done', result }))
      .catch((err: unknown) => !cancelled && setRun({ state: 'error', message: err instanceof Error ? err.message : String(err) }))
    return () => {
      cancelled = true
    }
  }, [online, project, options])

  const setGpio = (key: string, value: GpioOverride | 'auto') =>
    setOptions((o) => {
      const gpio = { ...o.gpio }
      if (value === 'auto') delete gpio[key]
      else gpio[key] = value
      return { ...o, gpio }
    })

  const result = run.state === 'done' ? run.result : undefined
  const buttons = modules('push-button')
  const sonars = modules('hc-sr04')
  const servos = project.modules.filter((m) => {
    const def = findModule(m.moduleId)
    return def?.library === 'Servo' && !def.driver
  })
  const motors = project.modules.filter((m) => findModule(m.moduleId)?.motor)

  return (
    <Modal
      title="회로 시뮬레이션 (DC)"
      size="wide"
      onClose={onClose}
      footer={
        <button type="button" className="button" onClick={onClose}>
          닫기
        </button>
      }
    >
      {!online ? (
        <BackendRequired status={status} feature="시뮬레이션" onRecheck={onRecheck} />
      ) : (
        <div className="sim" data-testid="simulation">
          <p className="muted small">
            배선을 저항·전원·다이오드 모델로 바꿔 한 순간의 전압과 전류를 계산합니다. 핀 상태나 버튼을 바꾸면 바로 다시 계산합니다. 프로그램 실행이나 시간에 따른 동작은 다루지 않습니다.
          </p>
          <fieldset className="sim__controls">
            <legend>입력 조건</legend>
            {buttons.map((b) => (
              <label key={b.instanceId} className="sim__check">
                <input
                  type="checkbox"
                  checked={options.pressed?.includes(b.instanceId) ?? false}
                  onChange={(e) => setOptions((o) => ({ ...o, pressed: toggle(o.pressed, b.instanceId, e.target.checked) }))}
                  data-testid={`sim-press-${b.instanceId}`}
                />
                {b.label} 누름
              </label>
            ))}
            {sonars.map((m) => (
              <label key={m.instanceId} className="sim__check">
                <input
                  type="checkbox"
                  checked={options.moduleOutputs?.[`${m.instanceId}:echo`] === 'high'}
                  onChange={(e) =>
                    setOptions((o) => ({ ...o, moduleOutputs: { ...o.moduleOutputs, [`${m.instanceId}:echo`]: e.target.checked ? 'high' : 'low' } }))
                  }
                />
                {m.label} Echo HIGH (반사파 수신 중)
              </label>
            ))}
            {servos.map((m) => (
              <label key={m.instanceId} className="sim__check">
                <input
                  type="checkbox"
                  checked={options.servoMoving?.includes(m.instanceId) ?? false}
                  onChange={(e) => setOptions((o) => ({ ...o, servoMoving: toggle(o.servoMoving, m.instanceId, e.target.checked) }))}
                />
                {m.label} 움직이는 중 ({formatCurrent(findModule(m.moduleId)?.pins.find((p) => p.role === 'power')?.typicalMa ?? 0)})
              </label>
            ))}
            {motors.map((m) => (
              <label key={m.instanceId} className="sim__check">
                <input
                  type="checkbox"
                  checked={options.motorsStalled?.includes(m.instanceId) ?? false}
                  onChange={(e) => setOptions((o) => ({ ...o, motorsStalled: toggle(o.motorsStalled, m.instanceId, e.target.checked) }))}
                  data-testid={`sim-stall-${m.instanceId}`}
                />
                {m.label} 스톨 ({formatCurrent(findModule(m.moduleId)?.motor?.peakMa ?? 0)})
              </label>
            ))}
            <label className="sim__check">
              <input
                type="checkbox"
                checked={options.includeSeriesResistors !== false}
                onChange={(e) => setOptions((o) => ({ ...o, includeSeriesResistors: e.target.checked }))}
                data-testid="sim-resistors"
              />
              LED 직렬 저항 넣기 (끄면 저항 없이 연결했을 때를 계산)
            </label>
          </fieldset>

          {run.state === 'error' && (
            <p className="callout callout--error" data-testid="sim-error">
              {run.message}
            </p>
          )}
          {run.state === 'loading' && <p className="muted">계산 중…</p>}
          {result && (
            <>
              {result.warnings.length > 0 ? (
                <ul className="callout callout--warning backend-list" data-testid="sim-warnings">
                  {result.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              ) : (
                <p className="callout callout--ok">전압·전류 한계를 넘는 곳이 없습니다.</p>
              )}

              <h3 className="small-heading">GPIO</h3>
              {result.gpio.length ? (
                <table className="pin-table sim__table" data-testid="sim-gpio">
                  <thead>
                    <tr>
                      <th>핀</th>
                      <th>상태</th>
                      <th>전압</th>
                      <th>전류</th>
                      <th>판정</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.gpio.map((g) => {
                      const key = `${g.boardInstanceId}:${g.pinId}`
                      const bad = g.overCurrent || g.overVoltage || g.logic === 'undefined' || g.logic === 'no-common-ground'
                      return (
                        <tr key={key} className={bad ? 'is-bad' : undefined}>
                          <td title={g.reason}>
                            {boardName(g.boardInstanceId)}
                            <strong>{g.pinId}</strong>
                          </td>
                          <td>
                            <select
                              aria-label={`${g.pinId} 상태`}
                              value={options.gpio?.[key] ?? 'auto'}
                              onChange={(e) => setGpio(key, e.target.value as GpioOverride | 'auto')}
                              data-testid={`sim-gpio-${key}`}
                            >
                              <option value="auto">자동: {MODE_LABELS[g.mode]}</option>
                              <option value="high">출력 HIGH</option>
                              <option value="low">출력 LOW</option>
                              <option value="input">입력</option>
                              <option value="input-pullup">입력 (풀업)</option>
                            </select>
                          </td>
                          <td>{fmt(g.voltage, 2, 'V')}</td>
                          <td className={g.overCurrent ? 'is-bad-cell' : undefined}>{g.mode.startsWith('output') ? `${g.currentMa.toFixed(1)} mA` : '—'}</td>
                          <td className={bad ? 'is-bad-cell' : undefined}>
                            {g.overVoltage ? '과전압' : LOGIC_LABELS[g.logic]}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              ) : (
                <p className="muted small">연결된 GPIO 가 없습니다.</p>
              )}

              {result.leds.length > 0 && (
                <>
                  <h3 className="small-heading">LED</h3>
                  <table className="pin-table sim__table" data-testid="sim-leds">
                    <thead>
                      <tr>
                        <th>LED</th>
                        <th>전류</th>
                        <th>밝기</th>
                        <th>상태</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.leds.map((l) => (
                        <tr key={l.instanceId} className={l.state === 'over' ? 'is-bad' : undefined}>
                          <td>
                            {l.label}
                            {l.seriesOhms ? <span className="muted"> · {l.seriesOhms} Ω</span> : null}
                          </td>
                          <td>{l.currentMa.toFixed(2)} mA</td>
                          <td>
                            <span className="sim__meter" aria-hidden="true">
                              <span style={{ width: `${l.brightness}%` }} />
                            </span>{' '}
                            {l.brightness}%
                          </td>
                          <td data-testid={`sim-led-${l.instanceId}`}>{LED_LABELS[l.state]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              {result.loads.length > 0 && (
                <>
                  <h3 className="small-heading">부품 전원</h3>
                  <table className="pin-table sim__table">
                    <thead>
                      <tr>
                        <th>부품</th>
                        <th>전압</th>
                        <th>전류</th>
                        <th>상태</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.loads.map((l) => (
                        <tr key={l.instanceId} className={l.status !== 'ok' ? 'is-bad' : undefined}>
                          <td>{l.label}</td>
                          <td>{fmt(l.voltage, 2, 'V')}</td>
                          <td>{l.currentMa.toFixed(1)} mA</td>
                          <td>{LOAD_LABELS[l.status]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              {result.motors.length > 0 && (
                <>
                  <h3 className="small-heading">모터</h3>
                  <table className="pin-table sim__table" data-testid="sim-motors">
                    <thead>
                      <tr>
                        <th>모터</th>
                        <th>드라이버</th>
                        <th>모터 전압</th>
                        <th>전류</th>
                        <th>상태</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.motors.map((m) => (
                        <tr key={m.instanceId} className={m.status !== 'ok' ? 'is-bad' : undefined}>
                          <td>{m.label}</td>
                          <td>
                            {m.driver} · {m.channel}
                          </td>
                          <td>{fmt(m.voltage, 2, 'V')}</td>
                          <td>{formatCurrent(m.assumedMa)}</td>
                          <td>{MOTOR_LABELS[m.status]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              <h3 className="small-heading">전원</h3>
              <table className="pin-table sim__table" data-testid="sim-supplies">
                <thead>
                  <tr>
                    <th>핀</th>
                    <th>전압</th>
                    <th>공급 전류</th>
                  </tr>
                </thead>
                <tbody>
                  {result.supplies.map((s) => (
                    <tr key={`${s.boardInstanceId}:${s.pinId}`}>
                      <td>
                        {boardName(s.boardInstanceId)}
                        <strong>{s.pinId}</strong>
                      </td>
                      <td>{fmt(s.voltage, 2, 'V')}</td>
                      <td>{s.currentMa.toFixed(1)} mA</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <details className="sim__assumptions">
                <summary>계산 모델과 가정 ({result.assumptions.length})</summary>
                <ul className="backend-list small">
                  {result.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
                {!result.converged && <p className="callout callout--error">반복 계산이 수렴하지 않았습니다.</p>}
              </details>
            </>
          )}
        </div>
      )}
    </Modal>
  )
}
