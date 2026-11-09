import { describe, expect, it } from 'vitest'
import { circuitReducer, createInitialState, type CircuitAction, type CircuitState } from './circuitState'

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) => actions.reduce(circuitReducer, state)

describe('실행 취소 / 다시 실행', () => {
  it('추가·삭제·자동 배정을 되돌리고 다시 실행한다', () => {
    let s = run([{ type: 'addModule', moduleId: 'led-5mm' }, { type: 'autoAssign' }])
    expect(s.connections).toHaveLength(2)
    s = circuitReducer(s, { type: 'undo' })
    expect(s.connections).toHaveLength(0)
    expect(s.placed).toHaveLength(1)
    s = circuitReducer(s, { type: 'undo' })
    expect(s.placed).toHaveLength(0)
    s = circuitReducer(s, { type: 'redo' })
    s = circuitReducer(s, { type: 'redo' })
    expect(s.connections).toHaveLength(2)
    expect(circuitReducer(s, { type: 'redo' }).statusMessage).toContain('다시 실행할 작업이 없습니다')
  })

  it('선택·상태 메시지·이동 중간값은 기록하지 않고, 드래그는 checkpoint 한 번으로 되돌린다', () => {
    let s = run([{ type: 'addModule', moduleId: 'led-5mm', position: { x: 500, y: 300 } }])
    const before = s.past.length
    s = circuitReducer(s, { type: 'select', selection: { kind: 'none' } })
    s = circuitReducer(s, { type: 'checkpoint' })
    for (let i = 1; i <= 5; i++) s = circuitReducer(s, { type: 'moveModule', instanceId: 'led-5mm#1', position: { x: 500 + i * 10, y: 300 } })
    expect(s.past.length).toBe(before + 1)
    s = circuitReducer(s, { type: 'undo' })
    expect(s.placed[0].x).toBe(500)
  })

  it('새 작업을 하면 다시 실행 기록이 사라진다', () => {
    let s = run([{ type: 'addModule', moduleId: 'led-5mm' }, { type: 'undo' }])
    expect(s.future).toHaveLength(1)
    s = circuitReducer(s, { type: 'addModule', moduleId: 'push-button' })
    expect(s.future).toHaveLength(0)
  })

  it('초기화도 되돌릴 수 있다', () => {
    let s = run([{ type: 'addModule', moduleId: 'led-5mm' }, { type: 'reset' }])
    expect(s.placed).toHaveLength(0)
    s = circuitReducer(s, { type: 'undo' })
    expect(s.placed).toHaveLength(1)
  })

  it('보드 이동·보드 추가도 되돌린다', () => {
    let s = run([{ type: 'addBoard', boardId: 'arduino-nano' }])
    s = circuitReducer(s, { type: 'checkpoint' })
    s = circuitReducer(s, { type: 'moveBoard', boardInstanceId: 'board-2', position: { x: 900, y: 600 } })
    s = circuitReducer(s, { type: 'undo' })
    expect(s.boards[1].x).not.toBe(900)
    s = circuitReducer(s, { type: 'undo' })
    expect(s.boards).toHaveLength(1)
  })

  it('불러오기는 기록을 비운다', () => {
    const s = run([{ type: 'addModule', moduleId: 'led-5mm' }])
    const loaded = circuitReducer(s, {
      type: 'loadProject',
      data: { name: 'x', boards: s.boards, placed: [], connections: [], links: [], nextSeq: 1, nextConnSeq: 1, nextBoardSeq: 2, nextLinkSeq: 1, labelCounters: {} },
    })
    expect(loaded.past).toEqual([])
  })
})

describe('부품 정렬', () => {
  it('연결된 핀 순서대로 정렬하고 겹치지 않는다', () => {
    let s = run([
      { type: 'addModule', moduleId: 'led-5mm', position: { x: 1200, y: 800 } },
      { type: 'addModule', moduleId: 'led-5mm', position: { x: 600, y: 700 } },
      { type: 'connect', from: { kind: 'module', instanceId: 'led-5mm#1', pinId: 'anode' }, to: { kind: 'board', boardInstanceId: 'board-1', pinId: 'D3' } },
      { type: 'connect', from: { kind: 'module', instanceId: 'led-5mm#2', pinId: 'anode' }, to: { kind: 'board', boardInstanceId: 'board-1', pinId: 'D11' } },
    ])
    s = circuitReducer(s, { type: 'arrangeModules' })
    const [a, b] = s.placed
    expect(a.x).toBeLessThan(b.x) // D3 에 연결된 LED 1 이 왼쪽
    expect(Math.abs(a.x - b.x) >= 160 || Math.abs(a.y - b.y) >= 104).toBe(true)
  })
})
