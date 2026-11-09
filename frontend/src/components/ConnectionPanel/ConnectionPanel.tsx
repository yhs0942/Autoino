import { useState } from 'react'
import { findBoard } from '../../data/boards'
import { linkBusOptions, type LinkRequest } from '../../engine/boardLinks'
import type { Board, BoardLink, BusProtocol, CommunicationBus, PlacedBoard } from '../../types'
import { Modal } from '../common/Modal'
import './ConnectionPanel.css'

interface ConnectionPanelProps {
  /** 버스 정보를 보여 줄 보드 (현재 선택된 보드) */
  board: Board
  boards: PlacedBoard[]
  links: BoardLink[]
  onCreate: (request: LinkRequest) => void
  onRemove: (linkId: string) => void
  onAddBoard: () => void
  onClose: () => void
}

const PROTOCOLS: { kind: CommunicationBus['kind']; title: string; summary: string }[] = [
  { kind: 'UART', title: 'UART (시리얼)', summary: 'TX/RX 두 선으로 1:1 통신. 보드 간 TX↔RX 를 교차 연결합니다.' },
  { kind: 'I2C', title: 'I²C', summary: 'SDA/SCL 두 선으로 여러 장치를 주소로 구분하여 연결합니다.' },
  { kind: 'SPI', title: 'SPI', summary: 'MOSI/MISO/SCK 와 장치별 SS 선을 사용하는 고속 통신입니다.' },
]

const ROLE_TEXT: Record<BusProtocol, [string, string]> = {
  UART: ['보드 A', '보드 B'],
  I2C: ['컨트롤러', '주변장치'],
  SPI: ['컨트롤러', '주변장치'],
}

function defOf(boards: PlacedBoard[], id: string): Board | undefined {
  const b = boards.find((x) => x.instanceId === id)
  return b && findBoard(b.boardId)
}

/** 연결 방식 창: 보드 간 UART · I²C · SPI 통신 연결을 만들고 관리한다. */
export function ConnectionPanel({ board, boards, links, onCreate, onRemove, onAddBoard, onClose }: ConnectionPanelProps) {
  const [protocol, setProtocol] = useState<BusProtocol>('UART')
  const [a, setA] = useState(boards[0]?.instanceId ?? '')
  const [b, setB] = useState(boards[1]?.instanceId ?? '')
  const [aBusChoice, setABus] = useState('')
  const [bBusChoice, setBBus] = useState('')
  const [address, setAddress] = useState('0x08')
  const [baud, setBaud] = useState(9600)

  const aOptions = (() => { const d = defOf(boards, a); return d ? linkBusOptions(d, protocol) : [] })()
  const bOptions = (() => { const d = defOf(boards, b); return d ? linkBusOptions(d, protocol) : [] })()
  // 선택한 버스가 현재 옵션에 없으면(보드·프로토콜 변경 후) 첫 번째 옵션을 쓴다
  const aBus = aOptions.some((o) => o.value === aBusChoice) ? aBusChoice : (aOptions[0]?.value ?? '')
  const bBus = bOptions.some((o) => o.value === bBusChoice) ? bBusChoice : (bOptions[0]?.value ?? '')
  const addressValid = /^0x[0-7][0-9a-f]$/i.test(address)
  const canCreate = a && b && a !== b && aBus && bBus && (protocol !== 'I2C' || addressValid)
  const label = (id: string) => boards.find((x) => x.instanceId === id)?.label ?? id
  const [roleA, roleB] = ROLE_TEXT[protocol]

  return (
    <Modal
      title="연결 방식 설정"
      onClose={onClose}
      footer={
        <button type="button" className="button" onClick={onClose}>
          닫기
        </button>
      }
    >
      <section className="link-form" data-testid="link-form">
        <h3 className="small-heading">보드 간 통신 연결</h3>
        {boards.length < 2 ? (
          <div className="callout callout--warning">
            보드 간 통신을 설정하려면 메인 보드가 두 개 이상 필요합니다.{' '}
            <button type="button" className="button button--small" onClick={onAddBoard} data-testid="link-add-board">
              보드 추가
            </button>
          </div>
        ) : (
          <>
            <div className="link-form__grid">
              <label>
                <span>방식</span>
                <select value={protocol} onChange={(e) => setProtocol(e.target.value as BusProtocol)} data-testid="link-protocol">
                  <option value="UART">UART</option>
                  <option value="I2C">I²C</option>
                  <option value="SPI">SPI</option>
                </select>
              </label>
              <label>
                <span>{roleA}</span>
                <select value={a} onChange={(e) => setA(e.target.value)} data-testid="link-a">
                  {boards.map((x) => (
                    <option key={x.instanceId} value={x.instanceId}>
                      {x.label} · {findBoard(x.boardId)?.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{roleA} 버스</span>
                <select value={aBus} onChange={(e) => setABus(e.target.value)} data-testid="link-a-bus">
                  {aOptions.length === 0 && <option value="">사용 가능한 버스 없음</option>}
                  {aOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{roleB}</span>
                <select value={b} onChange={(e) => setB(e.target.value)} data-testid="link-b">
                  {boards.map((x) => (
                    <option key={x.instanceId} value={x.instanceId}>
                      {x.label} · {findBoard(x.boardId)?.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{roleB} 버스</span>
                <select value={bBus} onChange={(e) => setBBus(e.target.value)} data-testid="link-b-bus">
                  {bOptions.length === 0 && <option value="">사용 가능한 버스 없음</option>}
                  {bOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              {protocol === 'I2C' && (
                <label>
                  <span>주변장치 주소</span>
                  <input value={address} onChange={(e) => setAddress(e.target.value)} aria-invalid={!addressValid} data-testid="link-address" />
                </label>
              )}
              {protocol === 'UART' && (
                <label>
                  <span>통신 속도 (baud)</span>
                  <select value={baud} onChange={(e) => setBaud(Number(e.target.value))}>
                    {[9600, 19200, 38400, 57600, 115200].map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {a === b && <p className="callout callout--warning">서로 다른 두 보드를 선택하세요.</p>}
            <p className="muted small">
              전선은 자동으로 만들어지며, 두 보드의 GND 가 아직 연결되어 있지 않으면 GND 전선도 추가됩니다. 5 V 와 3.3 V 보드를 연결하면 [검사]
              탭에 레벨 오류가 표시되고, [레벨 변환 자동 추가]로 레벨 시프터를 넣을 수 있습니다.
            </p>
            <button
              type="button"
              className="button button--primary"
              disabled={!canCreate}
              data-testid="link-create"
              onClick={() =>
                onCreate({ protocol, a, b, aBus, bBus, ...(protocol === 'I2C' ? { i2cAddress: address.toLowerCase() } : {}), ...(protocol === 'UART' ? { baud } : {}) })
              }
            >
              통신 연결 만들기
            </button>
          </>
        )}

        {links.length > 0 && (
          <ul className="link-list" data-testid="link-list">
            {links.map((l) => (
              <li key={l.id}>
                <div>
                  <strong>{l.protocol}</strong> {label(l.a.boardInstanceId)} ({l.a.bus}) ↔ {label(l.b.boardInstanceId)} ({l.b.bus})
                  <div className="muted small">
                    {l.pairs.map((p) => `${p.signal}: ${p.a}–${p.b}`).join(' · ')}
                    {l.i2cAddress ? ` · 주소 ${l.i2cAddress}` : ''}
                    {l.baud ? ` · ${l.baud} baud` : ''}
                  </div>
                </div>
                <button type="button" className="button button--small button--danger-outline" onClick={() => onRemove(l.id)}>
                  삭제
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <h3 className="small-heading">{board.name} 의 통신 핀</h3>
      <div className="protocol-list">
        {PROTOCOLS.map((proto) => {
          const buses = board.buses.filter((bus) => bus.kind === proto.kind)
          return (
            <section key={proto.kind} className="protocol-card" data-testid={`protocol-${proto.kind}`}>
              <header>
                <strong>{proto.title}</strong>
              </header>
              <p className="muted small">{proto.summary}</p>
              <ul>
                {buses.map((bus) => (
                  <li key={bus.name}>
                    <span className="mono">{bus.name}</span>: {bus.pins.map((p) => `${p.role} ${p.pinId}`).join(', ')}
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </Modal>
  )
}
