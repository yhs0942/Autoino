import { describe, expect, it } from 'vitest'
import { BOARDS } from '../data/boards'
import { MODULES } from '../data/modules'
import { parseProjectFile, toProjectFile } from '../engine/project'
import { layoutItems, LAYOUT_SCALE } from '../components/LayoutView/layoutItems'
import { circuitReducer, createInitialState, toProjectData, type CircuitAction, type CircuitState } from './circuitState'

// 실물 배치 모드: 부품을 실제 상대 크기로 보여 주고, 배선도와 따로 위치를 정한다

const run = (actions: CircuitAction[], state: CircuitState = createInitialState()) => actions.reduce(circuitReducer, state)
const add = (moduleId: string): CircuitAction => ({ type: 'addModule', moduleId })

describe('실물 배치 모드', () => {
  it('모든 부품과 보드에 대표 실물 크기(mm)가 있다', () => {
    for (const m of MODULES) expect(m.sizeMm, m.id).toMatchObject({ width: expect.any(Number), height: expect.any(Number) })
    for (const b of BOARDS) expect(b.sizeMm, b.id).toMatchObject({ width: expect.any(Number), height: expect.any(Number) })
  })

  it('실물 크기 비율이 그대로 화면 크기가 된다 (Uno 가 SG90 보다 크다)', () => {
    const s = run([add('sg90'), add('led-5mm')])
    const items = layoutItems(s)
    const uno = items.find((i) => i.id === 'board-1')!
    const servo = items.find((i) => i.id === 'sg90#1')!
    const led = items.find((i) => i.id === 'led-5mm#2')!
    expect(uno.width).toBeCloseTo(68.6 * LAYOUT_SCALE)
    expect(servo.width / uno.width).toBeCloseTo(32 / 68.6)
    expect(led.width).toBeLessThan(servo.width)
    expect(items.find((i) => i.id === 'breadboard')!.width).toBeCloseTo(165 * LAYOUT_SCALE)
  })

  it('배치 모드에서 옮긴 위치는 따로 저장되고 배선도 위치는 그대로다', () => {
    const s0 = run([add('sg90')])
    const before = s0.placed[0]
    const s1 = run([{ type: 'checkpoint' }, { type: 'moveLayout', id: 'sg90#1', position: { x: 900, y: 500 } }], s0)
    expect(s1.layout['sg90#1']).toEqual({ x: 900, y: 500 })
    expect(s1.placed[0]).toEqual(before)
    expect(layoutItems(s1).find((i) => i.id === 'sg90#1')).toMatchObject({ x: 900, y: 500 })
    expect(circuitReducer(s1, { type: 'undo' }).layout['sg90#1']).toBeUndefined()
  })

  it('보드와 브레드보드도 옮길 수 있다', () => {
    const s = run([{ type: 'moveLayout', id: 'board-1', position: { x: 300, y: 300 } }, { type: 'moveLayout', id: 'breadboard', position: { x: 50, y: 800 } }])
    expect(s.layout).toEqual({ 'board-1': { x: 300, y: 300 }, breadboard: { x: 50, y: 800 } })
  })

  it('없는 부품 ID 는 받지 않고, 부품을 지우면 그 배치도 지운다', () => {
    const s0 = run([add('sg90'), { type: 'moveLayout', id: 'nothing#9', position: { x: 1, y: 1 } }, { type: 'moveLayout', id: 'sg90#1', position: { x: 10, y: 10 } }])
    expect(Object.keys(s0.layout)).toEqual(['sg90#1'])
    expect(circuitReducer(s0, { type: 'removeModule', instanceId: 'sg90#1' }).layout).toEqual({})
  })

  it('배치는 프로젝트 파일에 저장되고, 잘못된 값은 버린다', () => {
    const s = run([add('sg90'), { type: 'moveLayout', id: 'sg90#1', position: { x: 120, y: 80 } }])
    const file = toProjectFile(toProjectData(s))
    expect(file.layout).toEqual({ 'sg90#1': { x: 120, y: 80 } })
    const data = parseProjectFile(JSON.stringify({ ...file, layout: { ...file.layout, 'ghost#2': { x: 1, y: 1 }, breadboard: { x: 'a' } } }))
    expect(data.layout).toEqual({ 'sg90#1': { x: 120, y: 80 } })
    expect('layout' in toProjectFile(toProjectData(createInitialState()))).toBe(false)
    const opened = circuitReducer(createInitialState(), { type: 'loadProject', data })
    expect(opened.layout).toEqual({ 'sg90#1': { x: 120, y: 80 } })
  })
})
