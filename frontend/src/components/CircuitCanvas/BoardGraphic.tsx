import type { PointerEvent as ReactPointerEvent } from 'react'
import { CAPABILITY_LABELS, RESTRICTION_LABELS } from '../../data/labels'
import type { Board, BoardPin } from '../../types'

interface BoardGraphicProps {
  board: Board
  /** 보드 인스턴스 ID (전선 끝점 키에 사용) */
  boardInstanceId: string
  /** 보드가 여러 개일 때 표시할 인스턴스 이름 */
  instanceLabel?: string
  selected: boolean
  /** 연결된 보드 핀 ID */
  usedPins: Set<string>
  /** 전선을 끄는 중일 때 연결 가능한 핀 (null 이면 강조 없음) */
  compatiblePins: Set<string> | null
  /** 고른 부품에서 이어지는 보드 핀 (강조) */
  litPins?: Set<string>
  onSelect: () => void
  /** 보드 본체를 눌렀을 때 (선택 + 이동 시작) */
  onBodyPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPinPointerDown: (e: ReactPointerEvent, pinId: string) => void
  /** 핀 위에 포인터가 올라가거나(핀 ID) 벗어날 때(null) */
  onPinHover?: (pinId: string | null) => void
}

function pinTitle(pin: BoardPin): string {
  const caps = pin.capabilities.map((c) => CAPABILITY_LABELS[c]).join(', ')
  const restrictions = (pin.restrictions ?? []).map((r) => `⚠ ${RESTRICTION_LABELS[r.kind]}`).join(', ')
  return [pin.label !== pin.id ? `${pin.id} (${pin.label})` : pin.id, caps, pin.note, restrictions].filter(Boolean).join(' · ')
}

function hasKind(pin: BoardPin, kind: string) {
  return pin.restrictions?.some((r) => r.kind === kind) ?? false
}

/** 보드를 단순화된 PCB 형태로 그린다. 핀 개수와 기능은 보드 데이터에서 그대로 가져온다. */
export function BoardGraphic({
  board,
  boardInstanceId,
  instanceLabel,
  selected,
  usedPins,
  compatiblePins,
  litPins,
  onSelect,
  onBodyPointerDown,
  onPinPointerDown,
  onPinHover,
}: BoardGraphicProps) {
  const digital = board.pins.filter((p) => p.group === 'digital')
  const analog = board.pins.filter((p) => p.group === 'analog')
  const power = board.pins.filter((p) => p.group === 'power')

  const byId = new Map(board.pins.map((p) => [p.id, p]))
  const header = (pins: BoardPin[], label: string, dir: number) => (
    <div className="board-graphic__header">
      <span className="board-graphic__header-label">{label}</span>
      <div className="board-graphic__pins">
        {pins.map((pin) => {
          const classes = ['board-pin']
          // 실제 헤더(headers)가 정의된 보드는 모든 출력 핀이 PWM 이므로 ~ 표시를 생략한다.
          if (!board.headers && pin.capabilities.includes('pwm')) classes.push('board-pin--pwm')
          if (hasKind(pin, 'input-only')) classes.push('board-pin--input-only')
          if (hasKind(pin, 'strapping')) classes.push('board-pin--strapping')
          if (board.headers && (pin.group === 'power' || pin.group === 'control')) classes.push('board-pin--power')
          if (usedPins.has(pin.id)) classes.push('is-used')
          if (compatiblePins) classes.push(compatiblePins.has(pin.id) ? 'is-compatible' : 'is-incompatible')
          if (litPins?.has(pin.id)) classes.push('is-lit')
          return (
            <span
              key={pin.id}
              className={classes.join(' ')}
              title={pinTitle(pin)}
              data-pin-id={pin.id}
              data-endpoint={`board:${boardInstanceId}:${pin.id}`}
              data-dir={dir}
              onPointerDown={(e) => onPinPointerDown(e, pin.id)}
              onPointerEnter={() => onPinHover?.(pin.id)}
              onPointerLeave={() => onPinHover?.(null)}
            >
              <span className="board-pin__label">
                {!board.headers && pin.capabilities.includes('pwm') ? `~${pin.label}` : pin.label}
              </span>
            </span>
          )
        })}
      </div>
    </div>
  )

  return (
    <div
      className={`board-graphic${selected ? ' is-selected' : ''}`}
      style={{ width: board.footprint.width, minHeight: board.footprint.height }}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`메인 보드 ${instanceLabel ? `${instanceLabel} ` : ''}${board.name}`}
      data-testid="board-graphic"
      data-board-instance={boardInstanceId}
      onPointerDown={(e) => {
        e.stopPropagation()
        onBodyPointerDown(e)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      {instanceLabel && <span className="board-graphic__instance">{instanceLabel}</span>}
      {board.headers ? (
        // 실제 헤더 배열이 정의된 보드 (예: ESP32 DevKit V1)
        <>
          {board.headers
            .filter((h) => h.side === 'top')
            .map((h) => (
              <div key={h.label}>{header(h.pinIds.map((id) => byId.get(id)!), h.label, -1)}</div>
            ))}
          <div className="board-graphic__center">
            <div className="board-graphic__chip">{board.microcontroller.split(' ')[0]}</div>
            <div>
              <div className="board-graphic__name">{board.name}</div>
              <div className="board-graphic__legend">
                <span className="legend-swatch legend-swatch--input-only" /> 입력 전용
                <span className="legend-swatch legend-swatch--strapping" /> 스트래핑
                <span className="board-graphic__logic">{board.logicVoltage} V 로직</span>
              </div>
            </div>
          </div>
          {board.headers
            .filter((h) => h.side === 'bottom')
            .map((h) => (
              <div key={h.label}>{header(h.pinIds.map((id) => byId.get(id)!), h.label, 1)}</div>
            ))}
        </>
      ) : (
        <>
          {header(digital, 'DIGITAL', -1)}
          <div className="board-graphic__center">
            <div className="board-graphic__chip">{board.microcontroller}</div>
            <div className="board-graphic__name">{board.name}</div>
          </div>
          <div className="board-graphic__bottom">
            {header(power, 'POWER', 1)}
            {header(analog, 'ANALOG IN', 1)}
          </div>
        </>
      )}
    </div>
  )
}
