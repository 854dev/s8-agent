import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validId } from './scheduler-store.mjs';

async function read(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function controlSchedules(root, action = 'list', id) {
  if (!['list', 'pause', 'resume', 'stop'].includes(action)) throw new Error('지원하지 않는 예약 명령');
  const jobsFile = path.join(root, 'jobs.json');
  const state = await read(path.join(root, 'state.json'), { jobs: {} });
  if (action === 'list') {
    const data = await read(jobsFile, { version: 1, jobs: [] });
    return data.jobs.map(job => `${job.id} · ${job.time ?? `${job.intervalMinutes}분마다`} (${job.timezone}) · ${job.enabled ? '활성' : '정지'} · ${state.jobs[job.id]?.result ?? '실행 이력 없음'}`).join('\n') || '등록된 예약이 없습니다.';
  }
  if (!validId(id)) throw new Error('유효한 예약 ID가 필요합니다.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await open(`${jobsFile}.lock`, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('다른 예약 수정이 진행 중입니다.'); throw error; }
  try {
    const data = await read(jobsFile, { version: 1, jobs: [] });
    const job = data.jobs.find(job => job.id === id);
    if (!job) throw new Error('예약을 찾지 못했습니다.');
    if (action === 'stop') {
      const run = state.jobs[id];
      if (run?.result !== 'running' || !run.runId) throw new Error('현재 실행 중인 배치가 없습니다.');
      await writeFile(path.join(root, `${id}.cancel`), run.runId, { mode: 0o600 });
      return `${id}: 현재 배치 중단을 요청했습니다. 예약은 유지됩니다.`;
    }
    job.enabled = action === 'resume';
    const temp = `${jobsFile}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, jobsFile);
    return `${id}: 예약을 ${job.enabled ? '재개' : '일시정지'}했습니다. 현재 배치는 변경하지 않습니다.`;
  } finally { await lock.close(); await rm(`${jobsFile}.lock`, { force: true }); }
}
