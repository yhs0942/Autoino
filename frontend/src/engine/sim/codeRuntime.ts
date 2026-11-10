import { getModule } from '../../data/modules'
import type { Module, PlacedModule } from '../../types'
import { boardKindOf } from '../arduino/core'
import type { OledText } from '../arduino/machine'
import { Program, type Diagnostic } from '../arduino/program'
import { boardDefOf, type Circuit } from '../circuit'
import { endpointKey, isPinConnected, moduleEndpoint } from '../connections'
import { motorDriverOf } from '../motorAttach'
import { muxUsers } from '../mux'
import { netVoltage, type PowerReport } from '../power'
import type { Issue } from '../validate'
import { BEHAVIOR } from './behavior'
import { CircuitHw, type BoardHw, type StepperModel } from './hardware'
import { SimRuntime, type BoardView, type ModuleView, type PinOut, type SimView } from './runtime'

// 사용자 코드(보드마다 하나)를 실행하는 시뮬레이션.
// 코드가 보드 핀에 쓴 값이 배선을 따라 부품에 전달되고, 부품의 출력(버튼·센서)이 코드가 읽는 값이 된다.

export type CodeState = 'no-code' | 'compile-error' | 'running' | 'error' | 'stopped'

export interface CodeStatus {
  board: string
  label: string
  state: CodeState
  errors: Diagnostic[]
  warnings: Diagnostic[]
  fault: Diagnostic | null
  /** 실제 시간보다 늦은 정도 (ms) */
  lagMs: number
  /** 배선과 코드를 비교한 안내 */
  hints: string[]
}

/** 화면 한 프레임(약 33 ms)에 보드 하나가 실행할 수 있는 문장 수. 넘으면 시뮬레이션이 실제보다 느려진다 */
const FRAME_BUDGET = 150000
const SERVO_RATE: Record<string, number> = { sg90: 0.6, mg90s: 0.6, mg996r: 0.35, fs90r: 0.6 }

export class CodeRuntime extends SimRuntime {
  readonly hw: CircuitHw
  readonly programs = new Map<string, Program>()
  private readonly decoders = new Map<string, TextDecoder>()
  private readonly openLine = new Map<string, number>()
  private readonly servoPos = new Map<string, number>()
  private readonly escState = new Map<string, { lowSince: number | null; armed: boolean; lastSeen: number }>()
  private readonly sources: Record<string, string>

  constructor(circuit: Circuit, ctx: { issues: Issue[]; power: PowerReport }, sketches: Record<string, string>, saved?: Map<string, number[]>) {
    super(circuit, { ...ctx, demo: false })
    this.sources = sketches
    this.hw = new CircuitHw(circuit, this.netlist, this.traced, this.inputs, this.health, saved)
    this.hw.onMonitor = (board, bytes, us) => this.monitor(board, bytes, us)
    this.setupSteppers()
    for (const b of circuit.boards) {
      const src = sketches[b.instanceId]
      const host = this.hw.boards.get(b.instanceId)
      if (!src?.trim() || !host) continue
      const kind = boardKindOf(host.def.id)
      this.programs.set(b.instanceId, new Program(src, host, { kind, core: kind === 'esp32' ? 'esp32' : 'avr' }))
    }
  }

  // ---------------------------------------------------------------- 입력

  override setInput(instanceId: string, patch: Parameters<SimRuntime['setInput']>[1]): void {
    const prev = this.input(instanceId)
    this.inputs.set(instanceId, { ...prev, ...patch })
    if (patch.motion === false && prev.motion) this.hw.motionUntil.set(instanceId, this.t + 3000)
    this.hw.moduleChanged(instanceId)
  }

  override rotate(instanceId: string, dir: 1 | -1): void {
    this.hw.now = this.t * 1000
    this.hw.rotate(instanceId, dir)
    this.encoder.set(instanceId, (this.encoder.get(instanceId) ?? 0) + dir)
  }

  override tapCard(instanceId: string): void {
    const uid = BEHAVIOR['rc522-rfid'].cardUid!.split(' ').map((h) => parseInt(h, 16))
    this.hw.now = this.t * 1000
    this.hw.tapCard(instanceId, uid)
    this.rfid.set(instanceId, { uid: BEHAVIOR['rc522-rfid'].cardUid!, t: this.t })
  }

  override sendBluetooth(instanceId: string, text: string): void {
    this.hw.now = this.t * 1000
    this.hw.sendBluetooth(instanceId, text)
  }

  /** 시리얼 모니터에서 보드로 보내기 (줄 끝 \n 포함) */
  sendSerial(boardId: string, text: string): void {
    this.hw.now = this.t * 1000
    this.hw.sendSerial(boardId, text)
    this.print(boardId, `> ${text.replace(/\r?\n$/, '')}`)
    this.openLine.delete(boardId)
  }

  // ---------------------------------------------------------------- 시간

  override step(dtMs: number): void {
    const to = this.t + Math.max(0, dtMs)
    const slice = this.programs.size > 1 ? 5 : Math.max(1, dtMs)
    let t = this.t
    while (t < to) {
      const next = Math.min(to, t + slice)
      this.hw.now = next * 1000
      const budget = Math.max(2000, Math.round((FRAME_BUDGET * (next - t)) / 33))
      for (const p of this.programs.values()) p.run(next * 1000, budget)
      t = next
    }
    this.updateMotion(to - this.t, to)
    this.t = to
  }

  /** 서보가 목표 각도로 움직이는 속도, ESC 시동 */
  private updateMotion(dt: number, t: number) {
    for (const item of this.circuit.placed) {
      const id = item.moduleId
      if (SERVO_RATE[id] !== undefined && id !== 'fs90r') {
        const us = this.servoPulse(item)
        const cur = this.servoPos.get(item.instanceId) ?? 90
        if (us === null || !this.healthOf(item.instanceId).ok) continue
        const target = pulseToAngle(us)
        const max = SERVO_RATE[id] * dt
        this.servoPos.set(item.instanceId, cur + Math.max(-max, Math.min(max, target - cur)))
      }
      if (id === 'esc-30a') {
        const s = this.escState.get(item.instanceId) ?? { lowSince: null, armed: false, lastSeen: -1e9 }
        const us = this.pulseOn(item, 'sig')
        if (us === null) {
          if (t - s.lastSeen > 500) s.armed = false
          s.lowSince = null
        } else {
          s.lastSeen = t
          if (us <= 1100) {
            s.lowSince ??= t
            if (t - s.lowSince >= 1000) s.armed = true
          } else s.lowSince = null
        }
        this.escState.set(item.instanceId, s)
      }
    }
  }

  // ---------------------------------------------------------------- 시리얼 모니터

  private monitor(board: string, bytes: number[], us: number) {
    let dec = this.decoders.get(board)
    if (!dec) {
      dec = new TextDecoder()
      this.decoders.set(board, dec)
    }
    const text = dec.decode(new Uint8Array(bytes), { stream: true })
    const t = us / 1000
    for (const part of text.split(/(\n)/)) {
      if (part === '\n') {
        if (!this.openLine.has(board)) this.print(board, '', t)
        this.openLine.delete(board)
        continue
      }
      const clean = part.replace(/\r/g, '')
      if (!clean) continue
      const idx = this.openLine.get(board)
      if (idx !== undefined && this.serial[idx]?.board === board) {
        this.serial[idx] = { ...this.serial[idx], text: this.serial[idx].text + clean }
        this.serialVersion++
      } else {
        this.print(board, clean, t)
        this.openLine.set(board, this.serial.length - 1)
      }
    }
    // 300 줄을 넘겨 앞이 잘리면 열린 줄 위치도 바뀐다
    for (const [b, i] of this.openLine) if (this.serial[i]?.board !== b) this.openLine.delete(b)
  }

  // ---------------------------------------------------------------- 상태

  codeStatus(): CodeStatus[] {
    return this.circuit.boards.map((b) => {
      const p = this.programs.get(b.instanceId)
      const host = this.hw.boards.get(b.instanceId)
      if (!p) return { board: b.instanceId, label: b.label, state: 'no-code' as const, errors: [], warnings: [], fault: null, lagMs: 0, hints: [] }
      const state: CodeState = p.errors.length ? 'compile-error' : p.state === 'error' ? 'error' : p.state === 'stopped' ? 'stopped' : 'running'
      const lagMs = state === 'running' ? Math.max(0, this.t - p.m.us / 1000) : 0
      return { board: b.instanceId, label: b.label, state, errors: p.errors, warnings: [...p.warnings, ...(host?.warnings ?? [])], fault: p.fault, lagMs, hints: this.hints(b.instanceId) }
    })
  }

  /** 배선된 부품과 코드가 쓰는 핀 비교 */
  private hints(boardId: string): string[] {
    const host = this.hw.boards.get(boardId)
    const p = this.programs.get(boardId)
    if (!host || !p || !p.ok || this.t < 800) return []
    const out: string[] = []
    const wired = new Set<string>()
    for (const item of this.circuit.placed) {
      const module = getModule(item.moduleId)
      const pins = module.pins.filter((pin) => pin.role === 'signal')
      const routes = pins.map((pin) => ({ pin, r: this.hw.routeOf(item, pin.id) })).filter((x) => x.r?.board === host)
      for (const x of routes) wired.add(x.r!.pinId)
      if (!routes.length || module.passThrough?.length) continue
      if (!routes.some((x) => host.touched.has(x.r!.pinId))) out.push(`${item.label} (${routes.map((x) => `${x.pin.name}→${x.r!.pinId}`).join(', ')}) 을(를) 코드가 쓰지 않습니다`)
    }
    for (const pin of host.touched) {
      if (wired.has(pin)) continue
      const busPin = [...host.busPins('I2C'), ...host.busPins('SPI')].includes(pin)
      const bt = [...host.ports.values()].some((port) => port.rxPin === pin || port.txPin === pin)
      if (busPin || bt || pin === (host.kind === 'esp32' ? 'GPIO2' : 'D13')) continue
      out.push(`코드가 ${pin} 을(를) 쓰지만 그 핀에는 연결된 부품이 없습니다`)
    }
    return out.slice(0, 8)
  }

  // ---------------------------------------------------------------- 신호

  /** 보드 핀 상태를 화면용 신호로 */
  protected override outputs(): Map<string, PinOut> {
    const pins = new Map<string, PinOut>()
    for (const [boardId, host] of this.hw.boards) {
      for (const [pinId, s] of host.pins) {
        if (s.mode !== 'OUTPUT' && s.mode !== 'INPUT_PULLUP') continue
        const high = s.mode === 'OUTPUT' ? s.out : true
        const duty = s.mode === 'INPUT_PULLUP' ? 0.05 : s.pwm ?? (s.out ? 1 : 0)
        pins.set(`${boardId}:${pinId}`, { high, duty })
      }
    }
    return pins
  }

  override view(): SimView {
    const t = this.t
    const pins = this.outputs()
    const modules = new Map<string, ModuleView>()
    for (const item of this.circuit.placed) modules.set(item.instanceId, this.codeView(item, pins, t))
    const boards: BoardView[] = this.circuit.boards.map((b) => {
      const host = this.hw.boards.get(b.instanceId)!
      const ledPin = host.kind === 'esp32' ? 'GPIO2' : 'D13'
      const s = host.pins.get(ledPin)
      return { instanceId: b.instanceId, on: true, led: !!s && (s.mode === 'OUTPUT' ? s.out : false), tx: t * 1000 - host.lastTx < 80000 }
    })
    return { t, modules, boards, pins }
  }

  /** 핀 끝이 어디에 이어졌는지 */
  private endOf(item: PlacedModule, pinId: string): { kind: 'out'; high: boolean; duty: number } | { kind: 'pullup' } | { kind: 'vcc' } | { kind: 'gnd' } | null {
    const r = this.hw.routeOf(item, pinId)
    if (r) {
      const def = r.board.def
      if ((def.groundPins ?? ['GND']).includes(r.pinId) || r.pinId.startsWith('GND')) return { kind: 'gnd' }
      if ((def.supplyPins ?? []).some((sp) => sp.pinId === r.pinId) || r.pinId === '5V' || r.pinId === '3.3V' || r.pinId === '3V3') return { kind: 'vcc' }
      const s = r.board.pins.get(r.pinId)
      if (s?.mode === 'OUTPUT') return { kind: 'out', high: s.out, duty: s.pwm ?? (s.out ? 1 : 0) }
      if (s?.mode === 'INPUT_PULLUP') return { kind: 'pullup' }
      return null
    }
    const key = endpointKey(moduleEndpoint(item.instanceId, pinId))
    const members = this.netlist.members.get(this.netlist.netOf(key)) ?? []
    if (members.some((k) => k.endsWith(':GND') || /:GND\d*$/.test(k))) return { kind: 'gnd' }
    if (netVoltage(this.circuit, this.netlist, key) !== null) return { kind: 'vcc' }
    return null
  }

  /** 서보 신호선의 펄스 (보드 핀 또는 PCA9685 채널) */
  private servoPulse(item: PlacedModule): number | null {
    const viaDriver = this.pcaServo(item)
    if (viaDriver !== undefined) return viaDriver
    return this.pulseOn(item, getModule(item.moduleId).code?.pins?.signal ?? 'signal')
  }

  private pulseOn(item: PlacedModule, pinId: string): number | null {
    const r = this.hw.routeOf(item, pinId)
    return r?.board.pins.get(r.pinId)?.servoUs ?? null
  }

  private pwmOn(item: PlacedModule, pinId: string): boolean {
    const r = this.hw.routeOf(item, pinId)
    return r?.board.pins.get(r.pinId)?.pwm !== null && r?.board.pins.get(r.pinId)?.pwm !== undefined
  }

  /** PCA9685 채널에 물린 서보면 그 채널 펄스 (물리지 않았으면 undefined) */
  private pcaServo(servo: PlacedModule): number | null | undefined {
    for (const driver of this.circuit.placed) {
      if (driver.moduleId !== 'pca9685') continue
      for (const [ch, s] of this.servosOn(driver)) if (s === servo) return this.hw.pcaPulse(driver, ch)
    }
    return undefined
  }

  /** 이 부품의 핀 중 하나라도 코드를 실행하는 보드에 이어졌는지 */
  private codeReason(item: PlacedModule): string | undefined {
    const module = getModule(item.moduleId)
    const signal = module.pins.filter((p) => p.role === 'signal')
    const boards = new Set(signal.map((p) => this.hw.routeOf(item, p.id)?.board.instanceId).filter((b): b is string => !!b))
    if (!boards.size) return undefined
    for (const b of boards) {
      const p = this.programs.get(b)
      if (p?.ok) return undefined
    }
    const label = [...boards].map((b) => this.circuit.boards.find((x) => x.instanceId === b)?.label ?? b).join(', ')
    const p = this.programs.get([...boards][0])
    return p ? `${label} 의 코드에 오류가 있어 실행되지 않습니다` : `${label} 에 코드가 없습니다`
  }

  private codeView(item: PlacedModule, pins: Map<string, PinOut>, t: number): ModuleView {
    const module = getModule(item.moduleId)
    const h = this.healthOf(item.instanceId)
    const noCode = h.ok ? this.codeReason(item) : undefined
    const base = { ok: h.ok && !noCode, reason: h.reason ?? noCode, warn: h.warn }
    const input = this.input(item.instanceId)
    const us = t * 1000
    const id = item.moduleId
    switch (id) {
      case 'led-5mm': {
        const a = this.endOf(item, 'anode')
        const c = this.endOf(item, 'cathode')
        const color = item.params.color ?? 'red'
        const anodeOn = a?.kind === 'out' ? a.high : a?.kind === 'vcc' || a?.kind === 'pullup'
        const cathodeLow = c?.kind === 'out' ? !c.high || c.duty < 1 : c?.kind === 'gnd'
        const on = h.ok && !!anodeOn && !!cathodeLow
        let level = 1
        if (a?.kind === 'out') level = a.duty
        if (c?.kind === 'out') level *= 1 - c.duty
        if (a?.kind === 'pullup') level = 0.06
        const dim = a?.kind === 'pullup'
        return { ...base, kind: 'led', on: on && level > 0, level: on ? level : 0, color, status: !base.ok ? '동작 안 함' : on && level > 0 ? (dim ? '아주 흐림 (pinMode OUTPUT 없음)' : level < 0.99 ? `밝기 ${Math.round(level * 100)}%` : '켜짐') : '꺼짐' }
      }
      case 'push-button':
        return { ...base, ok: h.ok, kind: 'button', pressed: !!input.pressed, status: input.pressed ? '눌림' : '눌러 보세요', warn: base.warn ?? this.floatingWarn(item) }
      case 'relay-1ch': {
        const e = this.endOf(item, 'in')
        const activeLow = module.code?.activeLow ?? true
        const on = base.ok && e?.kind === 'out' && (activeLow ? !e.high : e.high)
        return { ...base, kind: 'relay', on, status: on ? '붙음 (COM–NO 연결)' : '떨어짐 (COM–NC 연결)' }
      }
      case 'active-buzzer': {
        const r = this.hw.routeOf(item, 'sig')
        const s = r?.board.pins.get(r.pinId)
        const on = base.ok && !!s && ((s.mode === 'OUTPUT' && s.out) || !!s.toneHz)
        return { ...base, kind: 'buzzer', on, status: on ? (s?.toneHz ? `삐— (tone ${Math.round(s.toneHz)} Hz)` : '삐— (약 2.3 kHz)') : '조용함' }
      }
      case 'sg90':
      case 'mg90s':
      case 'mg996r':
      case 'fs90r': {
        const pulse = base.ok ? this.servoPulse(item) : null
        const signalPin = module.code?.pins?.signal ?? 'signal'
        const pwm = this.pwmOn(item, signalPin)
        const continuous = id === 'fs90r'
        if (pulse === null) {
          const why = pwm ? 'analogWrite(PWM) 로는 서보가 움직이지 않습니다. Servo 라이브러리로 write() 하세요' : undefined
          return { ...base, kind: 'servo', angle: Math.round(this.servoPos.get(item.instanceId) ?? 90), spin: 0, jitter: pwm, status: base.ok ? (pwm ? '떨림 (PWM 신호)' : '신호 없음') : '동작 안 함', warn: why ?? base.warn }
        }
        if (continuous) {
          const d = pulse - 1500
          const spin = Math.abs(d) < 30 ? 0 : Math.max(-1, Math.min(1, d / 400))
          return { ...base, kind: 'servo', angle: 90, spin, jitter: false, status: spin > 0 ? `정방향 회전 (${Math.round(pulse)} µs)` : spin < 0 ? `역방향 회전 (${Math.round(pulse)} µs)` : `정지 (${Math.round(pulse)} µs)` }
        }
        const angle = Math.round(this.servoPos.get(item.instanceId) ?? 90)
        return { ...base, kind: 'servo', angle, spin: 0, jitter: !!base.warn, status: `각도 ${angle}° (${Math.round(pulse)} µs)` }
      }
      case 'esc-30a': {
        const s = this.escState.get(item.instanceId)
        const pulse = this.pulseOn(item, 'sig')
        const throttle = s?.armed && pulse !== null ? Math.max(0, Math.min(1, (pulse - 1100) / 800)) : 0
        const status = !base.ok ? '동작 안 함' : pulse === null ? '신호 없음' : !s?.armed ? '시동 대기 (최소 스로틀 1000 µs 를 1초 이상)' : `스로틀 ${Math.round(throttle * 100)}%`
        return { ...base, kind: 'esc', throttle, armed: !!s?.armed, status }
      }
      case 'bldc-a2212': {
        const link = motorDriverOf(this.circuit, item)
        const esc = link && this.escState.get(link.driver.instanceId)
        const pulse = link ? this.pulseOn(link.driver, 'sig') : null
        const throttle = esc?.armed && pulse !== null ? Math.max(0, Math.min(1, (pulse - 1100) / 800)) : 0
        const view = this.motorView(item, module, pins, base)
        if (view.kind !== 'motor' || !view.ok) return view
        const rpm = Math.round((BEHAVIOR[id]?.rpm ?? 11000) * throttle)
        return { ...view, speed: throttle, rpm, status: throttle ? `약 ${rpm} rpm` : esc?.armed ? '정지 (스로틀 최소)' : '정지 (ESC 시동 전)' }
      }
      case 'stepper-28byj48':
      case 'stepper-nema17':
        return this.stepperCodeView(item, base, t)
      case 'pca9685': {
        const servos = this.servosOn(item)
        const channels = [...servos].map(([ch, s]) => {
          const p = this.hw.pcaPulse(item, ch)
          return { label: `${ch}: ${s.label}`, speed: p === null ? 0 : Math.max(0.01, (pulseToAngle(p) / 180) * (p > 0 ? 1 : 0)) }
        })
        const any = channels.some((c) => c.speed)
        return { ...base, kind: 'driver', channels, powerLed: h.ok, status: !base.ok ? '동작 안 함' : any ? `채널 ${channels.filter((c) => c.speed).length}개 출력` : '대기 (setPWM 전)' }
      }
      case 'i2c-lcd-1602': {
        const dev = this.hw.lcds.get(item.instanceId)
        const lines = dev && dev.on ? dev.chars.map((row) => row.map((c) => (c.startsWith('\u0000') ? '█' : c)).join('')) : ['', '']
        const used = !!dev && dev.on
        return { ...base, kind: 'lcd', lines, backlight: h.ok && !!dev?.backlight, status: !base.ok ? '동작 안 함' : used ? (lines.join('').trim() ? `"${lines[0].trim()}"` : '빈 화면') : '코드가 LCD 를 켜지 않았습니다 (init)' }
      }
      case 'oled-ssd1306': {
        const dev = this.hw.oleds.get(item.instanceId)
        const on = !!dev?.on && dev.frame > 0
        const lines = on ? dev!.texts.map((x: OledText) => x.text) : []
        return { ...base, kind: 'oled', lines, frame: on ? { width: dev!.width, height: dev!.height, pixels: dev!.pixels, texts: dev!.texts, inverted: dev!.inverted, n: dev!.frame } : undefined, status: !base.ok ? '동작 안 함' : on ? (lines.join(' ').slice(0, 24) || '그림 표시') : dev?.on ? 'display() 를 부르지 않았습니다' : '코드가 OLED 를 켜지 않았습니다 (begin)' }
      }
      case 'tm1637-display': {
        const s = this.hw.segs.get(item.instanceId)
        const text = s ? segText(s.segments) : ''
        return { ...base, kind: 'seg', text, segments: s?.on ? s.segments : [0, 0, 0, 0], brightness: s?.brightness ?? 7, status: !base.ok ? '동작 안 함' : s ? (s.on ? `${text.trim() || '(빈칸)'} 표시` : '꺼짐 (setBrightness off)') : '표시 없음' }
      }
      case 'neopixel-strip': {
        const count = Number(item.params.count ?? '8')
        const colors = this.hw.pixelColors.get(item.instanceId) ?? Array(count).fill('off')
        const lit = colors.filter((c) => c !== 'off').length
        return { ...base, kind: 'pixels', colors, status: !base.ok ? '동작 안 함' : lit ? `${lit}개 켜짐` : this.hw.pixelColors.has(item.instanceId) ? '모두 꺼짐' : 'show() 전' }
      }
      case 'hc-sr04': {
        const cm = input.distance ?? 30
        const s = this.hw.sonars.get(item.instanceId)
        const ping = !!s && us - s.lastPing < 120000
        return { ...base, kind: 'sonar', cm: cm >= 2 && cm <= 400 ? cm : -1, ping, status: !base.ok ? '동작 안 함' : s && s.lastPing > 0 ? `거리 ${Math.round(cm)} cm · 측정 중` : '트리거 신호 없음' }
      }
      case 'potentiometer':
      case 'ldr-module':
      case 'soil-moisture':
      case 'mq2-gas': {
        const control = BEHAVIOR[id]!.control as 'value' | 'light' | 'moisture' | 'gas'
        const pin = id === 'potentiometer' ? 'wiper' : 'ao'
        const { raw, max } = this.adcOf(item, pin, us)
        const amount = control === 'value' ? (input.value ?? 0.5) : control === 'light' ? (input.light ?? 0.5) : control === 'moisture' ? (input.moisture ?? 0.3) : (input.gas ?? 0)
        const heating = id === 'mq2-gas' && h.ok && t < 20000
        return { ...base, kind: 'gauge', control, fraction: amount, raw: raw ?? 0, max, led: h.ok && control !== 'value' && amount > 0.5, heating, status: `${heating ? '예열 중 · ' : ''}${raw === null ? '아날로그 핀에 연결되지 않음' : `analogRead ≈ ${raw}`}` }
      }
      case 'joystick-ky023': {
        const x = this.adcOf(item, 'vrx', us)
        const y = this.adcOf(item, 'vry', us)
        return { ...base, kind: 'joystick', x: input.x ?? 0, y: input.y ?? 0, pressed: !!input.pressed, status: `x≈${x.raw ?? '-'} y≈${y.raw ?? '-'}${input.pressed ? ' · SW 눌림' : ''}` }
      }
      case 'rotary-encoder':
        return { ...base, kind: 'encoder', value: this.encoder.get(item.instanceId) ?? 0, pressed: !!input.pressed, status: `${this.encoder.get(item.instanceId) ?? 0} 칸 돌림${input.pressed ? ' · SW 눌림' : ''}` }
      case 'dht-sensor':
        return { ...base, kind: 'dht', temperature: input.temperature ?? 24, humidity: input.humidity ?? 55, status: `${input.temperature ?? 24} °C · ${input.humidity ?? 55} %` }
      case 'pir-hc-sr501': {
        const out = h.ok && (!!input.motion || (this.hw.motionUntil.get(item.instanceId) ?? -1) > t)
        return { ...base, kind: 'pir', motion: !!input.motion, out, status: out ? '감지 (OUT HIGH)' : '대기 (OUT LOW)' }
      }
      case 'line-tracker': {
        const out = h.ok && !!input.onLine
        return { ...base, kind: 'line', onLine: !!input.onLine, out, status: input.onLine ? '검은 선 위 (OUT HIGH)' : '흰 바닥 (OUT LOW)' }
      }
      case 'hc-05': {
        const connected = !!input.connected
        const led = h.ok && (connected ? t % 2000 < 100 || (t % 2000 > 200 && t % 2000 < 300) : t % 200 < 100)
        return { ...base, kind: 'bt', connected, led, lastTx: this.hw.btTx.get(item.instanceId) ?? '', lastRx: this.hw.btRx.get(item.instanceId) ?? '', status: connected ? '휴대폰 연결됨' : '연결 대기 (LED 빠르게 깜박임)' }
      }
      case 'rc522-rfid': {
        const tap = this.rfid.get(item.instanceId)
        const read = this.hw.rfidTaps.get(item.instanceId)
        return { ...base, kind: 'rfid', uid: tap?.uid ?? '', flash: !!tap && t - tap.t < 400, status: !tap ? '카드 대기' : read?.consumed ? `UID ${tap.uid} (코드가 읽음)` : `UID ${tap.uid} (아직 안 읽음)` }
      }
      case 'cd74hc4067': {
        const users = muxUsers(this.circuit, item.instanceId)
        const active = h.ok ? this.hw.muxChannel(item, us) : -1
        const channels = users.map((u) => {
          const owner = this.circuit.placed.find((p) => u.key.startsWith(`module:${p.instanceId}:`))!
          const pin = u.key.split(':')[2]
          const r = this.adcOf(owner, pin, us, item)
          return { channel: u.channel, label: owner.label, raw: r.raw ?? 0 }
        })
        return { ...base, kind: 'mux', channels, active, status: h.ok ? `선택 채널 C${active}` : '동작 안 함' }
      }
      case 'mpu6050':
        return { ...base, kind: 'imu', tiltX: input.tiltX ?? 0, tiltY: input.tiltY ?? 0, raw: imuRawOf(input.tiltX ?? 0, input.tiltY ?? 0), status: `기울기 ${input.tiltX ?? 0}° / ${input.tiltY ?? 0}°` }
    }
    // 드라이버·모터·전원·레벨 변환 등은 핀 신호로 계산하는 기본 화면을 쓴다
    const v = this.viewOf(item, pins, t)
    if (noCode && v.ok && module.code && module.code.template !== 'none' && module.code.template !== 'mux') return { ...v, ok: false, reason: noCode }
    return v
  }

  /** 아날로그 값 (보드가 읽으면 나오는 값). 멀티플렉서 채널이면 그 SIG 가 이어진 핀으로 */
  private adcOf(item: PlacedModule, pinId: string, us: number, mux?: PlacedModule): { raw: number | null; max: number } {
    let r = this.hw.routeOf(mux ?? item, mux ? getModule(mux.moduleId).mux!.common : pinId)
    if (!r && !mux) {
      // 멀티플렉서 채널에 물린 센서
      const viaMux = this.circuit.placed.find((p) => p.moduleId === 'cd74hc4067' && muxUsers(this.circuit, p.instanceId).some((u) => u.key === endpointKey(moduleEndpoint(item.instanceId, pinId))))
      if (viaMux) return this.adcOf(item, pinId, us, viaMux)
    }
    if (!r) return { raw: null, max: 1023 }
    const max = r.board.kind === 'esp32' ? 4095 : 1023
    const v = mux ? this.sensorVolts(item, pinId) : this.hw.voltsAt(r.board, r.pinId, us)
    return { raw: Math.max(0, Math.min(max, Math.round((v / r.board.logicVoltage) * max))), max }
  }

  private sensorVolts(item: PlacedModule, pinId: string): number {
    const input = this.input(item.instanceId)
    const vcc = 5
    switch (item.moduleId) {
      case 'potentiometer':
        return (input.value ?? 0.5) * vcc
      case 'ldr-module':
        return (1 - (input.light ?? 0.5)) * vcc
      case 'soil-moisture':
        return (1 - 0.7 * (input.moisture ?? 0.3)) * vcc
      case 'mq2-gas':
        return (0.1 + 0.8 * (input.gas ?? 0)) * vcc
      case 'joystick-ky023':
        return (((pinId === 'vry' ? input.y : input.x) ?? 0) + 1) / 2 * vcc
    }
    return 0
  }

  /** 버튼 입력이 떠 있으면 (풀업·풀다운 없음) 알려 준다 */
  private floatingWarn(item: PlacedModule): string | undefined {
    for (const pin of ['pin1a', 'pin1b', 'pin2a', 'pin2b']) {
      const r = this.hw.routeOf(item, pin)
      if (!r) continue
      const s = r.board.pins.get(r.pinId)
      if (r.board.touched.has(r.pinId) && (!s || s.mode === 'INPUT' || s.mode === null)) return `${r.pinId} 입력이 떠 있어 값이 제멋대로 바뀝니다. pinMode(${r.pinId.replace(/^D|^GPIO/, '')}, INPUT_PULLUP) 을 쓰세요`
    }
    return undefined
  }

  // ---------------------------------------------------------------- 스테퍼

  private setupSteppers() {
    for (const item of this.circuit.placed) {
      if (item.moduleId !== 'stepper-28byj48' && item.moduleId !== 'stepper-nema17') continue
      const link = motorDriverOf(this.circuit, item)
      if (!link) continue
      const model: StepperModel = { elec: 0, fresh: true, pending: null, steps: 0, lastStepAt: -1e12, recent: [], forward: true, shakeAt: -1e12, stallAt: -1e12 }
      this.hw.steppers.set(item.instanceId, model)
      const dmod = getModule(link.driver.moduleId)
      if (dmod.code?.template === 'stepper-coils') {
        const coils = dmod.driver!.channels[0].inputs
        const update = (us: number) => this.coilUpdate(item, link.driver, coils, model, us)
        for (const c of coils) this.hw.watch(link.driver, c, update)
      } else if (dmod.code?.template === 'step-dir') {
        let prev = false
        const stepPin = dmod.code.pins!.step
        const dirPin = dmod.code.pins!.dir
        this.hw.watch(link.driver, stepPin, (us) => {
          const r = this.hw.routeOf(link.driver, stepPin)
          const level = !!r?.board.pins.get(r.pinId)?.out
          if (level && !prev) this.stepDirPulse(item, link.driver, dirPin, model, us)
          prev = level
        })
      }
    }
  }

  private level(item: PlacedModule, pinId: string): boolean | null {
    const r = this.hw.routeOf(item, pinId)
    if (!r) return null
    const s = r.board.pins.get(r.pinId)
    return s?.mode === 'OUTPUT' ? s.out : null
  }

  /** ULN2003: 켜진 코일 방향으로 회전자가 따라간다 (IN1 0°, IN2 90°, IN3 180°, IN4 270° 전기각).
   *  핀을 하나씩 바꾸는 동안의 몇 µs 짜리 중간 상태는 건너뛰고, 50 µs 이상 유지된 상태만 반영한다. */
  private coilUpdate(motor: PlacedModule, driver: PlacedModule, coils: string[], m: StepperModel, us: number) {
    if (!this.healthOf(driver.instanceId).ok || !this.healthOf(motor.instanceId).ok) return
    if (m.pending && us - m.pending.at >= 50) this.applyField(m, m.pending.phi, m.pending.at)
    let x = 0
    let y = 0
    coils.forEach((c, i) => {
      if (this.level(driver, c)) {
        x += Math.cos((i * Math.PI) / 2)
        y += Math.sin((i * Math.PI) / 2)
      }
    })
    m.pending = { phi: Math.hypot(x, y) < 0.5 ? null : (Math.atan2(y, x) * 180) / Math.PI, at: us }
  }

  private applyField(m: StepperModel, phi: number | null, us: number) {
    m.pending = null
    if (phi === null) return
    if (m.fresh) {
      m.elec = phi
      m.fresh = false
      return
    }
    const delta = ((((phi - m.elec) % 360) + 540) % 360) - 180
    if (Math.abs(delta) < 1) return
    if (Math.abs(delta) > 100) {
      // 반대쪽 코일 → 회전자가 어느 쪽으로도 못 가고 떤다 (코일 순서가 틀린 경우)
      m.shakeAt = us
      return
    }
    const minUs = 1500 * (Math.abs(delta) / 90)
    if (us - m.lastStepAt < minUs * 0.5) {
      m.stallAt = us
      return
    }
    this.advance(m, delta / 90, us)
    m.elec += delta
  }

  private stepDirPulse(motor: PlacedModule, driver: PlacedModule, dirPin: string, m: StepperModel, us: number) {
    if (!this.healthOf(driver.instanceId).ok || !this.healthOf(motor.instanceId).ok) return
    const en = this.level(driver, 'en')
    if (en === true) return // EN HIGH = 꺼짐
    if (us - m.lastStepAt < 150) {
      m.stallAt = us
      return
    }
    const forward = this.level(driver, dirPin) !== false
    m.steps += forward ? 1 : -1
    this.advance(m, forward ? 1 : -1, us)
  }

  private advance(m: StepperModel, steps: number, us: number) {
    m.forward = steps > 0
    m.lastStepAt = us
    m.recent.push(us)
    if (m.recent.length > 400) m.recent.splice(0, m.recent.length - 400)
  }

  private stepperCodeView(item: PlacedModule, base: { ok: boolean; reason?: string; warn?: string }, t: number): ModuleView {
    const behavior = BEHAVIOR[item.moduleId]!
    const link = motorDriverOf(this.circuit, item)
    const idle = (reason?: string): ModuleView => ({ ...base, ok: !reason && base.ok, reason: reason ?? base.reason, kind: 'stepper', angle: 0, rpm: 0, forward: true, status: '멈춤' })
    if (!base.ok) return idle(base.reason)
    if (!link) return idle('스테퍼 드라이버에 연결되지 않았습니다')
    const dh = this.healthOf(link.driver.instanceId)
    if (!dh.ok) return idle(`${link.driver.label}: ${dh.reason}`)
    const dmod = getModule(link.driver.moduleId)
    if (netVoltage(this.circuit, this.netlist, endpointKey(moduleEndpoint(link.driver.instanceId, dmod.driver!.supplyPin))) === null) return idle(`${link.driver.label} 모터 전원이 없습니다`)
    const m = this.hw.steppers.get(item.instanceId)
    if (!m) return idle()
    if (m.pending && t * 1000 - m.pending.at >= 50) this.applyField(m, m.pending.phi, m.pending.at)
    const perRev = behavior.stepsPerRev!
    const steps = dmod.code?.template === 'stepper-coils' ? m.elec / 90 : m.steps
    const angle = (((steps / perRev) * 360) % 360 + 360) % 360
    const us = t * 1000
    const window = m.recent.filter((x) => us - x < 500000).length
    const rpm = Math.round(((window * 2 * 60) / perRev) * 10) / 10
    const shaking = us - m.shakeAt < 300000
    const stalled = us - m.stallAt < 300000
    const status = shaking ? '제자리 떨림: 코일 순서가 맞지 않습니다 (예: Stepper(2048, IN1, IN3, IN2, IN4))' : stalled ? '탈조: 스텝이 너무 빨라 모터가 따라가지 못합니다' : rpm ? `${m.forward ? '정방향' : '역방향'} · 약 ${rpm} rpm` : '정지'
    return { ...base, kind: 'stepper', angle, rpm, forward: m.forward, status, warn: base.warn ?? (shaking || stalled ? status : undefined) }
  }

  /** 다음 실행을 위해 EEPROM 값을 넘긴다 */
  savedStorage(): Map<string, number[]> {
    return (this.hw as unknown as { saved: Map<string, number[]> }).saved
  }

  get sketchSources(): Record<string, string> {
    return this.sources
  }
}

/** 서보 펄스 → 각도 (Servo 라이브러리 기본 544–2400 µs) */
function pulseToAngle(us: number): number {
  return Math.max(0, Math.min(180, ((us - 544) / (2400 - 544)) * 180))
}

const SEG_CHARS: Record<number, string> = { 0x3f: '0', 0x06: '1', 0x5b: '2', 0x4f: '3', 0x66: '4', 0x6d: '5', 0x7d: '6', 0x07: '7', 0x7f: '8', 0x6f: '9', 0x77: 'A', 0x7c: 'b', 0x39: 'C', 0x5e: 'd', 0x79: 'E', 0x71: 'F', 0x40: '-', 0x00: ' ' }

function segText(segs: number[]): string {
  return segs.map((s) => SEG_CHARS[s & 0x7f] ?? '?').join('')
}

function imuRawOf(tx: number, ty: number): [number, number, number] {
  const x = (tx * Math.PI) / 180
  const y = (ty * Math.PI) / 180
  return [Math.round(16384 * Math.sin(y)), Math.round(16384 * Math.sin(x)), Math.round(16384 * Math.cos(x) * Math.cos(y))]
}

export function isCodeRuntime(r: SimRuntime): r is CodeRuntime {
  return r instanceof CodeRuntime
}

export type { Module, BoardHw }
void isPinConnected
void boardDefOf
