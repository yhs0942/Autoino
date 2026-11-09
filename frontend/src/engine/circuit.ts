import { findBoard } from '../data/boards'
import type { Board, BoardLink, BoardPin, Connection, PlacedBoard, PlacedModule, Point } from '../types'

// 회로 문서(보드 인스턴스·부품·전선·보드 간 통신)를 엔진 함수에 넘기기 위한 묶음

export interface Circuit {
  boards: PlacedBoard[]
  placed: PlacedModule[]
  connections: Connection[]
  links: BoardLink[]
  /** 배선도 위 브레드보드 위치 (부품 자동 배치가 피해 간다) */
  breadboard?: Point
}

export interface ResolvedBoardPin {
  instance: PlacedBoard
  board: Board
  /** 보드 정의에 없는 핀이면 undefined (보드 종류를 바꾼 직후 등) */
  pin: BoardPin | undefined
}

export function findBoardInstance(circuit: Circuit, boardInstanceId: string): PlacedBoard | undefined {
  return circuit.boards.find((b) => b.instanceId === boardInstanceId)
}

export function boardDefOf(circuit: Circuit, boardInstanceId: string): Board | undefined {
  const instance = findBoardInstance(circuit, boardInstanceId)
  return instance && findBoard(instance.boardId)
}

export function resolveBoardPin(circuit: Circuit, boardInstanceId: string, pinId: string): ResolvedBoardPin | null {
  const instance = findBoardInstance(circuit, boardInstanceId)
  const board = instance && findBoard(instance.boardId)
  if (!instance || !board) return null
  return { instance, board, pin: board.pins.find((p) => p.id === pinId) }
}

/** 부품을 제어하는 보드. 지정된 보드가 없으면 첫 번째 보드 */
export function hostBoardOf(circuit: Circuit, item: PlacedModule): PlacedBoard | undefined {
  return findBoardInstance(circuit, item.hostBoardId) ?? circuit.boards[0]
}

/** 메시지용 보드 이름: 보드가 하나면 "보드", 여러 개면 인스턴스 이름 */
export function boardLabel(circuit: Circuit, boardInstanceId: string): string {
  if (circuit.boards.length <= 1) return '보드'
  return findBoardInstance(circuit, boardInstanceId)?.label ?? boardInstanceId
}
