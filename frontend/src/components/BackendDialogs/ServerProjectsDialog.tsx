import { useCallback, useEffect, useState } from 'react'
import { api, type ServerProjectSummary } from '../../api/client'
import type { BackendStatus } from '../../api/useBackend'
import type { ProjectFile } from '../../engine/project'
import { getBoard } from '../../data/boards'
import { Modal } from '../common/Modal'
import { BackendRequired } from './BackendRequired'
import './BackendDialogs.css'

interface ServerProjectsDialogProps {
  status: BackendStatus
  /** 지금 편집 중인 작업이 서버의 어느 프로젝트인지 (없으면 null) */
  currentId: string | null
  project: ProjectFile
  hasWork: boolean
  onOpened: (id: string, file: ProjectFile) => void
  onSaved: (id: string, name: string) => void
  onRecheck: () => void
  onClose: () => void
}

function boardNames(ids: string[]): string {
  return ids
    .map((id) => {
      try {
        return getBoard(id).name
      } catch {
        return id
      }
    })
    .join(', ')
}

/** 백엔드 서버(projects/ 폴더)에 저장한 프로젝트 목록 */
export function ServerProjectsDialog({ status, currentId, project, hasWork, onOpened, onSaved, onRecheck, onClose }: ServerProjectsDialogProps) {
  const [items, setItems] = useState<ServerProjectSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const online = status.state === 'online'

  const refresh = useCallback(() => {
    api
      .listProjects()
      .then((list) => {
        setItems(list)
        setError(null)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  useEffect(() => {
    if (online) refresh()
  }, [online, refresh])

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const saveNew = () =>
    act(async () => {
      const saved = await api.createProject(project)
      onSaved(saved.id, saved.project.name)
      refresh()
    })
  const overwrite = (id: string) =>
    act(async () => {
      const saved = await api.saveProject(id, project)
      onSaved(saved.id, saved.project.name)
      refresh()
    })
  const open = (id: string) =>
    act(async () => {
      const loaded = await api.getProject(id)
      onOpened(loaded.id, loaded.project)
    })
  const remove = (id: string) =>
    act(async () => {
      await api.deleteProject(id)
      setConfirmDelete(null)
      refresh()
    })

  return (
    <Modal
      title="서버 프로젝트"
      size="wide"
      onClose={onClose}
      footer={
        <button type="button" className="button" onClick={onClose}>
          닫기
        </button>
      }
    >
      {!online ? (
        <BackendRequired status={status} feature="서버 저장" onRecheck={onRecheck} />
      ) : (
        <div data-testid="server-projects">
          <p className="muted small">
            백엔드 서버의 <code>projects/</code> 폴더에 저장합니다. 브라우저 자동 저장과 달리 다른 브라우저·기기에서도 같은 서버로 열 수 있습니다.
          </p>
          <div className="server-actions">
            <button type="button" className="button button--primary button--small" disabled={busy} onClick={() => void saveNew()} data-testid="server-save-new">
              현재 작업을 새 프로젝트로 저장
            </button>
            {currentId && (
              <button type="button" className="button button--small" disabled={busy} onClick={() => void overwrite(currentId)} data-testid="server-overwrite">
                열어 둔 서버 프로젝트에 덮어쓰기
              </button>
            )}
          </div>
          {error && (
            <p className="callout callout--error" data-testid="server-error">
              {error}
            </p>
          )}
          {hasWork && <p className="muted small">목록에서 프로젝트를 열면 현재 작업(브라우저 자동 저장 포함)이 대체됩니다. 필요하면 먼저 저장하세요.</p>}
          {items === null ? (
            <p className="muted">목록을 불러오는 중…</p>
          ) : items.length === 0 ? (
            <p className="muted" data-testid="server-empty">
              저장된 프로젝트가 없습니다.
            </p>
          ) : (
            <table className="pin-table" data-testid="server-list">
              <thead>
                <tr>
                  <th>이름</th>
                  <th>보드</th>
                  <th>부품 · 연결</th>
                  <th>저장 시각</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id} className={p.id === currentId ? 'is-current' : undefined}>
                    <td>
                      <strong>{p.name}</strong>
                      {p.id === currentId && <span className="muted small"> (열려 있음)</span>}
                    </td>
                    <td className="small">{boardNames(p.boards)}</td>
                    <td>
                      {p.moduleCount} · {p.connectionCount}
                    </td>
                    <td className="small">{p.savedAt ? new Date(p.savedAt).toLocaleString('ko-KR') : '—'}</td>
                    <td className="server-row-buttons">
                      {confirmDelete === p.id ? (
                        <>
                          <button type="button" className="button button--danger button--small" disabled={busy} onClick={() => void remove(p.id)}>
                            삭제 확인
                          </button>
                          <button type="button" className="button button--small" onClick={() => setConfirmDelete(null)}>
                            취소
                          </button>
                        </>
                      ) : (
                        <>
                          <button type="button" className="button button--small" disabled={busy} onClick={() => void open(p.id)} data-testid={`server-open-${p.id}`}>
                            열기
                          </button>
                          <button type="button" className="button button--small" onClick={() => setConfirmDelete(p.id)} data-testid={`server-delete-${p.id}`}>
                            삭제
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Modal>
  )
}
