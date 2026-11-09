import type { Module, ModuleCategory } from '../types'

export type CategoryFilter = ModuleCategory | 'all'

/** 검색 비교를 위해 대소문자·공백·특수 표기(I²C → i2c)를 정규화한다. */
export function normalizeSearchText(text: string): string {
  return text.toLowerCase().replace(/²/g, '2').replace(/[\s\-_]/g, '')
}

export function filterModules(modules: Module[], query: string, category: CategoryFilter): Module[] {
  const q = normalizeSearchText(query.trim())
  return modules.filter((m) => {
    if (category !== 'all' && m.category !== category) return false
    if (!q) return true
    const haystack = [m.name, m.nameEn, m.id, m.description, ...m.tags].map(normalizeSearchText)
    return haystack.some((text) => text.includes(q))
  })
}
