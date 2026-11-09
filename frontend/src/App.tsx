import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import './App.css'
import { useBackend } from './api/useBackend'
import { CodeDialog } from './components/BackendDialogs/CodeDialog'
import { ServerProjectsDialog } from './components/BackendDialogs/ServerProjectsDialog'
import { SimulationDialog } from './components/BackendDialogs/SimulationDialog'
import { CircuitCanvas } from './components/CircuitCanvas/CircuitCanvas'
import { ConnectionPanel } from './components/ConnectionPanel/ConnectionPanel'
import { Modal } from './components/common/Modal'
import { ModuleLibrary } from './components/ModuleLibrary/ModuleLibrary'
import { PropertyPanel, type PanelTab } from './components/PropertyPanel/PropertyPanel'
import type { WireStyle } from './components/CircuitCanvas/wireGeometry'
import { WorkspaceToolbar } from './components/WorkspaceToolbar/WorkspaceToolbar'
import { BOARDS, getBoard } from './data/boards'
import { MODULES } from './data/modules'
import { bomCsv, buildBom, buildPinTable, pinTableCsv } from './engine/exporters'
import { parseProjectFile, ProjectFileError, toProjectFile, type ProjectFile } from './engine/project'
import { routeBreadboard } from './engine/breadboard'
import { renderBreadboardSvg } from './engine/breadboardSvg'
import type { Circuit } from './engine/circuit'
import { analyzePower, type PowerNeed, type SupplyExample } from './engine/power'
import { renderSchematicSvg } from './engine/schematicSvg'
import { computeSeriesResistors } from './engine/resistor'
import { countIssues, validateCircuit } from './engine/validate'
import { activeBoardOf, circuitReducer, createInitialState, toProjectData, type CircuitState } from './state/circuitState'
import { canAutosave, loadAutosave, saveAutosave } from './state/persistence'
import type { Endpoint, Point, RouteMode, Selection } from './types'
import { assetUrl } from './utils/assetUrl'
import { downloadBlob, downloadText, safeFileName } from './utils/download'
import { svgToPng } from './utils/svgExport'
import { loadPreference, savePreference } from './utils/preferences'

type Dialog =
  | { kind: 'none' }
  | { kind: 'connections' }
  | { kind: 'export' }
  | { kind: 'reset' }
  | { kind: 'open-confirm' }
  | { kind: 'server'; project: ProjectFile }
  | { kind: 'code'; project: ProjectFile }
  | { kind: 'simulate'; project: ProjectFile }
  | { kind: 'error'; title: string; message: string }

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

function initState(): CircuitState {
  const saved = loadAutosave()
  const initial = createInitialState()
  if (!saved || (saved.placed.length === 0 && saved.connections.length === 0 && saved.name === initial.projectName))
    return saved ? createInitialState(saved.boards[0]) : initial
  return circuitReducer(initial, {
    type: 'loadProject',
    data: saved,
    message: '이전 작업을 복원했습니다 (브라우저 자동 저장).',
  })
}

function App() {
  const [state, dispatch] = useReducer(circuitReducer, undefined, initState)
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const [tab, setTab] = useState<PanelTab>('properties')
  const [autosaveOk] = useState(canAutosave)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [wireStyle, setWireStyle] = useState<WireStyle>(() => (loadPreference('wireStyle') === 'orthogonal' ? 'orthogonal' : 'curved'))
  /** 새 전선의 경로: 전선을 끌기 전에 고른다 */
  const [route, setRoute] = useState<RouteMode>(() => (loadPreference('route') === 'breadboard' ? 'breadboard' : 'direct'))
  const [backend, recheckBackend] = useBackend()
  /** 지금 작업이 서버에 저장된 어느 프로젝트에서 왔는지 (덮어쓰기용) */
  const [serverProjectId, setServerProjectId] = useState<string | null>(null)
  const activeBoard = activeBoardOf(state)
  const board = getBoard(activeBoard.boardId)
  const firstBoard = getBoard(state.boards[0].boardId)
  const closeDialog = useCallback(() => setDialog({ kind: 'none' }), [])

  const { projectName, boards, placed, connections, links, breadboard: breadboardPosition, nextSeq, nextConnSeq, nextBoardSeq, nextLinkSeq, labelCounters } = state
  const circuit: Circuit = useMemo(() => ({ boards, placed, connections, links, breadboard: breadboardPosition }), [boards, placed, connections, links, breadboardPosition])
  const canvasBoards = useMemo(() => boards.map((instance) => ({ instance, def: getBoard(instance.boardId) })), [boards])
  const issues = useMemo(() => validateCircuit(circuit), [circuit])
  const resistors = useMemo(() => computeSeriesResistors(circuit), [circuit])
  const pinRows = useMemo(() => buildPinTable(circuit), [circuit])
  const routing = useMemo(() => routeBreadboard(circuit), [circuit])
  const power = useMemo(() => analyzePower(circuit), [circuit])
  const counts = countIssues(issues)

  // 브라우저 자동 저장 (선택 상태와 상태 메시지는 저장하지 않는다)
  useEffect(() => {
    saveAutosave({ name: projectName, boards, placed, connections, links, breadboard: breadboardPosition, nextSeq, nextConnSeq, nextBoardSeq, nextLinkSeq, labelCounters })
  }, [projectName, boards, placed, connections, links, breadboardPosition, nextSeq, nextConnSeq, nextBoardSeq, nextLinkSeq, labelCounters])

  const changeWireStyle = (style: WireStyle) => {
    setWireStyle(style)
    savePreference('wireStyle', style)
  }

  const changeRoute = (next: RouteMode) => {
    setRoute(next)
    savePreference('route', next)
  }

  const applySupply = (need: PowerNeed, example: SupplyExample) => {
    dispatch({ type: 'applySupply', supplyId: example.id, pins: need.pins, route })
    setTab('power')
  }

  const select = useCallback((selection: Selection) => {
    dispatch({ type: 'select', selection })
    if (selection.kind !== 'none') setTab('properties')
  }, [])
  const addModule = useCallback(
    (moduleId: string, position?: Point) => dispatch({ type: 'addModule', moduleId, position }),
    [],
  )
  const removeModule = useCallback((instanceId: string) => dispatch({ type: 'removeModule', instanceId }), [])
  const removeConnection = useCallback((connectionId: string) => dispatch({ type: 'removeConnection', connectionId }), [])

  const requestReset = () => {
    if (state.placed.length === 0) return
    setDialog({ kind: 'reset' })
  }

  const saveProject = () => {
    downloadText(
      `${safeFileName(state.projectName)}.autoino.json`,
      JSON.stringify(toProjectFile(toProjectData(state)), null, 2),
      'application/json',
    )
    dispatch({ type: 'setStatus', message: '프로젝트 파일을 저장했습니다.' })
  }

  /** 백엔드로 보낼 현재 회로 (대화상자를 여는 순간의 스냅숏) */
  const openBackendDialog = (kind: 'server' | 'code' | 'simulate') => setDialog({ kind, project: toProjectFile(toProjectData(state)) })

  const requestOpen = () => {
    if (state.placed.length > 0) setDialog({ kind: 'open-confirm' })
    else fileInputRef.current?.click()
  }

  const openFile = async (file: File) => {
    try {
      const data = parseProjectFile(await file.text())
      dispatch({ type: 'loadProject', data, message: `"${file.name}"을(를) 불러왔습니다.` })
      setServerProjectId(null)
      setTab('properties')
    } catch (err) {
      setDialog({
        kind: 'error',
        title: '프로젝트를 불러올 수 없습니다',
        message: err instanceof ProjectFileError ? err.message : '파일을 읽는 중 오류가 발생했습니다.',
      })
    }
  }

  // 단축키: Delete/Backspace → 선택한 부품·전선 삭제, Escape → 선택 해제, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y → 실행 취소·다시 실행
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog.kind !== 'none' || isTypingTarget(e.target)) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        dispatch({ type: e.shiftKey ? 'redo' : 'undo' })
        return
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        dispatch({ type: 'redo' })
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.selection.kind === 'module') {
          e.preventDefault()
          removeModule(state.selection.instanceId)
        } else if (state.selection.kind === 'connection') {
          e.preventDefault()
          removeConnection(state.selection.connectionId)
        }
      } else if (e.key === 'Escape') {
        select({ kind: 'none' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog, state.selection, removeModule, removeConnection, select])

  const { selection } = state
  const selectedLabel =
    selection.kind === 'board'
      ? `${state.boards.length > 1 ? `${activeBoard.label} · ` : ''}${board.name}`
      : selection.kind === 'module'
        ? (state.placed.find((p) => p.instanceId === selection.instanceId)?.label ?? '없음')
        : selection.kind === 'connection'
          ? `전선 ${selection.connectionId}`
          : selection.kind === 'breadboard'
            ? '브레드보드'
            : '없음'

  const fileBase = safeFileName(state.projectName)

  /** 회로도·브레드보드 이미지를 SVG 또는 PNG 로 내려받는다 */
  const exportImage = async (what: 'schematic' | 'breadboard', format: 'svg' | 'png') => {
    const svg = what === 'schematic' ? renderSchematicSvg(circuit, state.projectName) : renderBreadboardSvg(routing, circuit, state.projectName)
    const name = `${fileBase}-${what === 'schematic' ? 'schematic' : 'breadboard'}.${format}`
    try {
      if (format === 'svg') downloadText(name, svg, 'image/svg+xml')
      else downloadBlob(name, await svgToPng(svg))
      dispatch({ type: 'setStatus', message: `${what === 'schematic' ? '회로도' : '브레드보드 배치도'}를 ${format.toUpperCase()} 로 저장했습니다.` })
    } catch (err) {
      setDialog({ kind: 'error', title: '이미지를 만들 수 없습니다', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__brand">
          <img src={assetUrl('favicon.svg')} alt="" width={32} height={32} />
          <div>
            <h1>Autoino</h1>
            <span className="app-header__tagline">아두이노 회로 자동 설계</span>
          </div>
        </div>
        <div className="app-header__project">
          <input
            className="app-header__project-name"
            aria-label="프로젝트 이름"
            value={state.projectName}
            maxLength={80}
            onChange={(e) => dispatch({ type: 'setProjectName', name: e.target.value })}
            onBlur={(e) => !e.target.value.trim() && dispatch({ type: 'setProjectName', name: '제목 없는 프로젝트' })}
          />
          <span
            className={`badge ${autosaveOk ? 'badge--ok' : 'badge--pending'}`}
            title={autosaveOk ? '이 브라우저에만 저장됩니다. 다른 기기로 옮기려면 [저장]으로 파일을 내려받으세요.' : '브라우저 저장소를 사용할 수 없습니다.'}
            data-testid="autosave-status"
          >
            {autosaveOk ? '브라우저에 자동 저장됨' : '자동 저장 불가'}
          </span>
          <button
            type="button"
            className={`badge badge--button ${backend.state === 'online' ? 'badge--ok' : 'badge--pending'}`}
            title={
              backend.state === 'online'
                ? `파이썬 백엔드 ${backend.health.version} 에 연결됨: 서버 저장 · 코드 생성 · 시뮬레이션 사용 가능`
                : '백엔드 서버가 없습니다. 편집·검사·내보내기는 그대로 쓸 수 있습니다. 누르면 다시 확인합니다.'
            }
            onClick={recheckBackend}
            data-testid="backend-status"
          >
            {backend.state === 'checking' ? '서버 확인 중…' : backend.state === 'online' ? '서버 연결됨' : '서버 없음'}
          </button>
        </div>
        <div className="app-header__actions">
          <button type="button" className="button" onClick={requestOpen}>
            열기
          </button>
          <button type="button" className="button" onClick={saveProject}>
            저장
          </button>
          <button type="button" className="button" onClick={() => openBackendDialog('server')} data-testid="open-server">
            서버
          </button>
          <span className="app-header__divider" aria-hidden="true" />
          <button type="button" className="button" onClick={() => openBackendDialog('code')} data-testid="open-code">
            코드
          </button>
          <button type="button" className="button" onClick={() => openBackendDialog('simulate')} data-testid="open-simulate">
            시뮬레이션
          </button>
          <button type="button" className="button" onClick={() => setDialog({ kind: 'export' })}>
            내보내기
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            hidden
            data-testid="open-file"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void openFile(file)
            }}
          />
        </div>
      </header>

      <main className="app-main">
        <ModuleLibrary modules={MODULES} onAdd={(id) => addModule(id)} />

        <div className="workspace">
          <WorkspaceToolbar
            boards={BOARDS}
            board={board}
            boardLabel={state.boards.length > 1 ? activeBoard.label : undefined}
            boardCount={state.boards.length}
            placedCount={state.placed.length}
            connectionCount={state.connections.length}
            canUndo={state.past.length > 0}
            canRedo={state.future.length > 0}
            wireStyle={wireStyle}
            route={route}
            onBoardChange={(boardId) => dispatch({ type: 'setBoard', boardInstanceId: activeBoard.instanceId, boardId })}
            onAddBoard={() => dispatch({ type: 'addBoard', boardId: activeBoard.boardId })}
            onAutoAssign={() => dispatch({ type: 'autoAssign', route })}
            onInsertLevelShifters={() => dispatch({ type: 'insertLevelShifters' })}
            onArrange={() => dispatch({ type: 'arrangeModules' })}
            onClearConnections={() => dispatch({ type: 'clearConnections' })}
            onWireStyleChange={changeWireStyle}
            onRouteChange={changeRoute}
            onOpenConnections={() => setDialog({ kind: 'connections' })}
            onUndo={() => dispatch({ type: 'undo' })}
            onRedo={() => dispatch({ type: 'redo' })}
            onReset={requestReset}
          />
          <CircuitCanvas
            boards={canvasBoards}
            placed={state.placed}
            connections={state.connections}
            selection={state.selection}
            issues={issues}
            resistors={resistors}
            wireStyle={wireStyle}
            route={route}
            routing={routing}
            breadboard={state.breadboard}
            onSelect={select}
            onDropModule={addModule}
            onMoveModule={(instanceId, position) => dispatch({ type: 'moveModule', instanceId, position })}
            onMoveBoard={(boardInstanceId, position) => dispatch({ type: 'moveBoard', boardInstanceId, position })}
            onMoveBreadboard={(position) => dispatch({ type: 'moveBreadboard', position })}
            onCheckpoint={() => dispatch({ type: 'checkpoint' })}
            onConnect={(from, to) => dispatch({ type: 'connect', from, to, ...(route === 'breadboard' ? { via: 'breadboard' as const } : {}) })}
            onConnectAuto={(endpoint: Endpoint) => dispatch({ type: 'connectAuto', endpoint, route: 'breadboard' })}
          />
        </div>

        <PropertyPanel
          board={firstBoard}
          circuit={circuit}
          selection={state.selection}
          issues={issues}
          resistors={resistors}
          pinRows={pinRows}
          power={power}
          routing={routing}
          tab={tab}
          onTabChange={setTab}
          onSelect={select}
          onRemove={removeModule}
          onRemoveConnection={removeConnection}
          onSetParam={(instanceId, paramId, value) => dispatch({ type: 'setParam', instanceId, paramId, value })}
          onRemoveBoard={(boardInstanceId) => dispatch({ type: 'removeBoard', boardInstanceId })}
          onSetHostBoard={(instanceId, boardInstanceId) => dispatch({ type: 'setHostBoard', instanceId, boardInstanceId })}
          onSetRoute={(connectionId, via) => dispatch({ type: 'setConnectionRoute', connectionId, via })}
          onApplySupply={applySupply}
          onExportBreadboard={(format) => void exportImage('breadboard', format)}
        />
      </main>

      <footer className="status-bar" aria-label="작업 상태">
        <span className="status-bar__message" role="status" data-testid="status-message">
          {state.statusMessage}
        </span>
        <span className="status-bar__items">
          <span>보드: {state.boards.length > 1 ? `${state.boards.length}개` : firstBoard.name}</span>
          <span>부품: {state.placed.length}개</span>
          <span>연결: {state.connections.length}개</span>
          <span>선택: {selectedLabel}</span>
          <button
            type="button"
            className={`status-bar__check${counts.error ? ' is-error' : counts.warning ? ' is-warning' : ' is-ok'}`}
            onClick={() => setTab('validation')}
            data-testid="status-validation"
          >
            검사: 오류 {counts.error} · 경고 {counts.warning}
          </button>
        </span>
      </footer>

      {dialog.kind === 'connections' && (
        <ConnectionPanel
          board={board}
          boards={state.boards}
          links={state.links}
          onCreate={(request) => dispatch({ type: 'addBoardLink', request })}
          onRemove={(linkId) => dispatch({ type: 'removeBoardLink', linkId })}
          onAddBoard={() => dispatch({ type: 'addBoard', boardId: activeBoard.boardId })}
          onClose={closeDialog}
        />
      )}

      {dialog.kind === 'export' && (
        <Modal
          title="내보내기"
          onClose={closeDialog}
          footer={
            <button type="button" className="button" onClick={closeDialog}>
              닫기
            </button>
          }
        >
          {counts.error > 0 && (
            <p className="callout callout--error">
              검사 오류가 {counts.error}개 있습니다. 내보낸 자료에도 그대로 반영되니 먼저 [검사] 탭을 확인하세요.
            </p>
          )}
          <div className="export-list">
            <div className="export-item">
              <div>
                <strong>부품 목록 (BOM)</strong>
                <p className="muted small">보드, 부품, 자동 선정된 저항, 점퍼 와이어 수량 · CSV (엑셀 호환)</p>
              </div>
              <button
                type="button"
                className="button button--primary button--small"
                data-testid="export-bom"
                onClick={() => downloadText(`${fileBase}-bom.csv`, bomCsv(circuit, routing), 'text/csv')}
              >
                CSV 받기
              </button>
            </div>
            <div className="export-item">
              <div>
                <strong>핀 배정표</strong>
                <p className="muted small">부품 핀별 보드 핀과 직렬 저항 · CSV</p>
              </div>
              <button
                type="button"
                className="button button--primary button--small"
                data-testid="export-pins"
                onClick={() => downloadText(`${fileBase}-pins.csv`, pinTableCsv(circuit), 'text/csv')}
              >
                CSV 받기
              </button>
            </div>
            <div className="export-item">
              <div>
                <strong>프로젝트 파일</strong>
                <p className="muted small">나중에 [열기]로 다시 편집할 수 있는 .autoino.json</p>
              </div>
              <button type="button" className="button button--small" onClick={saveProject}>
                저장
              </button>
            </div>
            <div className="export-item">
              <div>
                <strong>회로도 이미지</strong>
                <p className="muted small">보드·부품 블록과 넷 라벨, 직렬 저항 기호 · SVG(벡터) / PNG</p>
              </div>
              <div className="export-item__buttons">
                <button type="button" className="button button--small" data-testid="export-schematic-svg" onClick={() => void exportImage('schematic', 'svg')}>
                  SVG
                </button>
                <button type="button" className="button button--small" data-testid="export-schematic-png" onClick={() => void exportImage('schematic', 'png')}>
                  PNG
                </button>
              </div>
            </div>
            <div className="export-item">
              <div>
                <strong>브레드보드 배치도</strong>
                <p className="muted small">브레드보드 경유 배선과 구멍별 배선표 · SVG / PNG</p>
              </div>
              <div className="export-item__buttons">
                <button type="button" className="button button--small" data-testid="export-breadboard-svg" disabled={!routing.leads.length} onClick={() => void exportImage('breadboard', 'svg')}>
                  SVG
                </button>
                <button type="button" className="button button--small" disabled={!routing.leads.length} onClick={() => void exportImage('breadboard', 'png')}>
                  PNG
                </button>
              </div>
            </div>
          </div>
          {state.placed.length > 0 && (
            <>
              <h3 className="small-heading">회로도 미리 보기</h3>
              <img className="export-preview" alt="회로도 미리 보기" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSchematicSvg(circuit, state.projectName))}`} data-testid="schematic-preview" />
            </>
          )}
          <h3 className="small-heading">부품 목록 미리 보기</h3>
          <table className="pin-table" data-testid="bom-preview">
            <thead>
              <tr>
                <th>품목</th>
                <th>사양</th>
                <th>수량</th>
              </tr>
            </thead>
            <tbody>
              {buildBom(circuit, routing).map((r) => (
                <tr key={`${r.item}-${r.spec}`}>
                  <td>{r.item}</td>
                  <td>{r.spec}</td>
                  <td>{r.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}

      {dialog.kind === 'server' && (
        <ServerProjectsDialog
          status={backend}
          currentId={serverProjectId}
          project={dialog.project}
          hasWork={state.placed.length > 0}
          onRecheck={recheckBackend}
          onClose={closeDialog}
          onSaved={(id, name) => {
            setServerProjectId(id)
            dispatch({ type: 'setStatus', message: `서버에 "${name}"을(를) 저장했습니다.` })
          }}
          onOpened={(id, file) => {
            try {
              const data = parseProjectFile(file)
              dispatch({ type: 'loadProject', data, message: `서버 프로젝트 "${data.name}"을(를) 열었습니다.` })
              setServerProjectId(id)
              setTab('properties')
              closeDialog()
            } catch (err) {
              setDialog({ kind: 'error', title: '프로젝트를 불러올 수 없습니다', message: err instanceof Error ? err.message : String(err) })
            }
          }}
        />
      )}

      {dialog.kind === 'code' && (
        <CodeDialog status={backend} project={dialog.project} errorCount={counts.error} onRecheck={recheckBackend} onClose={closeDialog} />
      )}

      {dialog.kind === 'simulate' && <SimulationDialog status={backend} project={dialog.project} onRecheck={recheckBackend} onClose={closeDialog} />}

      {dialog.kind === 'open-confirm' && (
        <Modal
          title="프로젝트 열기"
          onClose={closeDialog}
          footer={
            <>
              <button type="button" className="button" onClick={closeDialog}>
                취소
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => {
                  closeDialog()
                  fileInputRef.current?.click()
                }}
              >
                파일 선택
              </button>
            </>
          }
        >
          <p>
            파일을 열면 현재 작업(부품 {state.placed.length}개, 연결 {state.connections.length}개)이 대체됩니다. 필요하면 먼저
            [저장]으로 파일을 내려받으세요.
          </p>
        </Modal>
      )}

      {dialog.kind === 'error' && (
        <Modal
          title={dialog.title}
          onClose={closeDialog}
          footer={
            <button type="button" className="button" onClick={closeDialog}>
              확인
            </button>
          }
        >
          <p className="callout callout--error" data-testid="error-message">
            {dialog.message}
          </p>
        </Modal>
      )}

      {dialog.kind === 'reset' && (
        <Modal
          title="작업 공간 초기화"
          onClose={closeDialog}
          footer={
            <>
              <button type="button" className="button" onClick={closeDialog}>
                취소
              </button>
              <button
                type="button"
                className="button button--danger"
                onClick={() => {
                  dispatch({ type: 'reset' })
                  closeDialog()
                }}
              >
                초기화
              </button>
            </>
          }
        >
          <p>
            배치된 부품 <strong>{state.placed.length}개</strong>와 연결 <strong>{state.connections.length}개</strong>가 모두
            제거되고 선택 상태가 초기화됩니다. 메인 보드 선택({board.name})과 프로젝트 이름은 유지됩니다.
          </p>
          <p className="muted small">이 작업은 되돌릴 수 없습니다.</p>
        </Modal>
      )}
    </div>
  )
}

export default App
