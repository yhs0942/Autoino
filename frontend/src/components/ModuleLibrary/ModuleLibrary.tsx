import { useMemo, useState } from 'react'
import { CATEGORY_LABELS } from '../../data/modules'
import type { Module, ModuleCategory } from '../../types'
import { assetUrl } from '../../utils/assetUrl'
import { filterModules, type CategoryFilter } from '../../utils/moduleFilter'
import './ModuleLibrary.css'

export const MODULE_DRAG_TYPE = 'application/x-autoino-module'

interface ModuleLibraryProps {
  modules: Module[]
  onAdd: (moduleId: string) => void
}

export function ModuleLibrary({ modules, onAdd }: ModuleLibraryProps) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CategoryFilter>('all')

  const categories = useMemo(() => {
    const present = new Set(modules.map((m) => m.category))
    return (Object.keys(CATEGORY_LABELS) as ModuleCategory[]).filter((c) => present.has(c))
  }, [modules])

  const visible = filterModules(modules, query, category)

  return (
    <aside className="panel module-library" aria-label="부품 라이브러리">
      <div className="panel__header">
        <h2 className="panel__title">부품 라이브러리</h2>
        <span className="panel__meta">{modules.length}종</span>
      </div>

      <div className="module-library__controls">
        <input
          type="search"
          className="module-library__search"
          placeholder="부품 검색 (예: LED, 초음파, i2c)"
          aria-label="부품 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="module-library__chips" role="group" aria-label="카테고리 필터">
          <button
            type="button"
            className="chip"
            aria-pressed={category === 'all'}
            onClick={() => setCategory('all')}
          >
            전체
          </button>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              className="chip"
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
            >
              {CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>
      </div>

      <ul className="module-library__list" data-testid="module-list">
        {visible.map((m) => (
          <li
            key={m.id}
            className="module-card"
            draggable
            data-module-id={m.id}
            onDragStart={(e) => {
              e.dataTransfer.setData(MODULE_DRAG_TYPE, m.id)
              e.dataTransfer.effectAllowed = 'copy'
            }}
            title="작업 공간으로 끌어다 놓거나 추가 버튼을 누르세요"
          >
            <img className="module-card__icon" src={assetUrl(m.icon)} alt="" draggable={false} />
            <div className="module-card__body">
              <div className="module-card__name">{m.name}</div>
              <div className="module-card__meta">
                <span className="tag">{CATEGORY_LABELS[m.category]}</span>
                <span>핀 {m.pins.length}개</span>
              </div>
              <p className="module-card__desc">{m.description}</p>
            </div>
            <button
              type="button"
              className="button button--primary button--small"
              onClick={() => onAdd(m.id)}
              aria-label={`${m.name} 추가`}
            >
              추가
            </button>
          </li>
        ))}
      </ul>
      {visible.length === 0 && (
        <p className="empty-note" role="status">
          조건에 맞는 부품이 없습니다.
        </p>
      )}
      <p className="module-library__hint">부품을 작업 공간으로 끌어다 놓거나 [추가] 버튼을 누르세요.</p>
    </aside>
  )
}
