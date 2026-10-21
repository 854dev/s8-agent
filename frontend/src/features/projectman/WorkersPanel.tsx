import type { ResidentWorker, WorkerMode } from './api'

export const workerModeLabels: Record<WorkerMode, string> = { active: '자동', passive: '지시 대기', paused: '일시 정지' }
const modeHints: Record<WorkerMode, string> = { active: '실행 대기 작업을 스스로 맡습니다.', passive: '지시를 받아야 작업을 시작합니다.', paused: '새 작업을 맡지 않습니다. 진행 중인 작업은 끝까지 합니다.' }

type Props = {
  workers: ResidentWorker[]
  busy: boolean
  onMode: (id: string, mode: WorkerMode | null) => void
  onOpenTask: (uid: string) => void
}

// 상주 워커 목록과 모드 전환. 워커는 s8-config.yml의 workers로 정하고, 여기서 바꾼 모드는 설정값으로 되돌릴 수 있다.
export default function WorkersPanel({ workers, busy, onMode, onOpenTask }: Props) {
  return <section className="pm-workers" aria-label="상주 워커">
    <h2>상주 워커</h2>
    {!workers.length ? <p className="pm-hint">등록되거나 연결된 상주 워커가 없습니다. 로컬 workers 설정이나 원격 워커의 매니저 연결을 확인하세요.</p> : <ul>
      {workers.map(worker => <li key={worker.id} className="pm-worker">
        <div className="pm-worker-head">
          <strong>{worker.id}</strong>
          <span className={`pm-worker-state ${worker.running ? '' : 'pm-worker-state--down'}`}>{worker.running ? '동작 중' : '꺼짐'}</span>
        </div>
        {worker.nodeId && <p className="pm-hint">장비 {worker.nodeId} · {worker.connected ? '통신 연결됨' : '통신 끊김'}{worker.heartbeatAt && <> · 마지막 확인 {new Date(worker.heartbeatAt).toLocaleTimeString()}</>}</p>}
        <div className="pm-worker-modes" role="group" aria-label={`${worker.id} 모드`}>
          {(Object.keys(workerModeLabels) as WorkerMode[]).map(mode => <button key={mode} aria-pressed={worker.mode === mode} disabled={busy || worker.mode === mode} onClick={() => onMode(worker.id, mode)}>{workerModeLabels[mode]}</button>)}
        </div>
        <p className="pm-hint">{modeHints[worker.mode]}{worker.overridden && <> 설정값은 {workerModeLabels[worker.configMode]}입니다. <button className="pm-link" disabled={busy} onClick={() => onMode(worker.id, null)}>설정값으로 되돌리기</button></>}</p>
        <p>{worker.current ? <>작업 중 <button className="pm-link" onClick={() => onOpenTask(worker.current!.uid)}>{worker.current.uid}</button></> : worker.research ? '조사·검토 중' : '쉬는 중'}{worker.queue.length > 0 && <> · 대기 지시 {worker.queue.join(', ')}</>}</p>
        {worker.research && <p className="pm-hint">{worker.research.recovering ? '재시작 후 조사 결과 확인 필요' : worker.research.timedOut ? '조사 응답 기한 초과 · 자동 중단 아님' : '임시 조사·검토 중'} · {worker.research.requestId}</p>}
        {worker.current?.runId && <p className="pm-hint">실행 {worker.current.runId} · {worker.current.claimed ? 'claim 확인됨' : 'claim 확인 대기'}</p>}
        {worker.metrics && <p className="pm-hint">통신 응답 대기 {worker.metrics.pending} · 오류 {worker.metrics.failures}{worker.metrics.lastLatencyMs !== null && <> · 최근 응답 {worker.metrics.lastLatencyMs}ms</>}{worker.metrics.lastError && <> · {worker.metrics.lastError}</>}</p>}
        {worker.lastError && <p className="pm-hint">최근 시작 실패: {worker.lastError.uid} · {worker.lastError.message}</p>}
        {!worker.running && <p className="pm-hint">{worker.nodeId ? '해당 장비의 ./s8.sh workers 실행과 매니저 연결을 확인하세요.' : '워커 루프가 실행 중이 아닙니다. ./s8.sh로 런타임을 시작하세요.'}</p>}
      </li>)}
    </ul>}
  </section>
}
