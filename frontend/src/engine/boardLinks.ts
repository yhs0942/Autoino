import type { Board, BoardLink, BoardLinkEnd, BusProtocol, Connection } from '../types'
import { pickFreeGpios } from './autoAssign'
import { boardDefOf, boardLabel, type Circuit } from './circuit'
import { boardEndpoint, touches } from './connections'
import { findBoardPin, groundPinsOf, isUsbSerialPin } from './electrical'
import { buildNetlist } from './netlist'

// 보드 간 통신 연결 (UART · I²C · SPI)
//
// - UART: 양쪽 TX↔RX 를 교차 연결한다. USB 시리얼과 공유되는 포트는 쓰지 않으며,
//         하드웨어 UART 가 USB 용 하나뿐인 AVR 보드(Uno, Nano)는 SoftwareSerial(빈 GPIO 2개)을 쓴다.
// - I²C : a 가 컨트롤러, b 가 주변장치(주소 지정). SDA–SDA, SCL–SCL.
// - SPI : a 가 컨트롤러, b 가 주변장치. MOSI–MOSI, MISO–MISO, SCK–SCK, SS–SS.
// - 공통 GND 가 없으면 GND 전선도 추가한다.

export const SOFTWARE_SERIAL = 'SoftwareSerial'

export interface LinkBusOption {
  value: string
  label: string
}

const ROLES: Record<BusProtocol, string[]> = {
  UART: ['RX', 'TX'],
  I2C: ['SDA', 'SCL'],
  SPI: ['MOSI', 'MISO', 'SCK', 'SS'],
}

/** 이 보드에서 해당 프로토콜로 쓸 수 있는 버스 목록 */
export function linkBusOptions(board: Board, protocol: BusProtocol): LinkBusOption[] {
  const options: LinkBusOption[] = board.buses
    .filter((b) => b.kind === protocol)
    .filter((b) => protocol !== 'UART' || !b.pins.some((p) => { const pin = findBoardPin(board, p.pinId); return pin && isUsbSerialPin(board, pin) }))
    .map((b) => ({ value: b.name, label: `${b.name} (${b.pins.map((p) => `${p.role} ${p.pinId}`).join(', ')})` }))
  if (protocol === 'UART' && board.core === 'arduino-avr' && options.length === 0)
    options.push({ value: SOFTWARE_SERIAL, label: 'SoftwareSerial (빈 디지털 핀 2개 자동 선택)' })
  return options
}

export interface LinkRequest {
  protocol: BusProtocol
  a: string
  b: string
  aBus: string
  bBus: string
  i2cAddress?: string
  baud?: number
}

export type LinkPlan =
  | { ok: true; link: BoardLink; connections: Connection[]; nextConnSeq: number }
  | { ok: false; error: string }

function resolveEnd(circuit: Circuit, boardInstanceId: string, protocol: BusProtocol, busName: string): BoardLinkEnd | string {
  const board = boardDefOf(circuit, boardInstanceId)
  if (!board) return '보드를 찾을 수 없습니다.'
  if (busName === SOFTWARE_SERIAL) {
    if (protocol !== 'UART' || board.core !== 'arduino-avr') return 'SoftwareSerial 은 AVR 보드의 UART 에서만 쓸 수 있습니다.'
    const free = pickFreeGpios(circuit, boardInstanceId, 2)
    if (free.length < 2) return `${boardLabel(circuit, boardInstanceId)}에 SoftwareSerial 용 빈 핀이 부족합니다.`
    return { boardInstanceId, bus: SOFTWARE_SERIAL, pins: { RX: free[0], TX: free[1] } }
  }
  const bus = board.buses.find((b) => b.kind === protocol && b.name === busName)
  if (!bus) return `${board.name}에 ${busName} 버스가 없습니다.`
  const pins: Record<string, string> = {}
  for (const role of ROLES[protocol]) {
    const p = bus.pins.find((x) => x.role === role)
    if (!p) return `${busName} 에 ${role} 핀 정보가 없습니다.`
    pins[role] = p.pinId
  }
  return { boardInstanceId, bus: bus.name, pins }
}

export function planBoardLink(circuit: Circuit, request: LinkRequest, linkId: string, nextConnSeq: number): LinkPlan {
  const { protocol } = request
  if (request.a === request.b) return { ok: false, error: '서로 다른 두 보드를 선택하세요.' }
  const a = resolveEnd(circuit, request.a, protocol, request.aBus)
  if (typeof a === 'string') return { ok: false, error: a }
  const b = resolveEnd(circuit, request.b, protocol, request.bBus)
  if (typeof b === 'string') return { ok: false, error: b }

  // UART·SPI 핀은 다른 신호와 공유할 수 없다 (I²C 는 버스 공유 가능)
  if (protocol !== 'I2C')
    for (const end of [a, b])
      for (const [role, pinId] of Object.entries(end.pins)) {
        if (protocol === 'SPI' && role !== 'SS') continue // SPI 데이터선은 여러 장치가 공유
        if (circuit.connections.some((c) => touches(c, boardEndpoint(end.boardInstanceId, pinId))))
          return { ok: false, error: `${boardLabel(circuit, end.boardInstanceId)} ${pinId} 가 이미 다른 연결에 사용 중입니다.` }
      }

  const pairs: BoardLink['pairs'] =
    protocol === 'UART'
      ? [
          { a: a.pins.TX, b: b.pins.RX, signal: 'TX→RX' },
          { a: a.pins.RX, b: b.pins.TX, signal: 'RX←TX' },
        ]
      : ROLES[protocol].map((role) => ({ a: a.pins[role], b: b.pins[role], signal: role }))

  const aBoard = boardDefOf(circuit, a.boardInstanceId)!
  const bBoard = boardDefOf(circuit, b.boardInstanceId)!
  const aGnd = groundPinsOf(aBoard)[0]
  const bGnd = groundPinsOf(bBoard)[0]
  const netlist = buildNetlist(circuit)
  const commonGround = netlist.netOf(`board:${a.boardInstanceId}:${aGnd}`) === netlist.netOf(`board:${b.boardInstanceId}:${bGnd}`)
  pairs.push({ a: aGnd, b: bGnd, signal: 'GND' })

  let seq = nextConnSeq
  const connections: Connection[] = pairs
    .filter((p) => p.signal !== 'GND' || !commonGround)
    .map((p) => ({
      id: `w${seq++}`,
      from: boardEndpoint(a.boardInstanceId, p.a),
      to: boardEndpoint(b.boardInstanceId, p.b),
      auto: true,
      linkId,
    }))

  const link: BoardLink = {
    id: linkId,
    protocol,
    a,
    b,
    pairs,
    ...(protocol === 'I2C' ? { i2cAddress: request.i2cAddress ?? '0x08' } : {}),
    ...(protocol === 'UART' ? { baud: request.baud ?? 9600 } : {}),
  }
  return { ok: true, link, connections, nextConnSeq: seq }
}
