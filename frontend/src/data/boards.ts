import boardsJson from '@data/boards.json'
import type { Board } from '../types'
import { validateBoards } from './validate'

// 보드 정의는 저장소 루트의 data/boards.json 에 있다.
// 수치는 Arduino 공식 문서(docs.arduino.cc)의 기술 사양을 기준으로 한다.

export const BOARDS: Board[] = validateBoards(boardsJson)

export const DEFAULT_BOARD_ID = BOARDS[0].id

export function findBoard(id: string): Board | undefined {
  return BOARDS.find((b) => b.id === id)
}

export function getBoard(id: string): Board {
  const board = findBoard(id)
  if (!board) throw new Error(`알 수 없는 보드 ID: ${id}`)
  return board
}
