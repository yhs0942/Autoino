import { useEffect, useMemo } from 'react'
import type { Circuit } from '../../engine/circuit'
import type { PowerReport } from '../../engine/power'
import { SimRuntime, type SerialLine, type SimInput, type SimView } from '../../engine/sim/runtime'
import type { Issue } from '../../engine/validate'

// 시뮬레이션 상태 저장소. 화면 전체를 다시 그리지 않도록, 부품 카드·시리얼 모니터가 각자 구독해 필요한 부분만 바꾼다.

export interface SimSnapshot {
  view: SimView
  serial: SerialLine[]
  running: boolean
  speed: number
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
  setRunning: (running: boolean) => void
  setSpeed: (speed: number) => void
  restart: () => void
}

export function createSimStore(circuit: Circuit, issues: Issue[], power: PowerReport): SimStore {
  let runtime = new SimRuntime(circuit, { issues, power })
  let running = true
  let speed = 1
  let serialLength = -1
  let serial: SerialLine[] = []
  const listeners = new Set<() => void>()
  const make = (): SimSnapshot => {
    // 시리얼 줄이 늘었을 때만 새 배열을 만든다 (모니터가 매 프레임 다시 그려지지 않게)
    if (runtime.serial.length !== serialLength || runtime.serial.at(-1) !== serial.at(-1)) {
      serial = [...runtime.serial]
      serialLength = runtime.serial.length
    }
    return { view: runtime.view(), serial, running, speed }
  }
  let snapshot = make()
  const emit = () => {
    snapshot = make()
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
    setRunning: (value) => {
      running = value
      emit()
    },
    setSpeed: (value) => {
      speed = value
      emit()
    },
    restart: () => {
      runtime = new SimRuntime(circuit, { issues, power })
      serialLength = -1
      emit()
    },
  }
}

/** 시뮬레이션이 켜져 있는 동안 저장소를 만들고 화면 프레임마다 시간을 흘린다 */
export function useSimulation(active: boolean, circuit: Circuit, issues: Issue[], power: PowerReport): SimStore | null {
  const store = useMemo(() => (active ? createSimStore(circuit, issues, power) : null), [active, circuit, issues, power])
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
