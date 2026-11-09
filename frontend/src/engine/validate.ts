import { getModule } from '../data/modules'
import { sharedBusCapability } from './autoAssign'
import { boardDefOf, boardLabel, resolveBoardPin, type Circuit } from './circuit'
import {
  asModuleBoardLink,
  describeEndpoint,
  endpointKey,
  isBoardToBoard,
  isPinConnected,
  moduleEndpoint,
  parseEndpointKey,
  requiredPins,
  resolveModulePin,
} from './connections'
import {
  boardPinVoltage,
  boardToBoardError,
  compatiblePins,
  groundPinsOf,
  isGpio,
  isUsbSerialPin,
  linkError,
  pinDisplayName,
  sourceVoltage,
  supplyPinOf,
  usesServo,
} from './electrical'
import { analyzeLevels } from './levels'
import { buildNetlist } from './netlist'
import { analyzePower, BREADBOARD_CURRENT_LIMIT_MA, formatCurrent, loadOfPin, motorsOnChannel, netVoltage, USB_5V_BUDGET_MA, wirePeakMa } from './power'
import { computeSeriesResistors, formatOhms } from './resistor'

// 전기적 검증. 결과는 화면의 [검사] 탭과 상태 표시줄에 표시된다.
// 이 검사는 데이터에 정의된 규칙과 대표값을 기준으로 한 것이며 실제 회로의 안전을 보장하지 않는다.
// 같은 규칙이 Python 백엔드(backend/autoino/engine)에도 구현되어 있으며, 공유 픽스처로 결과를 비교한다.

export type Severity = 'error' | 'warning' | 'info'

/** 규칙 식별자. 백엔드 구현과의 비교, 필터링에 사용한다. */
export type IssueCode =
  | 'missing-module-pin'
  | 'same-board'
  | 'board-board'
  | 'supply-backfeed'
  | 'module-short'
  | 'link-error'
  | 'undervoltage-supply'
  | 'board-power-warning'
  | 'supply-note'
  | 'usb-serial'
  | 'pin-restriction'
  | 'servo-pwm'
  | 'pin-conflict'
  | 'unconnected'
  | 'level-overvoltage'
  | 'level-low-high'
  | 'level-margin'
  | 'ground-not-common'
  | 'link-incomplete'
  | 'led-insufficient-voltage'
  | 'led-unknown-voltage'
  | 'led-low-margin'
  | 'led-near-limit'
  | 'led-always-on'
  | 'gpio-total-current'
  | 'usb-budget'
  | 'unknown-current'
  | 'i2c-address'
  | 'source-on-signal'
  | 'driver-output'
  | 'vin-undervoltage'
  | 'source-on-supply'
  | 'module-input-overvoltage'
  | 'supply-overvoltage'
  | 'supply-undervoltage'
  | 'supply-overload'
  | 'supply-peak'
  | 'supply-parallel'
  | 'motor-overvoltage'
  | 'motor-undervoltage'
  | 'driver-overcurrent'
  | 'driver-peak'
  | 'regulator-headroom'
  | 'module-ground-not-common'
  | 'breadboard-current'
  | 'setup-note'

export interface Issue {
  id: string
  code: IssueCode
  severity: Severity
  message: string
  hint?: string
  instanceId?: string
  connectionId?: string
  boardInstanceId?: string
}

export function validateCircuit(circuit: Circuit): Issue[] {
  const { placed, connections } = circuit
  const issues: Issue[] = []
  const push = (issue: Omit<Issue, 'id'>) => issues.push({ id: `${issues.length}`, ...issue })
  const servo = usesServo(placed, getModule)
  const netlist = buildNetlist(circuit)
  /** 레벨 시프터·분배기처럼 신호를 전달하는 부품을 한 넷으로 본 넷리스트 (신호 경로 추적용) */
  const traced = buildNetlist(circuit, { passThrough: true })

  // ---------- 연결별 검사 ----------
  /** 보드 인스턴스:GPIO → 그 핀을 쓰는 신호들 */
  const gpioUsers = new Map<string, { connectionId: string; label: string; bus: string | null; pinId: string; boardInstanceId: string }[]>()
  const addUser = (boardInstanceId: string, pinId: string, user: { connectionId: string; label: string; bus: string | null }) => {
    const key = `${boardInstanceId}:${pinId}`
    gpioUsers.set(key, [...(gpioUsers.get(key) ?? []), { ...user, pinId, boardInstanceId }])
  }

  for (const c of connections) {
    const label = `${describeEndpoint(c.from, circuit)} ↔ ${describeEndpoint(c.to, circuit)}`
    const ends = [c.from, c.to].map((e) => (e.kind === 'module' ? resolveModulePin(placed, e) : null))
    if ([c.from, c.to].some((e, i) => e.kind === 'module' && !ends[i])) {
      push({ code: 'missing-module-pin', severity: 'error', message: `존재하지 않는 부품 핀에 연결되어 있습니다: ${label}`, connectionId: c.id })
      continue
    }

    if (isBoardToBoard(c)) {
      const [a, b] = [c.from, c.to].map((e) => (e.kind === 'board' ? resolveBoardPin(circuit, e.boardInstanceId, e.pinId) : null))
      if (!a || !b) {
        push({ code: 'board-board', severity: 'error', message: `존재하지 않는 보드에 연결되어 있습니다: ${label}`, connectionId: c.id })
        continue
      }
      if (a.instance.instanceId === b.instance.instanceId) {
        push({ code: 'same-board', severity: 'error', message: `같은 보드의 핀끼리 직접 연결했습니다: ${label}`, connectionId: c.id })
        continue
      }
      const error = boardToBoardError(a.board, a.pin, b.board, b.pin)
      if (error) {
        push({ code: 'board-board', severity: 'error', message: `${label}: ${error}`, connectionId: c.id })
        continue
      }
      if (a.pin && supplyPinOf(a.board, a.pin.id))
        push({
          code: 'supply-backfeed',
          severity: 'warning',
          message: `${label}: 두 보드의 전원 핀을 연결했습니다. 양쪽 보드에 동시에 전원을 넣으면 역전류가 흐를 수 있습니다.`,
          hint: '전원은 한쪽 보드에서만 공급하고 GND 는 공통으로 연결하세요.',
          connectionId: c.id,
        })
      for (const r of [a, b])
        if (r.pin && isGpio(r.pin)) {
          const link = c.linkId ? circuit.links.find((l) => l.id === c.linkId) : undefined
          const bus = link?.protocol === 'I2C' ? (r.pin.capabilities.find((x) => x === 'i2c-sda' || x === 'i2c-scl') ?? null) : null
          addUser(r.instance.instanceId, r.pin.id, { connectionId: c.id, label, bus })
        }
      continue
    }

    const link = asModuleBoardLink(c)
    if (!link) {
      // 모듈 ↔ 모듈
      const roles = new Set(ends.map((r) => r!.pin.role))
      if ((roles.has('power') || roles.has('source')) && roles.has('ground'))
        push({ code: 'module-short', severity: 'error', message: `전원과 GND 가 연결되어 단락(쇼트)됩니다: ${label}`, connectionId: c.id })
      else if (roles.has('source') && roles.has('signal'))
        push({ code: 'source-on-signal', severity: 'error', message: `외부 전원을 신호 핀에 직접 연결했습니다: ${label}`, connectionId: c.id })
      else if (roles.has('drive') && !roles.has('load') && !roles.has('passive'))
        push({ code: 'driver-output', severity: 'error', message: `모터 드라이버 출력은 모터 단자에 연결합니다: ${label}`, connectionId: c.id })
      continue
    }

    const r = resolveModulePin(placed, moduleEndpoint(link.instanceId, link.modulePinId))!
    const target = resolveBoardPin(circuit, link.boardInstanceId, link.pinId)
    if (!target) {
      push({ code: 'link-error', severity: 'error', message: `${label}: 존재하지 않는 보드입니다.`, instanceId: link.instanceId, connectionId: c.id })
      continue
    }
    const { board, pin: boardPin } = target
    const error = linkError(board, r.module, r.pin, boardPin, r.placed)
    if (error) {
      const alternatives = boardPin || r.pin.role === 'signal' ? compatiblePins(board, r.module, r.pin, r.placed) : []
      push({
        code: 'link-error',
        severity: 'error',
        message: `${label}: ${error}`,
        hint: alternatives.length
          ? `연결 가능한 핀: ${alternatives.slice(0, 8).join(', ')}${alternatives.length > 8 ? ' …' : ''}`
          : undefined,
        instanceId: link.instanceId,
        connectionId: c.id,
        boardInstanceId: link.boardInstanceId,
      })
      continue
    }
    if (!boardPin) continue

    if (r.pin.role === 'source') {
      const volts = sourceVoltage(r.module, r.placed, r.pin)
      const input = board.powerInput
      if (input?.pinId === boardPin.id) {
        if (volts !== null && volts < input.minVoltage)
          push({
            code: 'vin-undervoltage',
            severity: 'warning',
            message: `${r.placed.label}: ${volts} V 는 ${boardPin.id} 권장 입력(${input.minVoltage}–${input.maxVoltage} V)보다 낮아 보드가 불안정할 수 있습니다.`,
            hint: '5 V 전원은 USB 나 5V 핀으로 넣는 것이 낫습니다.',
            instanceId: link.instanceId,
            connectionId: c.id,
          })
      } else if (supplyPinOf(board, boardPin.id))
        push({
          code: 'source-on-supply',
          severity: 'warning',
          message: `${r.placed.label}: ${boardPin.id} 핀에 전원을 직접 넣으면 보드 레귤레이터와 보호 회로를 거치지 않습니다.`,
          hint: '전압이 정확한 안정화 전원만 쓰고, USB 를 함께 연결하지 마세요.',
          instanceId: link.instanceId,
          connectionId: c.id,
        })
    }

    if (r.pin.role === 'power') {
      const v = boardPinVoltage(board, boardPin)
      const needed = r.pin.minVoltage ?? r.pin.supplyVoltage
      if (needed && r.pin.supplyVoltage && v !== null && v < needed)
        push({
          code: 'undervoltage-supply',
          severity: 'warning',
          message: `${r.placed.label}: ${r.pin.supplyVoltage} V 부품을 ${boardPin.id} 에 연결했습니다. 동작하지 않거나 불안정할 수 있습니다.`,
          instanceId: link.instanceId,
          connectionId: c.id,
        })
      if (r.module.boardPowerWarning)
        push({ code: 'board-power-warning', severity: 'warning', message: `${r.placed.label}: ${r.module.boardPowerWarning}`, instanceId: link.instanceId, connectionId: c.id })
      const supplyNote = supplyPinOf(board, boardPin.id)?.note
      if (supplyNote)
        push({ code: 'supply-note', severity: 'info', message: `${r.placed.label}: ${boardPin.id} — ${supplyNote}`, instanceId: link.instanceId, connectionId: c.id })
    }

    if (r.pin.role === 'signal' && isGpio(boardPin)) {
      addUser(link.boardInstanceId, boardPin.id, { connectionId: c.id, label: `${r.placed.label} · ${r.pin.name}`, bus: sharedBusCapability(r.pin) })

      if (r.pin.maxInputVoltage && board.logicVoltage > r.pin.maxInputVoltage + 0.01)
        push({
          code: 'module-input-overvoltage',
          severity: 'warning',
          message: `${r.placed.label} · ${r.pin.name}: ${board.name} 의 ${board.logicVoltage} V 신호가 이 핀의 허용 전압(${r.pin.maxInputVoltage} V)을 넘습니다.`,
          hint: '전압 분배기나 레벨 시프터로 신호를 낮춰 연결하세요.',
          instanceId: link.instanceId,
          connectionId: c.id,
        })
      if (isUsbSerialPin(board, boardPin))
        push({
          code: 'usb-serial',
          severity: 'warning',
          message: `${r.placed.label} · ${r.pin.name} → ${boardPin.id}: USB 시리얼(스케치 업로드·시리얼 모니터)과 공유되는 핀입니다.`,
          hint: '업로드가 실패하거나 시리얼 통신이 방해받을 수 있습니다.',
          instanceId: link.instanceId,
          connectionId: c.id,
        })
      for (const restriction of boardPin.restrictions ?? []) {
        const relevant =
          restriction.kind === 'strapping' ||
          restriction.kind === 'onboard-led' ||
          (restriction.kind === 'no-internal-pull' && r.pin.pull === 'up') ||
          (restriction.kind === 'adc2-wifi' && r.pin.requires.includes('analog'))
        if (!relevant) continue
        push({
          code: 'pin-restriction',
          severity: restriction.kind === 'onboard-led' ? 'info' : 'warning',
          message: `${r.placed.label} · ${r.pin.name} → ${pinDisplayName(boardPin)}: ${restriction.description}`,
          hint: restriction.kind === 'strapping' || restriction.kind === 'no-internal-pull' ? '[자동 핀 배정]은 이런 핀을 가능한 한 피합니다.' : undefined,
          instanceId: link.instanceId,
          connectionId: c.id,
        })
      }
      if (servo && r.pin.prefers?.includes('pwm') && board.servoPwmConflictPins.includes(boardPin.id))
        push({
          code: 'servo-pwm',
          severity: 'warning',
          message: `${r.placed.label}: Servo 라이브러리를 사용하면 ${boardPin.id} 에서 analogWrite(PWM 밝기 조절)를 쓸 수 없습니다.`,
          hint: '켜기/끄기는 가능합니다. 밝기 조절이 필요하면 다른 PWM 핀으로 옮기세요.',
          instanceId: link.instanceId,
          connectionId: c.id,
        })
    }
  }

  // ---------- 핀 충돌 ----------
  for (const users of gpioUsers.values()) {
    if (users.length < 2) continue
    const bus = users[0].bus
    if (bus && users.every((u) => u.bus === bus)) continue // I²C 등 공유 버스
    const prefix = circuit.boards.length > 1 ? `${boardLabel(circuit, users[0].boardInstanceId)} ` : ''
    push({
      code: 'pin-conflict',
      severity: 'error',
      message: `핀 충돌: ${prefix}${users[0].pinId} 에 신호 ${users.length}개가 연결되어 있습니다 (${users.map((u) => u.label).join(', ')}).`,
      hint: '[자동 핀 배정]을 누르면 나중에 연결된 신호를 빈 핀으로 재배치합니다.',
      connectionId: users[users.length - 1].connectionId,
      boardInstanceId: users[0].boardInstanceId,
    })
  }

  // ---------- 미연결 핀 ----------
  for (const item of placed) {
    const module = getModule(item.moduleId)
    const missing = requiredPins(connections, item.instanceId, module).filter((p) => !isPinConnected(connections, item.instanceId, p.id))
    if (missing.length)
      push({
        code: 'unconnected',
        severity: 'warning',
        message: `${item.label}: ${missing.map((p) => p.name).join(', ')} 미연결`,
        hint: module.motor
          ? '모터는 보드에 바로 연결하지 않습니다. 모터 드라이버(L298N 등)를 추가하고 [자동 핀 배정]을 누르세요.'
          : '핀을 끌어 보드 핀에 연결하거나 [자동 핀 배정]을 사용하세요.',
        instanceId: item.instanceId,
      })
  }

  // ---------- 전압 레벨 (넷 단위) ----------
  for (const f of analyzeLevels(circuit, netlist)) {
    const c = connections.find((cc) => endpointKey(cc.from) === f.key || endpointKey(cc.to) === f.key)
    push({
      code: f.severity === 'error' ? 'level-overvoltage' : f.severity === 'warning' ? 'level-low-high' : 'level-margin',
      severity: f.severity,
      message: f.message,
      hint: f.hint,
      instanceId: f.driver.instanceId,
      connectionId: c?.id,
      boardInstanceId: f.boardInstanceId,
    })
  }

  // ---------- 보드 간 GND 공통 ----------
  const groundNet = new Map<string, string>()
  for (const b of circuit.boards) {
    const def = boardDefOf(circuit, b.instanceId)
    const g = def && groundPinsOf(def)[0]
    if (g) groundNet.set(b.instanceId, netlist.netOf(`board:${b.instanceId}:${g}`))
  }
  const reported = new Set<string>()
  for (const keys of netlist.members.values()) {
    const boardsInNet = new Set<string>()
    for (const k of keys) {
      const m = k.match(/^board:([^:]+):(.+)$/)
      if (!m) continue
      const r = resolveBoardPin(circuit, m[1], m[2])
      if (r?.pin && isGpio(r.pin)) boardsInNet.add(m[1])
    }
    const ids = [...boardsInNet].sort()
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const pair = `${ids[i]}|${ids[j]}`
        if (reported.has(pair) || groundNet.get(ids[i]) === groundNet.get(ids[j])) continue
        reported.add(pair)
        push({
          code: 'ground-not-common',
          severity: 'error',
          message: `${boardLabel(circuit, ids[i])} 와 ${boardLabel(circuit, ids[j])} 가 신호로 연결되어 있지만 GND 가 연결되어 있지 않습니다.`,
          hint: '두 보드의 GND 를 서로 연결하세요. 기준 전압이 다르면 신호를 읽을 수 없습니다.',
          boardInstanceId: ids[j],
        })
      }
  }

  // ---------- 보드 간 통신 연결 완전성 ----------
  for (const link of circuit.links) {
    const missing = link.pairs.filter(
      (p) => traced.netOf(`board:${link.a.boardInstanceId}:${p.a}`) !== traced.netOf(`board:${link.b.boardInstanceId}:${p.b}`),
    )
    if (missing.length)
      push({
        code: 'link-incomplete',
        severity: 'warning',
        message: `${link.protocol} 통신 (${boardLabel(circuit, link.a.boardInstanceId)} ↔ ${boardLabel(circuit, link.b.boardInstanceId)}): ${missing.map((p) => p.signal).join(', ')} 연결이 빠져 있습니다.`,
        hint: '연결 방식 창에서 통신 연결을 지우고 다시 만들 수 있습니다.',
        boardInstanceId: link.b.boardInstanceId,
      })
  }

  // ---------- 직렬 저항 · 전류 ----------
  const gpioCurrentMa = new Map<string, number>()
  const fiveVoltMa = new Map<string, number>()
  const addMa = (map: Map<string, number>, id: string, ma: number) => map.set(id, (map.get(id) ?? 0) + ma)
  for (const res of computeSeriesResistors(circuit)) {
    const item = placed.find((p) => p.instanceId === res.instanceId)!
    if (res.status === 'insufficient-voltage')
      push({
        code: 'led-insufficient-voltage',
        severity: 'error',
        message: `${item.label}: 공급 전압(${res.supplyVoltage} V)이 순방향 전압(약 ${res.forwardVoltage} V)보다 높지 않아 켜지지 않습니다.`,
        instanceId: item.instanceId,
      })
    if (res.status === 'unknown-voltage')
      push({ code: 'led-unknown-voltage', severity: 'warning', message: `${item.label}: ${res.boardPinId} 의 전압을 알 수 없어 저항을 계산할 수 없습니다.`, instanceId: item.instanceId })
    if (res.status !== 'ok') continue
    const target = resolveBoardPin(circuit, res.boardInstanceId, res.boardPinId)!
    const { choice } = res
    if (choice.supplyVoltage - choice.forwardVoltage < 0.5)
      push({
        code: 'led-low-margin',
        severity: 'warning',
        message: `${item.label}: 공급 전압(${choice.supplyVoltage} V)과 순방향 전압(약 ${choice.forwardVoltage} V)의 차이가 작아 제품에 따라 어둡거나 켜지지 않을 수 있습니다.`,
        hint: '5 V 핀이나 GPIO(5 V)에 연결하는 것을 권장합니다.',
        instanceId: item.instanceId,
      })
    if (target.pin && isGpio(target.pin)) {
      addMa(gpioCurrentMa, res.boardInstanceId, choice.actualMa)
      if (choice.actualMa > target.board.ioPinCurrentLimitMa * 0.9)
        push({
          code: 'led-near-limit',
          severity: 'warning',
          message: `${item.label}: ${res.boardPinId} 전류 약 ${choice.actualMa.toFixed(1)} mA 로 핀 권장 한계(${target.board.ioPinCurrentLimitMa} mA)에 가깝습니다.`,
          hint: '목표 전류를 10 mA 정도로 낮추는 것을 권장합니다.',
          instanceId: item.instanceId,
        })
    } else {
      addMa(fiveVoltMa, res.boardInstanceId, choice.actualMa)
      push({
        code: 'led-always-on',
        severity: 'info',
        message: `${item.label}: ${res.boardPinId} 에 직접 연결되어 항상 켜져 있습니다 (직렬 저항 ${formatOhms(choice.standardOhms)}).`,
        instanceId: item.instanceId,
      })
    }
  }
  for (const [boardInstanceId, ma] of gpioCurrentMa) {
    const board = boardDefOf(circuit, boardInstanceId)!
    if (ma > board.totalCurrentLimitMa)
      push({
        code: 'gpio-total-current',
        severity: 'error',
        message: `GPIO 출력 전류 합계 약 ${ma.toFixed(0)} mA 가 ${board.microcontroller} 전체 한계(${board.totalCurrentLimitMa} mA)를 넘습니다.`,
        hint: 'LED 목표 전류를 낮추거나 트랜지스터로 구동하세요.',
        boardInstanceId,
      })
  }

  // ---------- 5V 전원 예산 (추정) ----------
  const unknownFiveVolt = new Map<string, string[]>()
  for (const item of placed) {
    const module = getModule(item.moduleId)
    for (const pin of module.pins.filter((p) => p.role === 'power')) {
      const l = connections
        .map(asModuleBoardLink)
        .find((x) => x && x.instanceId === item.instanceId && x.modulePinId === pin.id)
      const target = l && resolveBoardPin(circuit, l.boardInstanceId, l.pinId)
      if (!l || !target || (supplyPinOf(target.board, l.pinId)?.voltage ?? 0) < 4.5) continue
      const { typicalMa } = loadOfPin(circuit, netlist, item, module, pin)
      if (typicalMa !== null) addMa(fiveVoltMa, l.boardInstanceId, typicalMa)
      else unknownFiveVolt.set(l.boardInstanceId, [...(unknownFiveVolt.get(l.boardInstanceId) ?? []), item.label])
    }
  }
  for (const [boardInstanceId, ma] of fiveVoltMa)
    if (ma > USB_5V_BUDGET_MA)
      push({
        code: 'usb-budget',
        severity: 'warning',
        message: `보드 5V 사용 전류가 약 ${ma.toFixed(0)} mA 로 USB 전원 여유(약 ${USB_5V_BUDGET_MA} mA)를 넘을 수 있습니다.`,
        boardInstanceId,
      })
  for (const [boardInstanceId, labels] of unknownFiveVolt)
    push({
      code: 'unknown-current',
      severity: 'info',
      message: `소비 전류를 알 수 없는 부품이 5V 에 연결되어 있습니다: ${labels.join(', ')}. 전원 예산은 제품 사양으로 확인하세요.`,
      boardInstanceId,
    })

  // ---------- I²C 주소 중복 (같은 SDA 넷 = 같은 버스) ----------
  const byBus = new Map<string, { address: string; label: string }[]>()
  const addDevice = (busKey: string, address: string, label: string) =>
    byBus.set(busKey, [...(byBus.get(busKey) ?? []), { address, label }])
  for (const item of placed) {
    const module = getModule(item.moduleId)
    const sda = module.pins.find((p) => p.requires.includes('i2c-sda'))
    if (!module.i2cAddress || !sda) continue
    const key = endpointKey(moduleEndpoint(item.instanceId, sda.id))
    // 아직 연결되지 않은 장치는 호스트 보드의 버스에 붙는다고 본다
    addDevice(isPinConnected(connections, item.instanceId, sda.id) ? traced.netOf(key) : `host:${item.hostBoardId}`, module.i2cAddress, item.label)
  }
  for (const link of circuit.links)
    if (link.protocol === 'I2C' && link.i2cAddress && link.b.pins.SDA)
      addDevice(traced.netOf(`board:${link.b.boardInstanceId}:${link.b.pins.SDA}`), link.i2cAddress, `${boardLabel(circuit, link.b.boardInstanceId)} (I²C 주변장치)`)
  for (const devices of byBus.values()) {
    const byAddress = new Map<string, string[]>()
    for (const d of devices) byAddress.set(d.address, [...(byAddress.get(d.address) ?? []), d.label])
    for (const [address, labels] of byAddress)
      if (labels.length > 1)
        push({
          code: 'i2c-address',
          severity: 'warning',
          message: `I²C 주소 충돌 가능: ${labels.join(', ')} 의 기본 주소가 모두 ${address} 입니다.`,
          hint: '모듈 뒷면의 주소 점퍼(A0–A2)로 주소를 서로 다르게 설정해야 합니다.',
        })
  }

  // ---------- 전원 (외부 전원·레귤레이터·보드 전원 핀) ----------
  const power = analyzePower(circuit, netlist)
  for (const s of power.sources) {
    for (const load of s.loads) {
      const where = load.instanceId ?? undefined
      if (load.maxVoltage !== null && s.voltage > load.maxVoltage + 0.01)
        push({
          code: 'supply-overvoltage',
          severity: 'error',
          message: `${load.label} · ${load.pinName}: ${s.label} 전압(${s.voltage} V)이 허용 최대 전압(${load.maxVoltage} V)을 넘습니다.`,
          hint: '맞는 전압의 전원으로 바꾸거나 벅 컨버터로 전압을 낮추세요.',
          instanceId: where,
        })
      else if (s.kind !== 'board' && load.minVoltage !== null && s.voltage < load.minVoltage - 0.01)
        push({
          code: 'supply-undervoltage',
          severity: 'warning',
          message: `${load.label} · ${load.pinName}: ${s.label} 전압(${s.voltage} V)이 최소 동작 전압(${load.minVoltage} V)보다 낮습니다.`,
          instanceId: where,
        })
    }
    if (s.kind !== 'board' && s.limitMa !== null && s.status === 'overload')
      push({
        code: 'supply-overload',
        severity: 'error',
        message: `${s.label}: 평상시 전류 ${formatCurrent(s.typicalMa)} 가 전원 용량 ${formatCurrent(s.limitMa)} 을 넘습니다.`,
        hint: '[전원] 탭에서 맞는 전원을 고르세요.',
      })
    else if (s.kind !== 'board' && s.limitMa !== null && s.status === 'peak')
      push({
        code: 'supply-peak',
        severity: 'warning',
        message: `${s.label}: 기동·스톨 때 최대 ${formatCurrent(s.peakMa)} 까지 흘러 전원 용량 ${formatCurrent(s.limitMa)} 을 넘을 수 있습니다.`,
        hint: '전압이 순간적으로 떨어져 보드가 리셋될 수 있습니다. 용량이 더 큰 전원을 권장합니다.',
      })
    if (s.parallel.length)
      push({
        code: 'supply-parallel',
        severity: 'warning',
        message: `${s.label} 와 ${s.parallel.join(', ')} 의 + 가 같은 넷에 연결되어 있습니다. 전원 두 개를 바로 이으면 역전류가 흐를 수 있습니다.`,
        hint: '전원은 하나만 연결하고 GND 만 공통으로 잇는 것이 안전합니다.',
      })
  }

  // ---------- 모터 ↔ 드라이버 ----------
  for (const item of placed) {
    const module = getModule(item.moduleId)
    const driver = module.driver
    if (!driver) continue
    const supply = netVoltage(circuit, netlist, endpointKey(moduleEndpoint(item.instanceId, driver.supplyPin)))
    for (const channel of driver.channels) {
      const motors = motorsOnChannel(circuit, netlist, item, channel)
      if (!motors.length) continue
      const typical = motors.reduce((sum, m) => sum + m.module.motor!.typicalMa, 0)
      const peak = motors.reduce((sum, m) => sum + m.module.motor!.peakMa, 0)
      if (typical > driver.channelMa)
        push({
          code: 'driver-overcurrent',
          severity: 'error',
          message: `${item.label} ${channel.label}: 모터 전류 ${formatCurrent(typical)} 가 채널 정격 ${formatCurrent(driver.channelMa)} 을 넘습니다.`,
          hint: '전류가 더 큰 드라이버를 쓰거나 모터를 채널에 나눠 연결하세요.',
          instanceId: item.instanceId,
        })
      else if (peak > driver.channelPeakMa)
        push({
          code: 'driver-peak',
          severity: 'warning',
          message: `${item.label} ${channel.label}: 모터 스톨 전류 ${formatCurrent(peak)} 가 채널 최대 ${formatCurrent(driver.channelPeakMa)} 을 넘습니다.`,
          hint: '모터가 걸려서 멈추면 드라이버가 손상될 수 있습니다.',
          instanceId: item.instanceId,
        })
      if (supply === null) continue
      const volts = Math.round((supply - driver.dropVoltage) * 10) / 10
      for (const m of motors) {
        const spec = m.module.motor!
        if (volts > spec.maxVoltage + 0.01)
          push({
            code: 'motor-overvoltage',
            severity: 'error',
            message: `${m.item.label}: 모터에 약 ${volts} V 가 걸려 허용 전압(${spec.maxVoltage} V)을 넘습니다.`,
            hint: '전압이 낮은 전원을 쓰세요. PWM 으로 평균 전압을 낮출 수도 있지만 코드 실수로 모터가 탈 수 있습니다.',
            instanceId: m.item.instanceId,
          })
        else if (volts < spec.minVoltage - 0.01)
          push({
            code: 'motor-undervoltage',
            severity: 'warning',
            message: `${m.item.label}: 드라이버 전압 강하 뒤 모터 전압이 약 ${volts} V 로 최소 동작 전압(${spec.minVoltage} V)보다 낮습니다.`,
            instanceId: m.item.instanceId,
          })
      }
    }
  }

  // ---------- 레귤레이터 입력 여유 ----------
  for (const item of placed) {
    const module = getModule(item.moduleId)
    if (!module.regulator) continue
    const input = netVoltage(circuit, netlist, endpointKey(moduleEndpoint(item.instanceId, module.regulator.inputPin)))
    const output = Math.max(...module.pins.filter((p) => p.role === 'source').map((p) => sourceVoltage(module, item, p) ?? 0))
    const needed = Math.round((output + module.regulator.dropVoltage) * 10) / 10
    if (input !== null && input < needed - 0.01)
      push({
        code: 'regulator-headroom',
        severity: 'warning',
        message: `${item.label}: 입력 ${input} V 로는 출력 ${output} V 를 만들 수 없습니다 (입력 ${needed} V 이상 필요).`,
        instanceId: item.instanceId,
      })
  }

  // ---------- 외부 전원을 쓰는 부품의 GND 공통 ----------
  for (const item of placed) {
    const module = getModule(item.moduleId)
    const grounds = module.pins.filter((p) => p.role === 'ground' && isPinConnected(connections, item.instanceId, p.id))
    if (!grounds.length) continue
    const boardsUsed = new Set<string>()
    for (const pin of module.pins.filter((p) => p.role === 'signal')) {
      const key = endpointKey(moduleEndpoint(item.instanceId, pin.id))
      for (const k of netlist.members.get(netlist.netOf(key)) ?? []) {
        const e = parseEndpointKey(k)
        if (e?.kind !== 'board') continue
        const r = resolveBoardPin(circuit, e.boardInstanceId, e.pinId)
        if (r?.pin && isGpio(r.pin)) boardsUsed.add(e.boardInstanceId)
      }
    }
    for (const id of [...boardsUsed].sort()) {
      const boardGround = groundNet.get(id)
      if (grounds.some((p) => netlist.netOf(endpointKey(moduleEndpoint(item.instanceId, p.id))) === boardGround)) continue
      push({
        code: 'module-ground-not-common',
        severity: 'error',
        message: `${item.label}: 신호는 ${boardLabel(circuit, id)}에 연결되어 있는데 GND 가 ${boardLabel(circuit, id)}와 이어져 있지 않습니다.`,
        hint: '외부 전원 − 를 보드 GND 에 연결하세요. 기준 전압이 다르면 신호가 통하지 않습니다.',
        instanceId: item.instanceId,
      })
      break
    }
  }

  // ---------- 브레드보드 허용 전류 ----------
  for (const c of connections) {
    if (c.via !== 'breadboard') continue
    const peak = wirePeakMa(circuit, c.from, c.to, netlist)
    if (peak >= BREADBOARD_CURRENT_LIMIT_MA)
      push({
        code: 'breadboard-current',
        severity: 'warning',
        message: `${describeEndpoint(c.from, circuit)} ↔ ${describeEndpoint(c.to, circuit)}: 최대 ${formatCurrent(peak)} 가 흘러 브레드보드 접점 허용 전류(약 ${formatCurrent(BREADBOARD_CURRENT_LIMIT_MA)})를 넘습니다.`,
        hint: '이 전선을 선택해 [보드 직결]로 바꾸세요.',
        connectionId: c.id,
      })
  }

  // ---------- 설치 안내 ----------
  for (const item of placed) {
    const note = getModule(item.moduleId).setupNote
    if (note) push({ code: 'setup-note', severity: 'info', message: `${item.label}: ${note}`, instanceId: item.instanceId })
  }

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
  return issues.sort((a, b) => order[a.severity] - order[b.severity] || Number(a.id) - Number(b.id))
}

export function countIssues(issues: Issue[]): Record<Severity, number> {
  return {
    error: issues.filter((i) => i.severity === 'error').length,
    warning: issues.filter((i) => i.severity === 'warning').length,
    info: issues.filter((i) => i.severity === 'info').length,
  }
}
