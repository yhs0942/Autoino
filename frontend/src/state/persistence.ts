import { parseProjectFile, toProjectFile, type ProjectData } from '../engine/project'

// 브라우저 자동 저장 (localStorage). 저장소를 쓸 수 없는 환경에서도 앱은 정상 동작해야 한다.

const STORAGE_KEY = 'autoino:autosave'

export function loadAutosave(): ProjectData | null {
  try {
    const text = localStorage.getItem(STORAGE_KEY)
    return text ? parseProjectFile(text) : null
  } catch {
    return null
  }
}

/** 브라우저 저장소를 쓸 수 있는지 확인한다 (사생활 보호 모드 등에서는 실패할 수 있음). */
export function canAutosave(): boolean {
  try {
    const probe = `${STORAGE_KEY}:probe`
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}

export function saveAutosave(data: ProjectData): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toProjectFile(data)))
    return true
  } catch {
    return false
  }
}
