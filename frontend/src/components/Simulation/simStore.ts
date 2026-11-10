import { useEffect, useMemo } from 'react'
import type { Circuit } from '../../engine/circuit'
import type { PowerReport } from '../../engine/power'
import { CodeRuntime, type CodeStatus } from '../../engine/sim/codeRuntime'
import { SimRuntime, type SerialLine, type SimInput, type SimView } from '../../engine/sim/runtime'
import type { Issue } from '../../engine/validate'

// 시뮬레이션 상태 저장소. 화면 전체를 다시 그리지 않도록, 부품 카드·시리얼 모니터가 각자 구독해 필요한 부분만 바꾼다.

/** 예시 동작(생성 코드와 같은 동작) 또는 내 코드(보드마다 넣은 스케치를 실제로 실행) */
export type SimMode = 'demo' | 'code'

export interface SimSnapshot {
  view: SimView
  serial: SerialLine[]
  running: boolean
  speed: number
  mode: SimMode
  /** 내 코드 모드: 보드마다 컴파일·실행 상태 */
  code: CodeStatus[] | null
}

export interface SimStore {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => SimSnapshot
  /** 지난 프레임 이후 흐른 실제 시간(ms) */
  tick: (dtMs: number) => void
  input: (instanceId: string) => SimInput
  setInput: (instanceId: string, patch: SimInput) => void
  rotate: (instanceId: string, dir: 1 | -1) => void
  tapCard: (instanceId: string) => void
  sendBluetooth: (instanceId: string, text: string) => void
  /** 시리얼 모니터에서 보드로 보내기 (내 코드 모드) */
  sendSerial: (boardId: string, text: string) => void
  setRunning: (running: boolean) => void
  setSpeed: (speed: number) => void
  restart: () => void
}

export function createSimStore(circuit: Circuit, issues: Issue[], power: PowerReport, mode: SimMode = 'demo', sketches: Record<string, string> = {}): SimStore {
  let saved: Map<string, number[]> | undefined
  const make = (): SimRuntime => (mode === 'code' ? new CodeRuntime(circuit, { issues, power }, sketches, saved) : new SimRuntime(circuit, { issues, power }))
  let runtime = make()
  let running = true
  let speed = 1
  let serialVersion = -1
  let serial: SerialLine[] = []
  let code: CodeStatus[] | null = null
  let codeAt = -1e9
  const listeners = new Set<() => void>()
  const snap = (): SimSnapshot => {
    // 시리얼 줄이 바뀌었을 때만 새 배열을 만든다 (모니터가 매 프레임 다시 그려지지 않게)
    if (runtime.serialVersion !== serialVersion) {
      serial = [...runtime.serial]
      serialVersion = runtime.serialVersion
    }
    // 코드 상태(오류·안내)는 0.25초마다 다시 계산한다
    if (runtime instanceof CodeRuntime && (code === null || runtime.t - codeAt >= 250 || runtime.t < codeAt)) {
      const next = runtime.codeStatus()
      if (JSON.stringify(next) !== JSON.stringify(code)) code = next
      codeAt = runtime.t
    }
    return { view: runtime.view(), serial, running, speed, mode, code }
  }
  let snapshot = snap()
  const emit = () => {
    snapshot = snap()
    listeners.forEach((l) => l())
  }
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    tick: (dtMs) => {
      if (!running) return
      runtime.step(dtMs * speed)
      emit()
    },
    input: (id) => runtime.input(id),
    setInput: (id, patch) => {
      runtime.setInput(id, patch)
      emit()
    },
    rotate: (id, dir) => {
      runtime.rotate(id, dir)
      emit()
    },
    tapCard: (id) => {
      runtime.tapCard(id)
      emit()
    },
    sendBluetooth: (id, text) => {
      runtime.sendBluetooth(id, text)
      emit()
    },
    sendSerial: (boardId, text) => {
      if (runtime instanceof CodeRuntime) runtime.sendSerial(boardId, text)
      emit()
    },
    setRunning: (value) => {
      running = value
      emit()
    },
    setSpeed: (value) => {
      speed = value
      emit()
    },
    restart: () => {
      // EEPROM 은 실제 보드처럼 다시 시작해도 남는다
      if (runtime instanceof CodeRuntime) saved = runtime.savedStorage()
      runtime = make()
      serialVersion = -1
      code = null
      emit()
    },
  }
}

/** 시뮬레이션이 켜져 있는 동안 저장소를 만들고 화면 프레임마다 시간을 흘린다 */
export function useSimulation(active: boolean, circuit: Circuit, issues: Issue[], power: PowerReport, mode: SimMode = 'demo', sketches: Record<string, string> = {}): SimStore | null {
  const store = useMemo(() => (active ? createSimStore(circuit, issues, power, mode, sketches) : null), [active, circuit, issues, power, mode, sketches])
  useEffect(() => {
    if (!store) return
    let raf = 0
    let last = performance.now()
    let pending = 0
    const loop = (now: number) => {
      pending += Math.min(100, now - last)
      last = now
      // 약 30 fps 로 갱신한다
      if (pending >= 33) {
        store.tick(pending)
        pending = 0
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [store])
  return store
}
