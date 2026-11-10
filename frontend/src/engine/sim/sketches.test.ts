/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { circuitOf, circuitReducer, createInitialState } from '../../state/circuitState'
import { analyzePower } from '../power'
import { parseProjectFile } from '../project'
import { validateCircuit } from '../validate'
import { CodeRuntime } from './codeRuntime'
import { SimRuntime, type ModuleView } from './runtime'

// 백엔드가 만든 예시 스케치(shared/fixtures/sketches.json)를 코드 시뮬레이터로 그대로 실행한다.
// 1) 모든 스케치가 컴파일·실행 오류 없이 돈다
// 2) 부품이 예시 동작 시뮬레이션(SimRuntime)과 같은 모습을 보인다 (LED·릴레이·부저 켜짐, 모터 방향, LCD·OLED·7세그먼트 글자)

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../../shared/fixtures/${name}`, import.meta.url), 'utf-8'))
const cases = (read('engine-cases.json').cases as { name: string; after: unknown }[]).map((c) => ({ name: c.name, after: c.after }))
const sketches = read('sketches.json').sketches as { case: string; board: string; code: string }[]

function circuitFor(name: string) {
  const c = cases.find((x) => x.name === name)!
  const state = circuitReducer(createInitialState(), { type: 'loadProject', data: parseProjectFile(c.after) })
  return circuitOf(state)
}

function runBoth(name: string) {
  const circuit = circuitFor(name)
  const ctx = { issues: validateCircuit(circuit), power: analyzePower(circuit) }
  const code = Object.fromEntries(sketches.filter((s) => s.case === name).map((s) => [s.board, s.code]))
  return { circuit, demo: new SimRuntime(circuit, ctx), real: new CodeRuntime(circuit, ctx, code) }
}

const stepTo = (r: SimRuntime, ms: number) => {
  while (r.t < ms) r.step(Math.min(33, ms - r.t))
}

/** 비교할 모습 (시간에 민감한 경계는 피해서 본다) */
function look(v: ModuleView): string | null {
  if (!v.ok) return null
  switch (v.kind) {
    case 'led':
    case 'relay':
    case 'buzzer':
      return v.on ? 'on' : 'off'
    case 'motor':
      return v.speed > 0 ? 'fwd' : v.speed < 0 ? 'rev' : 'stop'
    case 'lcd':
      return v.lines[0]?.trim() ?? ''
    case 'seg':
      return v.text.trim()
    case 'pixels':
      return String(v.colors.findIndex((c) => c !== 'off'))
  }
  return null
}

describe('예시 스케치를 코드 시뮬레이터로 실행', () => {
  const names = [...new Set(sketches.map((s) => s.case))]

  it.each(names)('%s: 컴파일·실행 오류 없음', (name) => {
    const { real } = runBoth(name)
    stepTo(real, 3000)
    for (const st of real.codeStatus()) {
      if (st.state === 'no-code') continue
      expect(st.errors, `${st.board} 컴파일`).toEqual([])
      expect(st.fault, `${st.board} 실행`).toBeNull()
      expect(st.state).toBe('running')
    }
  })

  it.each(names)('%s: 예시 동작 시뮬레이션과 같은 모습', (name) => {
    const { circuit, demo, real } = runBoth(name)
    const differences: string[] = []
    // 0.5초·1초·2초 주기의 경계를 피한 시각
    for (const t of [760, 1260, 2760, 4760]) {
      stepTo(demo, t)
      stepTo(real, t)
      const dv = demo.view().modules
      const rv = real.view().modules
      for (const item of circuit.placed) {
        const a = look(dv.get(item.instanceId)!)
        const b = look(rv.get(item.instanceId)!)
        if (a !== null && a !== b) differences.push(`${t} ms ${item.label}: 예시 ${a} / 코드 ${b ?? '(동작 안 함)'}`)
      }
    }
    expect(differences).toEqual([])
  })
})
