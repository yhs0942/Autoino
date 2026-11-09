// Autoino 파이썬 백엔드(backend/) REST API 클라이언트.
// 개발 중에는 Vite 가 /api 를 http://127.0.0.1:8000 으로 넘긴다(vite.config.ts).
// 백엔드가 없으면 편집·검사·내보내기는 그대로 되고, 서버 저장·코드 생성·시뮬레이션만 쓸 수 없다.
// 주소는 페이지 기준 상대 경로라서 Streamlit 처럼 하위 경로(/autoino/)에 얹어도 그대로 동작한다.
import type { ProjectFile } from '../engine/project'

const configuredApi = import.meta.env.VITE_AUTOINO_API as string | undefined
const API_BASE = configuredApi ? `${configuredApi}/api` : 'api'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {}
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...rest,
      headers: json === undefined ? rest.headers : { 'Content-Type': 'application/json', ...rest.headers },
      body: json === undefined ? rest.body : JSON.stringify(json),
    })
  } catch {
    throw new ApiError('백엔드 서버에 연결할 수 없습니다.', 0)
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let body: unknown = undefined
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    // JSON 이 아닌 응답(프록시 오류 페이지 등)
  }
  if (!res.ok) {
    const detail = body && typeof body === 'object' && 'detail' in body ? (body as { detail: unknown }).detail : undefined
    throw new ApiError(typeof detail === 'string' ? detail : `서버 오류 (${res.status})`, res.status)
  }
  if (body === undefined) throw new ApiError('서버 응답 형식이 잘못되었습니다.', res.status)
  return body as T
}

// ---------------------------------------------------------------- 응답 형식

export interface HealthResponse {
  status: 'ok'
  version: string
  features: string[]
  catalog: { boards: number; modules: number }
}

export interface ServerProjectSummary {
  id: string
  name: string
  savedAt: string
  boards: string[]
  moduleCount: number
  connectionCount: number
}

export interface ServerProject {
  id: string
  project: ProjectFile
}

export interface SketchLibrary {
  name: string
  install: string
  builtIn: boolean
}

export interface Sketch {
  boardInstanceId: string
  boardLabel: string
  boardName: string
  core: 'arduino-avr' | 'arduino-esp32'
  filename: string
  code: string
  libraries: SketchLibrary[]
  warnings: string[]
}

export type GpioMode = 'output-high' | 'output-low' | 'input' | 'input-pullup'
export type GpioOverride = 'high' | 'low' | 'input' | 'input-pullup'

export interface SimulationOptions {
  gpio?: Record<string, GpioOverride>
  pressed?: string[]
  moduleOutputs?: Record<string, 'high' | 'low'>
  servoMoving?: string[]
  motorsStalled?: string[]
  includeSeriesResistors?: boolean
}

export interface SimGpio {
  boardInstanceId: string
  pinId: string
  mode: GpioMode
  reason: string
  voltage: number | null
  currentMa: number
  limitMa: number
  overCurrent: boolean
  overVoltage: boolean
  logic: 'HIGH' | 'LOW' | 'undefined' | 'floating' | 'no-common-ground'
}

export interface SimLed {
  instanceId: string
  label: string
  ratedMa: number
  seriesOhms: number | null
  currentMa: number
  forwardVoltage: number | null
  brightness: number
  state: 'on' | 'off' | 'over' | 'unpowered'
}

export interface SimLoad {
  instanceId: string
  label: string
  nominalVoltage: number
  assumedMa: number
  voltage: number | null
  currentMa: number
  status: 'ok' | 'low' | 'unpowered'
}

export interface SimMotor {
  instanceId: string
  label: string
  driver: string
  channel: string
  assumedMa: number
  stalled: boolean
  voltage: number | null
  status: 'ok' | 'low' | 'over' | 'unpowered'
}

export interface SimSupply {
  boardInstanceId: string
  pinId: string
  nominal: number
  voltage: number | null
  currentMa: number
}

export interface SimulationResult {
  converged: boolean
  iterations: number
  gpio: SimGpio[]
  leds: SimLed[]
  loads: SimLoad[]
  motors: SimMotor[]
  supplies: SimSupply[]
  nets: { net: string; members: string[]; voltage: number | null; ground: boolean }[]
  warnings: string[]
  assumptions: string[]
}

// ---------------------------------------------------------------- 호출

export const api = {
  health: () => request<HealthResponse>('/health'),
  listProjects: () => request<ServerProjectSummary[]>('/projects'),
  getProject: (id: string) => request<ServerProject>(`/projects/${encodeURIComponent(id)}`),
  createProject: (project: ProjectFile) => request<ServerProject>('/projects', { method: 'POST', json: project }),
  saveProject: (id: string, project: ProjectFile) => request<ServerProject>(`/projects/${encodeURIComponent(id)}`, { method: 'PUT', json: project }),
  deleteProject: (id: string) => request<void>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  codegen: (project: ProjectFile) => request<{ sketches: Sketch[] }>('/codegen', { method: 'POST', json: { project } }),
  simulate: (project: ProjectFile, options: SimulationOptions) => request<SimulationResult>('/simulate', { method: 'POST', json: { project, options } }),
}
