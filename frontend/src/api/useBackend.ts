import { useCallback, useEffect, useState } from 'react'
import { api, type HealthResponse } from './client'

export type BackendStatus = { state: 'checking' } | { state: 'online'; health: HealthResponse } | { state: 'offline' }

/** 백엔드 서버가 켜져 있는지 확인한다 (/api/health) */
export function useBackend(): [BackendStatus, () => void] {
  const [status, setStatus] = useState<BackendStatus>({ state: 'checking' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    api
      .health()
      .then((health) => !cancelled && setStatus(health.status === 'ok' ? { state: 'online', health } : { state: 'offline' }))
      .catch(() => !cancelled && setStatus({ state: 'offline' }))
    return () => {
      cancelled = true
    }
  }, [attempt])

  const recheck = useCallback(() => {
    setStatus({ state: 'checking' })
    setAttempt((n) => n + 1)
  }, [])
  return [status, recheck]
}
