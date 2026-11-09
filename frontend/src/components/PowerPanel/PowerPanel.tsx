import { SUPPLY_KIND_LABELS } from '../../data/supplies'
import { formatCurrent, type PowerNeed, type PowerReport, type PowerSource, type SupplyExample } from '../../engine/power'
import './PowerPanel.css'

interface PowerPanelProps {
  report: PowerReport
  /** 예시를 회로에 적용한다: 외부 전원을 놓고 need.pins 에 연결 */
  onApply: (need: PowerNeed, example: SupplyExample) => void
}

const STATUS_LABELS: Record<PowerSource['status'], string> = { ok: '여유 있음', peak: '순간 부족', overload: '용량 초과', unused: '연결 없음' }
const STATUS_BADGES: Record<PowerSource['status'], string> = { ok: 'badge--ok', peak: 'badge--pending', overload: 'badge--danger', unused: '' }

function voltageRange(need: PowerNeed): string {
  return need.minVoltage === need.maxVoltage ? `${need.minVoltage} V` : `${need.minVoltage}–${need.maxVoltage} V`
}

function ExampleRow({ need, example, onApply }: { need: PowerNeed; example: SupplyExample; onApply: PowerPanelProps['onApply'] }) {
  return (
    <li className="power-example" data-testid={`example-${example.id}`}>
      <div className="power-example__main">
        <div className="power-example__title">
          <span className={`badge ${example.level === 'recommended' ? 'badge--ok' : 'badge--pending'}`}>{example.level === 'recommended' ? '권장' : '최소'}</span>
          <strong>{example.name}</strong>
        </div>
        <div className="power-example__meta">
          {SUPPLY_KIND_LABELS[example.kind]} · {example.voltage} V · 최대 {formatCurrent(example.maxCurrentMa)}
          {example.runtimeHours !== undefined && ` · 약 ${example.runtimeHours}시간`}
        </div>
        <p className="power-example__note">{example.note}</p>
      </div>
      <button
        type="button"
        className="button button--small"
        disabled={need.pins.length === 0}
        title={need.pins.length ? '외부 전원을 놓고 이 부품들의 전원에 연결합니다' : '모터 드라이버를 먼저 연결하세요'}
        onClick={() => onApply(need, example)}
        data-testid={`apply-${example.id}`}
      >
        적용
      </button>
    </li>
  )
}

function NeedCard({ need, index, onApply }: { need: PowerNeed; index: number; onApply: PowerPanelProps['onApply'] }) {
  return (
    <section className="power-need" data-testid={`need-${index + 1}`}>
      <header className="power-need__head">
        <strong>전원 {index + 1}</strong>
        {need.servedBy ? <span className="badge badge--ok">{need.servedBy} 연결됨</span> : <span className="badge badge--pending">전원 필요</span>}
      </header>
      <div className="power-need__figures">
        <div>
          <span className="power-need__label">권장 전압</span>
          <span className="power-need__value" data-testid="need-voltage">
            {need.targetVoltage} V
          </span>
          <span className="power-need__sub">허용 {voltageRange(need)}</span>
        </div>
        <div>
          <span className="power-need__label">권장 전류</span>
          <span className="power-need__value" data-testid="need-current">
            {formatCurrent(need.recommendedMa)}
          </span>
          <span className="power-need__sub">최소 {formatCurrent(need.minimumMa)}</span>
        </div>
      </div>
      {need.conflict && <p className="callout callout--warning">드라이버와 모터의 전압 범위가 겹치지 않습니다. 모터에 맞는 드라이버를 고르세요.</p>}
      <details className="power-need__consumers">
        <summary>쓰는 부품 {need.consumers.length}개 · 평상시 {formatCurrent(need.typicalMa)} / 최대 {formatCurrent(need.peakMa)}</summary>
        <ul>
          {need.consumers.map((c) => (
            <li key={c.instanceId}>
              <span>{c.label}</span>
              <span className="muted">
                {formatCurrent(c.typicalMa)} / {formatCurrent(c.peakMa)}
              </span>
            </li>
          ))}
        </ul>
      </details>
      {need.pins.length === 0 && <p className="muted small">모터 드라이버를 추가해 연결하면 전원을 바로 적용할 수 있습니다.</p>}
      <h4 className="power-need__subhead">전원 예시</h4>
      {need.examples.length ? (
        <ul className="power-examples">
          {need.examples.map((e) => (
            <ExampleRow key={e.id} need={need} example={e} onApply={onApply} />
          ))}
        </ul>
      ) : (
        <p className="callout callout--warning">
          이 전압·전류에 맞는 예시가 없습니다. {voltageRange(need)}, {formatCurrent(need.minimumMa)} 이상을 낼 수 있는 전원을 찾거나 부품을 나눠 전원을 따로 쓰세요.
        </p>
      )}
    </section>
  )
}

function SourceRow({ source }: { source: PowerSource }) {
  return (
    <tr className={source.status === 'overload' ? 'is-bad' : undefined}>
      <td>
        <strong>{source.label}</strong>
        <div className="muted small">{source.voltage} V</div>
      </td>
      <td>
        {formatCurrent(source.typicalMa)}
        <div className="muted small">최대 {formatCurrent(source.peakMa)}</div>
      </td>
      <td>{source.limitMa === null ? '—' : formatCurrent(source.limitMa)}</td>
      <td>{STATUS_BADGES[source.status] ? <span className={`badge ${STATUS_BADGES[source.status]}`}>{STATUS_LABELS[source.status]}</span> : <span className="muted small">{STATUS_LABELS[source.status]}</span>}</td>
    </tr>
  )
}

/** 필요한 외부 전원의 전압·전류, 맞는 전원 예시, 현재 전원 상태를 보여 준다 */
export function PowerPanel({ report, onApply }: PowerPanelProps) {
  return (
    <div className="power-panel" data-testid="power-panel">
      <h3 className="small-heading">필요한 외부 전원</h3>
      {report.needs.length ? (
        report.needs.map((need, i) => <NeedCard key={need.id} need={need} index={i} onApply={onApply} />)
      ) : (
        <p className="callout callout--ok" data-testid="power-none">
          모터나 서보처럼 외부 전원이 필요한 부품이 없습니다. USB 전원으로 충분합니다.
        </p>
      )}

      <h3 className="small-heading">현재 전원 상태</h3>
      {report.sources.length ? (
        <table className="pin-table power-sources" data-testid="power-sources">
          <thead>
            <tr>
              <th>전원</th>
              <th>사용 전류</th>
              <th>용량</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {report.sources.map((s) => (
              <SourceRow key={s.key} source={s} />
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">연결된 전원이 없습니다.</p>
      )}
      {report.sources.some((s) => s.unknown.length) && (
        <p className="muted small">소비 전류를 모르는 부품: {[...new Set(report.sources.flatMap((s) => s.unknown))].join(', ')}</p>
      )}

      <h3 className="small-heading">외부 전원 연결 요령</h3>
      <ul className="note-list">
        <li>전원 + 는 모터 드라이버의 모터 전원 단자나 서보 전원에, − 는 그 부품의 GND 에 연결합니다.</li>
        <li>전원 − 와 보드 GND 는 반드시 서로 연결합니다. 공통 GND 가 없으면 제어 신호가 통하지 않습니다.</li>
        <li>모터 전류는 보드나 브레드보드를 거치지 않게 전원에서 드라이버로 바로 연결합니다.</li>
        <li>보드도 같은 전원으로 돌리려면 + 를 VIN 에 연결합니다 (Uno 7–12 V).</li>
      </ul>
      <p className="muted small">전류는 부품 데이터의 대표값으로 계산했습니다. 최소 전류는 평상시 전류의 1.25배, 권장 전류는 모든 부품이 동시에 기동·스톨할 때의 값입니다.</p>
    </div>
  )
}
