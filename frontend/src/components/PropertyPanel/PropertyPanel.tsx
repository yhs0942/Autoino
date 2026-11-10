import { CAPABILITY_LABELS, CONFIDENCE_LABELS, RESTRICTION_LABELS, ROLE_LABELS } from '../../data/labels'
import { CATEGORY_LABELS, getModule } from '../../data/modules'
import { findBoard } from '../../data/boards'
import { holeLabel, holeName, verifyRouting, type BreadboardRouting } from '../../engine/breadboard'
import { leadLabel } from '../../engine/breadboardSvg'
import { boardDefOf, boardLabel, type Circuit } from '../../engine/circuit'
import { asModuleBoardLink, boardPinFor, describeEndpoint, moduleEndpoint, requiredPins, resolveModulePin, touches } from '../../engine/connections'
import { compatiblePins, isGpio, pinDisplayName, supplyPinsOf } from '../../engine/electrical'
import type { PinTableRow } from '../../engine/exporters'
import type { PowerNeed, PowerReport, SupplyExample } from '../../engine/power'
import { formatOhms, type SeriesResistorResult } from '../../engine/resistor'
import { countIssues, type Issue } from '../../engine/validate'
import type { Board, Connection, ElectricalSpec, Endpoint, PlacedBoard, PlacedModule, RouteMode, Selection } from '../../types'
import { assetUrl } from '../../utils/assetUrl'
import { PinTable } from '../PinTable/PinTable'
import { NeedQuick, PowerPanel } from '../PowerPanel/PowerPanel'
import { placedSupplies, SUPPLY_PARAM } from '../../engine/supplyInfo'
import { capacityLabel, MOTOR_KIND_LABELS, motorDriverOf, planMotorAttach, recommendDriver } from '../../engine/motorAttach'
import { shareBoardPin, shareRole } from '../../engine/shares'
import { IssueList, ValidationPanel } from '../ValidationPanel/ValidationPanel'
import './PropertyPanel.css'

export type PanelTab = 'properties' | 'validation' | 'pins' | 'power'

interface PropertyPanelProps {
  /** 선택이 없을 때 안내에 표시할 보드 (첫 번째 보드) */
  board: Board
  circuit: Circuit
  selection: Selection
  issues: Issue[]
  resistors: SeriesResistorResult[]
  pinRows: PinTableRow[]
  power: PowerReport
  routing: BreadboardRouting
  tab: PanelTab
  onTabChange: (tab: PanelTab) => void
  onSelect: (selection: Selection) => void
  onRemove: (instanceId: string) => void
  onRemoveConnection: (connectionId: string) => void
  onSetParam: (instanceId: string, paramId: string, value: string) => void
  onRemoveBoard: (boardInstanceId: string) => void
  onSetHostBoard: (instanceId: string, boardInstanceId: string) => void
  onSetRoute: (connectionId: string, via: RouteMode) => void
  onApplySupply: (need: PowerNeed, example: SupplyExample) => void
  onExportBreadboard: (format: 'svg' | 'png') => void
  onRetarget: (connectionIds: string[], from: Endpoint, to: Endpoint) => void
  onResetBreadboard: () => void
  merges: { voltage: number; items: { instanceId: string; label: string }[] }[]
  onMerge: (keepId: string, otherIds: string[]) => void
  onAttachMotor: (motorId: string, driverId: string) => void
  onAddDriver: (motorId: string) => void
  onResetModuleWiring: (instanceId: string) => void
  onAutoAssignModule: (instanceId: string) => void
  onUnshare: (key: string) => void
}

/** 부품 속성에서 바로 하는 외부 전원·모터 드라이버 연결 */
function ModuleHookups({ item, circuit, props }: { item: PlacedModule; circuit: Circuit; props: PropertyPanelProps }) {
  const module = getModule(item.moduleId)
  const need = props.power.needs.find((n) => n.pins.some((k) => k.startsWith(`module:${item.instanceId}:`)) || n.consumers.some((c) => c.instanceId === item.instanceId))
  const attached = module.motor ? motorDriverOf(circuit, item) : null
  const merge = props.merges.find((m) => m.items.some((i) => i.instanceId === item.instanceId))
  const drivers = module.motor
    ? circuit.placed.filter((d) => d !== item && getModule(d.moduleId).driver).map((d) => ({ d, plan: planMotorAttach(circuit, item.instanceId, d.instanceId) }))
    : []
  const recommended = module.motor && !attached ? recommendDriver(module) : null
  const wired = circuit.connections.some((c) => [c.from, c.to].some((e) => e.kind === 'module' && e.instanceId === item.instanceId))
  const myShares = (circuit.shares ?? []).flatMap((s) => s.members.filter((k) => k.startsWith(`module:${item.instanceId}:`)).map((k) => ({ s, key: k })))
  const sharable = module.pins.some((p) => shareRole(module, p))
  return (
    <>
      <section className="prop-section" data-testid="module-wiring">
        <h3>이 부품의 배선</h3>
        <p className="muted small">작업 화면에서 이 부품의 전선과 보드까지의 경로가 빛납니다.</p>
        <div className="prop-actions">
          <button type="button" className="button button--small" onClick={() => props.onAutoAssignModule(item.instanceId)} data-testid="module-autoassign">
            이 부품만 자동 배정
          </button>
          <button type="button" className="button button--small button--danger-outline" disabled={!wired} onClick={() => props.onResetModuleWiring(item.instanceId)} data-testid="module-reset-wiring">
            배선 초기화
          </button>
        </div>
      </section>
      {(myShares.length > 0 || sharable) && (
        <section className="prop-section" data-testid="share-section">
          <h3>핀 공유</h3>
          {myShares.length ? (
            myShares.map(({ s, key }) => {
              const pin = module.pins.find((p) => key.endsWith(`:${p.id}`))
              const at = shareBoardPin(circuit, s)
              const others = s.members.filter((k) => k !== key).map((k) => circuit.placed.find((p) => k.startsWith(`module:${p.instanceId}:`))?.label ?? k)
              return (
                <div key={key} className="share-row">
                  <p className="small">
                    <strong>{pin?.name}</strong> 를 {others.join(', ')}와(과) {at ? `${at.pinId} 에서 ` : ''}함께 씁니다.
                  </p>
                  <button type="button" className="button button--small" onClick={() => props.onUnshare(key)} data-testid="unshare">
                    공유 풀기
                  </button>
                </div>
              )
            })
          ) : (
            <p className="muted small">이 부품의 핀을 같은 종류 부품(출력끼리·버튼끼리)의 핀에 끌어 놓으면 한 보드 핀을 함께 쓰는 그룹이 됩니다. Uno·Nano·Mega 아날로그 핀의 버튼은 저항 사다리로 구분됩니다.</p>
          )}
        </section>
      )}
      {module.motor && (
        <section className="prop-section" data-testid="motor-hookup">
          <h3>모터 드라이버</h3>
          {attached ? (
            <p className="callout callout--ok">
              {attached.driver.label} {attached.channel.label}에 연결됨
            </p>
          ) : (
            <>
              <p className="muted small">{MOTOR_KIND_LABELS[module.motor.kind]}는 드라이버를 거쳐야 합니다. 이 카드를 드라이버 카드 위로 끌어다 놓아도 연결됩니다.</p>
              <div className="prop-actions">
                {drivers.filter((x) => x.plan.ok).map(({ d, plan }) => (
                  <button key={d.instanceId} type="button" className="button button--small" onClick={() => props.onAttachMotor(item.instanceId, d.instanceId)}>
                    {d.label} {plan.ok ? plan.channel.label : ''}에 연결
                  </button>
                ))}
                {recommended && (
                  <button type="button" className="button button--small button--primary" onClick={() => props.onAddDriver(item.instanceId)} data-testid="prop-add-driver">
                    {recommended.name} 추가하고 연결
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      )}
      {module.driver && (
        <section className="prop-section">
          <h3>연결할 수 있는 모터</h3>
          <p className="muted small">{capacityLabel(module)} — 모터 카드를 이 카드 위로 끌어다 놓으면 빈 채널에 연결됩니다.</p>
        </section>
      )}
      {need && (
        <section className="prop-section" data-testid="power-hookup">
          <h3>외부 전원</h3>
          <NeedQuick need={need} onApply={props.onApplySupply} onMore={() => props.onTabChange('power')} />
        </section>
      )}
      {merge && (
        <section className="prop-section">
          <h3>같은 전압 전원</h3>
          <p className="muted small">
            {merge.items.map((i) => i.label).join(', ')}이(가) 모두 {merge.voltage} V 입니다. 하나로 합치면 부품들이 한 전원을 나눠 쓰고, 전류 용량은 둘을 더한 값으로 맞춥니다.
          </p>
          <button
            type="button"
            className="button button--small"
            data-testid="merge-supplies"
            onClick={() => props.onMerge(item.instanceId, merge.items.filter((i) => i.instanceId !== item.instanceId).map((i) => i.instanceId))}
          >
            이 전원으로 합치기
          </button>
        </section>
      )}
    </>
  )
}

function ElectricalList({ specs }: { specs: ElectricalSpec[] }) {
  return (
    <ul className="spec-list">
      {specs.map((s) => (
        <li key={s.label}>
          <div className="spec-list__row">
            <span className="spec-list__label">{s.label}</span>
            <span className="spec-list__value">{s.value}</span>
          </div>
          <span className={`confidence confidence--${s.confidence}`}>{CONFIDENCE_LABELS[s.confidence]}</span>
          {s.note && <p className="spec-list__note">{s.note}</p>}
        </li>
      ))}
    </ul>
  )
}

function ResistorSummary({ result }: { result: SeriesResistorResult }) {
  if (result.status === 'unconnected')
    return <p className="muted small">핀을 보드에 연결하면 직렬 저항이 자동으로 계산됩니다.</p>
  if (result.status === 'insufficient-voltage')
    return (
      <p className="callout callout--error">
        공급 전압 {result.supplyVoltage} V 가 순방향 전압 약 {result.forwardVoltage} V 이하라서 LED 가 켜지지 않습니다.
      </p>
    )
  if (result.status === 'unknown-voltage')
    return <p className="callout callout--warning">{result.boardPinId} 의 전압을 알 수 없어 계산할 수 없습니다.</p>
  const c = result.choice
  return (
    <div className="resistor-card" data-testid="resistor-result">
      <div className="resistor-card__value">{formatOhms(c.standardOhms)}</div>
      <div className="resistor-card__meta">E12 표준값 · {c.ratingLabel} 저항</div>
      <dl className="kv">
        <div>
          <dt>계산식</dt>
          <dd className="mono">
            ({c.supplyVoltage} − {c.forwardVoltage}) V ÷ {c.targetMa} mA = {formatOhms(c.calculatedOhms)}
          </dd>
        </div>
        <div>
          <dt>실제 전류</dt>
          <dd>약 {c.actualMa.toFixed(1)} mA</dd>
        </div>
        <div>
          <dt>저항 소비 전력</dt>
          <dd>약 {c.powerMw.toFixed(0)} mW</dd>
        </div>
        <div>
          <dt>연결 위치</dt>
          <dd>{result.boardPinId} 와 LED 애노드 사이</dd>
        </div>
      </dl>
      <p className="muted small">순방향 전압은 색상별 대표값입니다. 실제 LED 의 데이터시트 값으로 확인하세요.</p>
    </div>
  )
}

function BoardProperties({
  board,
  instance,
  circuit,
  onRemoveBoard,
}: {
  board: Board
  instance: PlacedBoard
  circuit: Circuit
  onRemoveBoard: (boardInstanceId: string) => void
}) {
  const multi = circuit.boards.length > 1
  const inputOnly = board.pins.filter((p) => p.restrictions?.some((r) => r.kind === 'input-only'))
  const restricted = board.pins.filter((p) => p.restrictions?.length)
  const rows: [string, string][] = [
    ['마이크로컨트롤러', board.microcontroller],
    ['클록', board.clockSpeed],
    [
      'I/O 논리 전압',
      `${board.logicVoltage} V` + (board.gpioMaxInputVoltage ? ` (GPIO 최대 입력 ${board.gpioMaxInputVoltage} V)` : ''),
    ],
    ['디지털 I/O', `${board.digitalIoCount}개` + (inputOnly.length ? ` (입력 전용 ${inputOnly.length}개 포함)` : '')],
    ['아날로그 입력', `${board.analogInputCount}개`],
    ['PWM 핀', `${board.pwmPins.length}개 (${board.pwmPins.join(', ')})`],
    ['외부 인터럽트 핀', `${board.interruptPins.length}개 (${board.interruptPins.join(', ')})`],
    ['플래시', board.memory.flash],
    ['SRAM', board.memory.sram],
    ['EEPROM', board.memory.eeprom],
  ]
  const usage = new Map<string, string[]>()
  for (const c of circuit.connections) {
    const link = asModuleBoardLink(c)
    if (link) {
      if (link.boardInstanceId !== instance.instanceId) continue
      usage.set(link.pinId, [...(usage.get(link.pinId) ?? []), describeEndpoint(moduleEndpoint(link.instanceId, link.modulePinId), circuit)])
      continue
    }
    // 보드 간 연결
    for (const [mine, other] of [[c.from, c.to], [c.to, c.from]] as const)
      if (mine.kind === 'board' && mine.boardInstanceId === instance.instanceId && other.kind === 'board')
        usage.set(mine.pinId, [...(usage.get(mine.pinId) ?? []), describeEndpoint(other, circuit)])
  }
  const hosted = circuit.placed.filter((p) => p.hostBoardId === instance.instanceId)
  const links = circuit.links.filter((l) => l.a.boardInstanceId === instance.instanceId || l.b.boardInstanceId === instance.instanceId)
  const used = board.pins.filter((p) => usage.has(p.id))
  const freeGpio = board.pins.filter((p) => isGpio(p) && !usage.has(p.id)).length
  return (
    <>
      <div className="prop-hero">
        <div className="prop-hero__board-icon" aria-hidden="true">
          ⌁
        </div>
        <div>
          <div className="prop-hero__title" data-testid="prop-title">
            {board.name}
          </div>
          <span className="tag">{multi ? `메인 보드 · ${instance.label}` : '메인 보드'}</span>
          {board.logicVoltage < 5 && (
            <>
              {' '}
              <span className="badge badge--pending" data-testid="logic-voltage-badge">
                {board.logicVoltage} V 로직 · 5 V 신호 직접 연결 금지
              </span>
            </>
          )}
        </div>
      </div>
      <section className="prop-section">
        <h3>기본 사양</h3>
        <dl className="kv">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      {restricted.length > 0 && (
        <section className="prop-section" data-testid="pin-restrictions">
          <h3>핀 제약</h3>
          <ul className="restriction-list">
            {restricted.map((p) => (
              <li key={p.id}>
                <div>
                  <strong className="mono">{p.label}</strong>
                  {p.label !== p.id && <span className="muted mono"> {p.id}</span>}{' '}
                  {p.restrictions!.map((r) => (
                    <span key={r.kind} className={`restriction-tag restriction-tag--${r.kind}`}>
                      {RESTRICTION_LABELS[r.kind]}
                    </span>
                  ))}
                </div>
                <ul className="note-list">
                  {p.restrictions!.map((r) => (
                    <li key={r.kind}>{r.description}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}
      {board.reservedPins && board.reservedPins.length > 0 && (
        <section className="prop-section" data-testid="reserved-pins">
          <h3>사용할 수 없는 칩 핀</h3>
          <ul className="bus-list">
            {board.reservedPins.map((r) => (
              <li key={r.id}>
                <strong className="mono">{r.id}</strong> <span className="muted">({r.label})</span> — {r.reason}
              </li>
            ))}
          </ul>
        </section>
      )}
      {board.supplyPins && (
        <section className="prop-section">
          <h3>부품 전원 공급 핀</h3>
          <ul className="bus-list">
            {supplyPinsOf(board).map((sp) => (
              <li key={sp.pinId}>
                <strong className="mono">{sp.pinId}</strong> {sp.voltage} V
                {sp.note && <span className="muted"> — {sp.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="prop-section">
        <h3>핀 사용 현황</h3>
        <p className="muted small">사용 중 {used.length}개 · 남은 GPIO {freeGpio}개</p>
        {used.length > 0 && (
          <ul className="bus-list">
            {used.map((p) => (
              <li key={p.id}>
                <strong className="mono">{p.id}</strong> <span className="muted">{usage.get(p.id)!.join(', ')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="prop-section">
        <h3>전원 · 전기적 사양</h3>
        <ElectricalList specs={board.electrical} />
      </section>
      <section className="prop-section">
        <details className="pin-details" data-testid="board-pin-list">
          <summary>전체 핀 구성 ({board.pins.length}개)</summary>
          <table className="pin-table">
            <thead>
              <tr>
                <th>핀</th>
                <th>기능</th>
                <th>비고</th>
              </tr>
            </thead>
            <tbody>
              {board.pins.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong className="mono">{p.label}</strong>
                    {p.label !== p.id && <div className="muted mono small">{p.id}</div>}
                  </td>
                  <td>{p.capabilities.length ? p.capabilities.map((c) => CAPABILITY_LABELS[c]).join(', ') : '—'}</td>
                  <td className="small">
                    {[p.note, ...(p.restrictions ?? []).map((r) => `⚠ ${RESTRICTION_LABELS[r.kind]}`)].filter(Boolean).join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>
      <section className="prop-section">
        <h3>통신 핀</h3>
        <ul className="bus-list">
          {board.buses.map((bus) => (
            <li key={bus.name}>
              <span className="tag">{bus.kind}</span> <strong>{bus.name}</strong>{' '}
              <span className="muted">{bus.pins.map((p) => `${p.role} ${p.pinId}`).join(' · ')}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="prop-section">
        <h3>참고</h3>
        <ul className="note-list">
          {board.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        <a className="source-link" href={board.sourceUrl} target="_blank" rel="noreferrer">
          공식 문서 보기 ↗
        </a>
      </section>
      {multi && (
        <section className="prop-section">
          <h3>이 보드가 제어하는 부품 · 통신</h3>
          <p className="small">
            부품 {hosted.length}개{hosted.length ? `: ${hosted.map((p) => p.label).join(', ')}` : ''}
          </p>
          {links.length > 0 && (
            <ul className="bus-list">
              {links.map((l) => (
                <li key={l.id}>
                  <span className="tag">{l.protocol}</span> {boardLabel(circuit, l.a.boardInstanceId)} ↔ {boardLabel(circuit, l.b.boardInstanceId)}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {multi && (
        <div className="prop-actions">
          <button type="button" className="button button--danger" onClick={() => onRemoveBoard(instance.instanceId)} data-testid="remove-board">
            이 보드 삭제
          </button>
          <span className="muted small">이 보드의 전선과 통신 연결이 함께 삭제됩니다.</span>
        </div>
      )}
    </>
  )
}

function ModuleProperties({
  item,
  circuit,
  issues,
  resistors,
  onRemove,
  onSetParam,
  onSetHostBoard,
  onSelect,
}: {
  item: PlacedModule
  circuit: Circuit
  issues: Issue[]
  resistors: SeriesResistorResult[]
  onRemove: (instanceId: string) => void
  onSetParam: PropertyPanelProps['onSetParam']
  onSetHostBoard: PropertyPanelProps['onSetHostBoard']
  onSelect: (selection: Selection) => void
}) {
  const { connections } = circuit
  const multi = circuit.boards.length > 1
  const module = getModule(item.moduleId)
  const ownIssues = issues.filter((i) => i.instanceId === item.instanceId)
  const resistor = resistors.find((r) => r.instanceId === item.instanceId)
  const required = requiredPins(connections, item.instanceId, module)
  return (
    <>
      <div className="prop-hero">
        <img className="prop-hero__icon" src={assetUrl(module.icon)} alt="" />
        <div>
          <div className="prop-hero__title" data-testid="prop-title">
            {item.label}
          </div>
          <span className="muted">{module.name}</span> <span className="tag">{CATEGORY_LABELS[module.category]}</span>
        </div>
      </div>

      {ownIssues.length > 0 && (
        <section className="prop-section">
          <h3>검사 결과</h3>
          <IssueList issues={ownIssues} onSelect={onSelect} />
        </section>
      )}

      <section className="prop-section">
        <h3>기본 정보</h3>
        <dl className="kv">
          <div>
            <dt>부품 ID</dt>
            <dd className="mono">{module.id}</dd>
          </div>
          <div>
            <dt>인스턴스 ID</dt>
            <dd className="mono" data-testid="prop-instance-id">
              {item.instanceId}
            </dd>
          </div>
          <div>
            <dt>위치 (x, y)</dt>
            <dd className="mono">
              {item.x}, {item.y}
            </dd>
          </div>
          {module.library && (
            <div>
              <dt>라이브러리</dt>
              <dd className="mono">
                {module.library}
                {module.libraryByCore?.['arduino-esp32'] ? ` (ESP32: ${module.libraryByCore['arduino-esp32']})` : ''}
              </dd>
            </div>
          )}
        </dl>
        {multi && (
          <label className="param-field">
            <span>제어 보드 (자동 핀 배정·코드 생성 대상)</span>
            <select value={item.hostBoardId} onChange={(e) => onSetHostBoard(item.instanceId, e.target.value)} data-testid="host-board">
              {circuit.boards.map((b) => (
                <option key={b.instanceId} value={b.instanceId}>
                  {b.label} · {findBoard(b.boardId)?.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="prop-desc">{module.description}</p>
      </section>

      {module.parameters && module.parameters.length > 0 && (
        <section className="prop-section">
          <h3>설정</h3>
          {module.parameters.map((param) => (
            <label key={param.id} className="param-field">
              <span>{param.label}</span>
              <select
                value={item.params[param.id] ?? param.defaultValue}
                onChange={(e) => onSetParam(item.instanceId, param.id, e.target.value)}
                data-testid={`param-${param.id}`}
              >
                {param.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {param.note && <span className="muted small">{param.note}</span>}
            </label>
          ))}
        </section>
      )}

      {resistor && (
        <section className="prop-section">
          <h3>직렬 저항 (자동 선정)</h3>
          <ResistorSummary result={resistor} />
        </section>
      )}

      <section className="prop-section">
        <h3>핀 ({module.pins.length}개)</h3>
        <table className="pin-table">
          <thead>
            <tr>
              <th>핀</th>
              <th>역할</th>
              <th>필요 기능</th>
              <th>연결</th>
            </tr>
          </thead>
          <tbody>
            {module.pins.map((pin) => {
              const endpoint = { kind: 'module' as const, instanceId: item.instanceId, pinId: pin.id }
              const boardPin = boardPinFor(connections, item.instanceId, pin.id)
              const other = connections.find((c) => touches(c, endpoint))
              let cell = <span className="badge badge--pending">미연결</span>
              if (!required.includes(pin) && !other) cell = <span className="muted small">불필요</span>
              if (boardPin)
                cell = (
                  <strong className="mono">
                    {multi ? `${boardLabel(circuit, boardPin.boardInstanceId)} ` : ''}
                    {boardPin.pinId}
                  </strong>
                )
              else if (other) {
                const far = [other.from, other.to].find((e) => e.kind !== 'module' || e.instanceId !== item.instanceId)!
                cell = <span className="small">{describeEndpoint(far, circuit)}</span>
              }
              return (
                <tr key={pin.id} title={pin.description}>
                  <td>{pin.name}</td>
                  <td>{ROLE_LABELS[pin.role]}</td>
                  <td>{pin.requires.length ? pin.requires.map((c) => CAPABILITY_LABELS[c]).join(', ') : '—'}</td>
                  <td data-testid={`pin-assign-${pin.id}`}>{cell}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      <section className="prop-section">
        <h3>전압 · 전기적 정보</h3>
        <ElectricalList specs={module.electrical} />
      </section>

      {module.notes.length > 0 && (
        <section className="prop-section">
          <h3>참고</h3>
          <ul className="note-list">
            {module.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="prop-actions">
        <button type="button" className="button button--danger" onClick={() => onRemove(item.instanceId)}>
          이 부품 삭제
        </button>
        <span className="muted small">단축키: Delete</span>
      </div>
    </>
  )
}

function BreadboardProperties({
  circuit,
  routing,
  onExport,
  onReset,
}: {
  circuit: Circuit
  routing: BreadboardRouting
  onExport: PropertyPanelProps['onExportBreadboard']
  onReset: () => void
}) {
  const check = verifyRouting(routing, circuit)
  const manual = routing.leads.some((l) => l.pinned)
  const used = routing.leads.length > 0
  const rails = Object.entries(routing.rails)
  return (
    <>
      <div className="prop-hero">
        <div className="prop-hero__board-icon" aria-hidden="true">
          ▦
        </div>
        <div>
          <div className="prop-hero__title" data-testid="prop-title">
            브레드보드
          </div>
          <span className="tag">830홀 · 63열</span>
        </div>
      </div>
      {used ? (
        <section className="prop-section" data-testid="breadboard-properties">
          <p>
            <span className={`badge ${check.ok ? 'badge--ok' : 'badge--pending'}`} data-testid="breadboard-check">
              {check.ok ? '배선도와 연결 일치' : `연결 불일치 ${check.problems.length}건`}
            </span>
          </p>
          <p className="muted small">
            전선 {routing.leads.length}개 · 점퍼 {routing.jumpers.length}개 · 저항 {routing.resistors.length}개 · {manual ? '직접 옮긴 배치' : '자동 배치'}
          </p>
          <p className="muted small">
            배선도에서 구멍에 꽂힌 전선 끝을 끌어 다른 구멍에 놓으면 옮겨집니다. 같은 줄의 다른 신호와 단락되는 자리에는 놓을 수 없고, 줄이 떨어지면
            점퍼를 자동으로 넣습니다.
          </p>
          {[...check.problems, ...routing.warnings].length > 0 && (
            <ul className="note-list">
              {[...check.problems, ...routing.warnings].map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {rails.length > 0 && (
            <>
              <h3>전원 레일</h3>
              <dl className="kv">
                {rails.map(([rail, net]) => (
                  <div key={rail}>
                    <dt>{holeName({ kind: 'rail', rail: rail as keyof BreadboardRouting['rails'], col: 1 })}</dt>
                    <dd>{net!.label}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
          <h3>구멍별 배선표</h3>
          <table className="pin-table" data-testid="breadboard-table">
            <thead>
              <tr>
                <th>구멍</th>
                <th>연결</th>
              </tr>
            </thead>
            <tbody>
              {routing.leads.map((l) => (
                <tr key={l.key}>
                  <td className="mono">
                    {holeLabel(l.hole)}
                  </td>
                  <td>{leadLabel(l, circuit)}</td>
                </tr>
              ))}
              {routing.jumpers.map((j, i) => (
                <tr key={i}>
                  <td className="mono">
                    {holeLabel(j.from)} ↔ {holeLabel(j.to)}
                  </td>
                  <td>점퍼 ({j.net})</td>
                </tr>
              ))}
              {routing.resistors.map((r) => (
                <tr key={`${r.instanceId}:${r.pinId}`}>
                  <td className="mono">
                    {holeLabel(r.legs[0])} ↔ {holeLabel(r.legs[1])}
                  </td>
                  <td>직렬 저항 {r.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="prop-actions">
            <button type="button" className="button button--small" onClick={onReset} disabled={!manual} data-testid="breadboard-reset">
              자동 배치로 되돌리기
            </button>
            <button type="button" className="button button--small" onClick={() => onExport('svg')}>
              SVG 저장
            </button>
            <button type="button" className="button button--small" onClick={() => onExport('png')}>
              PNG 저장
            </button>
          </div>
        </section>
      ) : (
        <section className="prop-section">
          <p className="muted small">아직 브레드보드를 거치는 전선이 없습니다. 위쪽에서 [브레드보드 경유]를 고른 뒤 핀을 끌어 연결하거나 [자동 핀 배정]을 누르세요.</p>
        </section>
      )}
      <section className="prop-section">
        <h3>참고</h3>
        <ul className="note-list">
          <li>구멍 위치는 연결에서 자동으로 계산합니다. 전선을 바꾸면 배치도 함께 바뀝니다.</li>
          <li>접점 허용 전류는 약 1 A 입니다. 모터 전원처럼 큰 전류는 보드 직결로 연결하세요.</li>
          <li>레일이 가운데에서 끊어진 제품은 점퍼로 이으세요.</li>
        </ul>
      </section>
    </>
  )
}

/** 전선의 보드 쪽 끝을 다른 보드 핀으로 옮기는 선택 상자 */
function BoardPinPicker({
  circuit,
  end,
  other,
  testId,
  onPick,
}: {
  circuit: Circuit
  end: Extract<Endpoint, { kind: 'board' }>
  other: Endpoint
  testId: string
  onPick: (to: Endpoint) => void
}) {
  const board = boardDefOf(circuit, end.boardInstanceId)
  if (!board) return null
  const peer = other.kind === 'module' ? resolveModulePin(circuit.placed, other) : null
  const ok = new Set(peer ? compatiblePins(board, peer.module, peer.pin, peer.placed) : board.pins.map((p) => p.id))
  const pins = [...board.pins].sort((a, b) => Number(ok.has(b.id)) - Number(ok.has(a.id)))
  return (
    <label className="field prop-pin-picker">
      <span>{circuit.boards.length > 1 ? `${boardLabel(circuit, end.boardInstanceId)} 핀 바꾸기` : '보드 핀 바꾸기'}</span>
      <select
        value={end.pinId}
        data-testid={testId}
        onChange={(e) => onPick({ kind: 'board', boardInstanceId: end.boardInstanceId, pinId: e.target.value })}
      >
        {pins.map((p) => (
          <option key={p.id} value={p.id}>
            {pinDisplayName(p)}
            {ok.has(p.id) ? '' : ' (맞지 않음)'}
          </option>
        ))}
      </select>
    </label>
  )
}

function ConnectionProperties({
  connection,
  circuit,
  issues,
  resistors,
  onRemove,
  onSelect,
  onSetRoute,
  onRetarget,
}: {
  connection: Connection
  circuit: Circuit
  issues: Issue[]
  resistors: SeriesResistorResult[]
  onRemove: (connectionId: string) => void
  onSelect: (selection: Selection) => void
  onSetRoute: PropertyPanelProps['onSetRoute']
  onRetarget: PropertyPanelProps['onRetarget']
}) {
  const ownIssues = issues.filter((i) => i.connectionId === connection.id)
  const link = connection.linkId ? circuit.links.find((l) => l.id === connection.linkId) : undefined
  const resistor = resistors.find((r) =>
    [connection.from, connection.to].some((e) => e.kind === 'module' && e.instanceId === r.instanceId && e.pinId === r.pinId),
  )
  return (
    <>
      <div className="prop-hero">
        <div className="prop-hero__board-icon prop-hero__wire-icon" aria-hidden="true">
          〰
        </div>
        <div>
          <div className="prop-hero__title" data-testid="prop-title">
            전선
          </div>
          <span className="tag">{link ? `${link.protocol} 통신` : connection.auto ? '자동 배정' : '수동 연결'}</span>
        </div>
      </div>
      <section className="prop-section">
        <h3>연결</h3>
        <dl className="kv">
          <div>
            <dt>시작</dt>
            <dd>{describeEndpoint(connection.from, circuit)}</dd>
          </div>
          <div>
            <dt>끝</dt>
            <dd>{describeEndpoint(connection.to, circuit)}</dd>
          </div>
          <div>
            <dt>연결 ID</dt>
            <dd className="mono">{connection.id}</dd>
          </div>
          {link && (
            <div>
              <dt>통신</dt>
              <dd>
                {link.protocol} · {boardLabel(circuit, link.a.boardInstanceId)}({link.a.bus}) ↔ {boardLabel(circuit, link.b.boardInstanceId)}({link.b.bus})
              </dd>
            </div>
          )}
        </dl>
        {!link &&
          ([connection.from, connection.to] as Endpoint[]).map((end, i) =>
            end.kind === 'board' ? (
              <BoardPinPicker
                key={i}
                circuit={circuit}
                end={end}
                other={i === 0 ? connection.to : connection.from}
                testId={i === 0 ? 'wire-pin-from' : 'wire-pin-to'}
                onPick={(to) => onRetarget([connection.id], end, to)}
              />
            ) : null,
          )}
        <div className="segmented prop-route" role="group" aria-label="이 전선의 경로">
          <button type="button" aria-pressed={connection.via !== 'breadboard'} onClick={() => onSetRoute(connection.id, 'direct')} data-testid="wire-direct">
            보드 직결
          </button>
          <button type="button" aria-pressed={connection.via === 'breadboard'} onClick={() => onSetRoute(connection.id, 'breadboard')} data-testid="wire-breadboard">
            브레드보드 경유
          </button>
        </div>
      </section>
      {resistor && (
        <section className="prop-section">
          <h3>직렬 저항</h3>
          <ResistorSummary result={resistor} />
        </section>
      )}
      <section className="prop-section">
        <h3>검사 결과</h3>
        {ownIssues.length ? <IssueList issues={ownIssues} onSelect={onSelect} /> : <p className="muted small">이 연결에 대한 문제가 없습니다.</p>}
      </section>
      <div className="prop-actions">
        <button type="button" className="button button--danger" onClick={() => onRemove(connection.id)}>
          이 연결 삭제
        </button>
        <span className="muted small">단축키: Delete</span>
      </div>
    </>
  )
}

export function PropertyPanel(props: PropertyPanelProps) {
  const { board, circuit, selection, issues, resistors, pinRows, tab, onTabChange, onSelect } = props
  const { placed, connections } = circuit
  const selectedBoard =
    selection.kind === 'board' ? circuit.boards.find((b) => b.instanceId === selection.boardInstanceId) : undefined
  const selectedBoardDef = selectedBoard && findBoard(selectedBoard.boardId)
  const selectedModule =
    selection.kind === 'module' ? placed.find((p) => p.instanceId === selection.instanceId) : undefined
  const selectedConnection =
    selection.kind === 'connection' ? connections.find((c) => c.id === selection.connectionId) : undefined
  const counts = countIssues(issues)

  const tabs: { id: PanelTab; label: string; badge?: number }[] = [
    { id: 'properties', label: '속성' },
    { id: 'validation', label: '검사', badge: counts.error + counts.warning },
    { id: 'pins', label: '핀 배정표' },
    { id: 'power', label: '전원' },
  ]

  return (
    <aside className="panel property-panel" aria-label="속성 패널">
      <div className="panel-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className="panel-tab"
            onClick={() => onTabChange(t.id)}
            data-testid={`tab-${t.id}`}
          >
            {t.label}
            {t.badge ? (
              <span className={`panel-tab__badge${counts.error ? ' is-error' : ''}`}>{t.badge}</span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="property-panel__body" data-testid="property-panel">
        {tab === 'validation' && <ValidationPanel issues={issues} placedCount={placed.length} onSelect={onSelect} />}
        {tab === 'pins' && (
          <PinTable rows={pinRows} boardName={circuit.boards.length > 1 ? `보드 ${circuit.boards.length}개` : board.name} multiBoard={circuit.boards.length > 1} onSelect={onSelect} />
        )}
        {tab === 'power' && (
          <PowerPanel
            report={props.power}
            onApply={props.onApplySupply}
            merges={props.merges}
            onMerge={props.onMerge}
            supplies={placedSupplies(circuit, props.power)}
            onSetSupply={(instanceId, supplyId) => props.onSetParam(instanceId, SUPPLY_PARAM, supplyId)}
            onLocate={(instanceId) => onSelect({ kind: 'module', instanceId })}
          />
        )}
        {tab === 'properties' && (
          <>
            {selection.kind === 'breadboard' && <BreadboardProperties circuit={circuit} routing={props.routing} onExport={props.onExportBreadboard} onReset={props.onResetBreadboard} />}
            {selectedBoard && selectedBoardDef && (
              <BoardProperties board={selectedBoardDef} instance={selectedBoard} circuit={circuit} onRemoveBoard={props.onRemoveBoard} />
            )}
            {selectedModule && (
              <ModuleProperties
                item={selectedModule}
                circuit={circuit}
                issues={issues}
                resistors={resistors}
                onRemove={props.onRemove}
                onSetParam={props.onSetParam}
                onSetHostBoard={props.onSetHostBoard}
                onSelect={onSelect}
              />
            )}
            {selectedModule && <ModuleHookups item={selectedModule} circuit={circuit} props={props} />}
            {selectedConnection && (
              <ConnectionProperties
                connection={selectedConnection}
                circuit={circuit}
                issues={issues}
                resistors={resistors}
                onRemove={props.onRemoveConnection}
                onSelect={onSelect}
                onSetRoute={props.onSetRoute}
                onRetarget={props.onRetarget}
              />
            )}
            {selection.kind !== 'breadboard' && !selectedBoard && !selectedModule && !selectedConnection && (
              <div className="property-panel__empty" data-testid="prop-empty">
                <strong>선택된 항목이 없습니다</strong>
                <p>작업 공간에서 부품, 전선, 메인 보드 또는 브레드보드를 클릭하면 이곳에 상세 정보가 표시됩니다.</p>
                <p className="muted small">
                  현재 보드: <strong>{circuit.boards.length > 1 ? `${circuit.boards.length}개 (${board.name} 외)` : board.name}</strong>
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
