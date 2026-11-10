import { describe, expect, it } from 'vitest'
import { parseProjectFile, toProjectFile } from '../engine/project'
import type { Endpoint } from '../types'
import { circuitReducer, createInitialState, toProjectData, type CircuitAction, type CircuitState } from './circuitState'

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) => actions.reduce(circuitReducer, state)
const BLINK = 'void setup(){ pinMode(13, OUTPUT); }\nvoid loop(){}\n'

describe('보드별 코드', () => {
  it('보드마다 저장하고, 빈 코드는 지운다', () => {
    const s = run([{ type: 'addBoard', boardId: 'esp32-devkit-v1' }, { type: 'setSketch', boardInstanceId: 'board-1', code: BLINK }, { type: 'setSketch', boardInstanceId: 'board-2', code: 'x' }])
    expect(s.sketches).toEqual({ 'board-1': BLINK, 'board-2': 'x' })
    expect(run([{ type: 'setSketch', boardInstanceId: 'board-2', code: '  ' }], s).sketches).toEqual({ 'board-1': BLINK })
    expect(run([{ type: 'setSketch', boardInstanceId: 'board-9', code: BLINK }], s).sketches).toEqual(s.sketches)
  })

  it('실행 취소 기록에 남지 않고, 배선을 되돌려도 코드는 그대로', () => {
    const s = run([{ type: 'addModule', moduleId: 'led-5mm' }, { type: 'setSketch', boardInstanceId: 'board-1', code: BLINK }])
    expect(s.past).toHaveLength(1)
    const undone = run([{ type: 'undo' }], s)
    expect(undone.placed).toHaveLength(0)
    expect(undone.sketches['board-1']).toBe(BLINK)
  })

  it('프로젝트 파일에 저장되고 다시 불러온다', () => {
    const s = run([{ type: 'setSketch', boardInstanceId: 'board-1', code: BLINK }])
    const file = toProjectFile(toProjectData(s))
    expect(file.sketches).toEqual({ 'board-1': BLINK })
    const loaded = run([{ type: 'loadProject', data: parseProjectFile(JSON.stringify(file)) }])
    expect(loaded.sketches).toEqual({ 'board-1': BLINK })
    // 없는 보드·글자가 아닌 값은 버린다
    const bad = parseProjectFile(JSON.stringify({ ...file, sketches: { 'board-1': BLINK, 'board-7': BLINK, x: 3 } }))
    expect(bad.sketches).toEqual({ 'board-1': BLINK })
  })

  it('보드를 지우면 그 보드의 코드도 지운다', () => {
    const s = run([{ type: 'addBoard', boardId: 'arduino-uno-r3' }, { type: 'setSketch', boardInstanceId: 'board-2', code: BLINK }, { type: 'removeBoard', boardInstanceId: 'board-2' }])
    expect(s.sketches).toEqual({})
  })
})

describe('자동 핀 배정: 보드 고르기', () => {
  const bp = (pinId: string, board: string): Endpoint => ({ kind: 'board', boardInstanceId: board, pinId })
  const base = () => run([{ type: 'addBoard', boardId: 'arduino-uno-r3' }, { type: 'addModule', moduleId: 'led-5mm', hostBoardId: 'board-1' }, { type: 'addModule', moduleId: 'push-button', hostBoardId: 'board-1' }])

  it('고른 보드에 아직 연결되지 않은 부품을 배정한다 (직결)', () => {
    const s = run([{ type: 'autoAssign', board: 'board-2' }], base())
    expect(s.placed.every((p) => p.hostBoardId === 'board-2')).toBe(true)
    const boardsUsed = new Set(s.connections.flatMap((c) => [c.from, c.to]).filter((e) => e.kind === 'board').map((e) => (e as { boardInstanceId: string }).boardInstanceId))
    expect([...boardsUsed]).toEqual(['board-2'])
    expect(s.statusMessage).toContain('보드 2에 배정')
  })

  it('브레드보드 경유로도 고른 보드에 배정한다', () => {
    const s = run([{ type: 'autoAssign', board: 'board-2', route: 'breadboard' }], base())
    expect(s.connections.some((c) => c.via === 'breadboard')).toBe(true)
    expect(s.connections.filter((c) => c.from.kind === 'board' || c.to.kind === 'board').every((c) => [c.from, c.to].some((e) => e.kind === 'board' && e.boardInstanceId === 'board-2'))).toBe(true)
  })

  it('이미 다른 보드에 연결된 부품은 그대로 두고 알려 준다', () => {
    const s = run([{ type: 'connect', from: { kind: 'module', instanceId: 'led-5mm#1', pinId: 'anode' }, to: bp('D9', 'board-1') }, { type: 'autoAssign', board: 'board-2' }], base())
    expect(s.placed.find((p) => p.instanceId === 'led-5mm#1')!.hostBoardId).toBe('board-1')
    expect(s.placed.find((p) => p.instanceId === 'push-button#2')!.hostBoardId).toBe('board-2')
    expect(s.statusMessage).toContain('그대로 두었습니다')
  })

  it('보드를 고르지 않으면 부품마다 정한 보드', () => {
    const s = run([{ type: 'autoAssign' }], base())
    expect(s.placed.every((p) => p.hostBoardId === 'board-1')).toBe(true)
  })
})
