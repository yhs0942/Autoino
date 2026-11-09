import { describe, expect, it } from 'vitest'
import { getBoard } from '../data/boards'
import { MODULE_SIZE } from '../utils/placement'
import { circuitReducer, createInitialState, type CircuitAction, type CircuitState } from './circuitState'

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) =>
  actions.reduce(circuitReducer, state)

describe('circuitReducer', () => {
  it('같은 모듈을 여러 개 추가해도 서로 구분된다', () => {
    const s = run([
      { type: 'addModule', moduleId: 'led-5mm' },
      { type: 'addModule', moduleId: 'led-5mm' },
      { type: 'addModule', moduleId: 'hc-sr04' },
    ])
    expect(s.placed).toHaveLength(3)
    expect(new Set(s.placed.map((p) => p.instanceId)).size).toBe(3)
    expect(s.placed.map((p) => p.label)).toEqual(['LED 1', 'LED 2', 'HC-SR04 초음파 센서 1'])
    expect(s.selection).toEqual({ kind: 'module', instanceId: s.placed[2].instanceId })
    expect(s.placed[0].params).toEqual({ color: 'red', current: '10' })
  })

  it('기본 배치 위치가 서로, 그리고 보드와 겹치지 않는다', () => {
    const s = run(Array.from({ length: 12 }, () => ({ type: 'addModule', moduleId: 'sg90' }) as const))
    const board = getBoard(s.boards[0].boardId)
    const rects = s.placed.map((p) => ({ x: p.x, y: p.y, w: MODULE_SIZE.width, h: MODULE_SIZE.height }))
    rects.push({ x: 40, y: 40, w: board.footprint.width, h: board.footprint.height })
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]
        const b = rects[j]
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
        expect(overlap, `${i} vs ${j}`).toBe(false)
      }
    }
  })

  it('삭제 시 선택이 해제되고 다른 부품은 유지된다', () => {
    let s = run([
      { type: 'addModule', moduleId: 'led-5mm' },
      { type: 'addModule', moduleId: 'push-button' },
    ])
    const [led, button] = s.placed
    s = circuitReducer(s, { type: 'select', selection: { kind: 'module', instanceId: led.instanceId } })
    s = circuitReducer(s, { type: 'removeModule', instanceId: led.instanceId })
    expect(s.placed.map((p) => p.instanceId)).toEqual([button.instanceId])
    expect(s.selection).toEqual({ kind: 'none' })
  })

  it('삭제 후 추가해도 인스턴스 ID 가 재사용되지 않는다', () => {
    let s = run([{ type: 'addModule', moduleId: 'led-5mm' }])
    const first = s.placed[0].instanceId
    s = circuitReducer(s, { type: 'removeModule', instanceId: first })
    s = circuitReducer(s, { type: 'addModule', moduleId: 'led-5mm' })
    expect(s.placed[0].instanceId).not.toBe(first)
  })

  it('이동 좌표는 캔버스 안으로 제한된다', () => {
    let s = run([{ type: 'addModule', moduleId: 'led-5mm', position: { x: 100, y: 100 } }])
    const id = s.placed[0].instanceId
    s = circuitReducer(s, { type: 'moveModule', instanceId: id, position: { x: -50, y: 99999 } })
    expect(s.placed[0].x).toBe(0)
    expect(s.placed[0].y).toBeLessThan(99999)
  })

  it('보드 변경 시 보드 ID 가 바뀌고 부품은 유지된다', () => {
    const s = run([
      { type: 'addModule', moduleId: 'led-5mm' },
      { type: 'setBoard', boardInstanceId: 'board-1', boardId: 'arduino-mega-2560' },
    ])
    expect(s.boards[0].boardId).toBe('arduino-mega-2560')
    expect(s.placed).toHaveLength(1)
  })

  it('초기화는 부품과 선택, 번호를 지우고 보드는 유지한다', () => {
    let s = run([
      { type: 'setBoard', boardInstanceId: 'board-1', boardId: 'arduino-nano' },
      { type: 'addModule', moduleId: 'led-5mm' },
      { type: 'select', selection: { kind: 'board', boardInstanceId: 'board-1' } },
      { type: 'reset' },
    ])
    expect(s.placed).toEqual([])
    expect(s.selection).toEqual({ kind: 'none' })
    expect(s.boards[0].boardId).toBe('arduino-nano')
    s = circuitReducer(s, { type: 'addModule', moduleId: 'led-5mm' })
    expect(s.placed[0].label).toBe('LED 1')
  })

  it('존재하지 않는 인스턴스는 선택하지 않는다', () => {
    const s0 = createInitialState()
    const s = circuitReducer(s0, { type: 'select', selection: { kind: 'module', instanceId: 'nope' } })
    expect(s).toBe(s0)
  })
})
