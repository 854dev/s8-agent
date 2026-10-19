import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { dueDate, isDue, validId, validateJob } from './store.mjs';
import { visible } from '../../../apps/telegram-gateway/gateway.mjs';
import { loadTelegramConfig, telegramConfigFromEnv } from '../config/s8-config.mjs';
import { runProjectmanTurn } from '../projectman/dispatch.ts';
import { acquirePidLock } from '../runtime/process.mjs';

const MAX_OUTPUT = 8000;
const RUN_TIMEOUT = 10 * 60_000;
export { sendTelegram } from '../telegram/notify.mjs';
import { sendTelegram } from '../telegram/notify.mjs';

const readJson = async (file, fallback) => {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};
const writeJson = async (file, data) => {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
};

function runScript(scriptPath, job, options) {
  return new Promise(resolve => {
    if (job.expiresAt && options.now().getTime() >= Date.parse(job.expiresAt)) {
      resolve({ ok: false, output: 'Operation window ended; no batch started.' });
      return;
    }
    const child = spawn(options.bash ?? 'bash', [scriptPath], {
      cwd: options.cwd,
      env: { ...options.env, S8_SCHEDULE_ID: job.id, S8_SCHEDULE_TIME: job.time ?? `${job.intervalMinutes}m` },
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    let output = '', timedOut = false, cancelled = false, settled = false, killTimer;
    const terminate = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000);
        killTimer.unref();
      }
    };
    let checking = false;
    const cancelTimer = setInterval(async () => {
      if (checking || settled || cancelled) return;
      checking = true;
      try {
        const runId = await readFile(options.cancelFile, 'utf8');
        if (!settled && runId === options.runId) { cancelled = true; terminate(); }
      } catch {} finally { checking = false; }
    }, 250);
    const decoder = new StringDecoder('utf8');
    const collect = chunk => { if (output.length < MAX_OUTPUT) output += decoder.write(chunk).slice(0, MAX_OUTPUT - output.length); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const finish = result => { if (settled) return; settled = true; clearTimeout(timeout); clearInterval(cancelTimer); clearTimeout(killTimer); resolve(result); };
    const timeoutMs = job.expiresAt ? Math.min(RUN_TIMEOUT, Math.max(0, Date.parse(job.expiresAt) - options.now().getTime())) : RUN_TIMEOUT;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.on('error', error => finish({ ok: false, output: `${error.message}\n${output}` }));
    child.on('close', code => finish({ ok: !timedOut && !cancelled && code === 0, cancelled, output: `${cancelled ? 'Cancelled by user.\n' : timedOut ? 'Timed out (batch limit or operation window ended).\n' : ''}${output}` }));
  });
}

export async function runScheduler({ root, cwd = process.cwd(), bash, env = process.env, fetchImpl = fetch, onResult = console.log, now = () => new Date(), telegramSettings = loadTelegramConfig(path.resolve(root, '../..'), env), projectmanTurn = runProjectmanTurn }) {
  const scripts = path.join(root, 'scripts');
  const jobsFile = path.join(root, 'jobs.json');
  const stateFile = path.join(root, 'state.json');
  const lockFile = path.join(root, 'owner.lock');
  await mkdir(root, { recursive: true, mode: 0o700 });
  // 스케줄러는 체크아웃당 하나. 소유 프로세스가 죽은 잠금만 자동으로 정리한다.
  const releaseLock = await acquirePidLock(lockFile, { extra: 'expiresAt-v1\nprojectman-v1\n' }).catch(error => {
    throw error.code === 'ELOCKED' ? new Error(`Scheduler is already running (PID ${error.pid}). Stop it before starting another.`) : error;
  });
  let activeProjectman;
  const executeDue = async () => {
    const data = await readJson(jobsFile, { version: 1, jobs: [] });
    const state = await readJson(stateFile, { version: 1, jobs: {} });
    if (data.version !== 1 || !Array.isArray(data.jobs) || state.version !== 1 || !state.jobs) throw new Error('Invalid scheduler data.');
    for (const entry of data.jobs) {
      if (!validId(entry.id) || typeof entry.enabled !== 'boolean') continue;
      const script = entry.kind === 'projectman' ? undefined : await readFile(path.join(scripts, `${entry.id}.sh`), 'utf8').catch(() => '');
      let job;
      try { job = validateJob({ ...entry, script }); } catch { continue; }
      const current = now();
      const prior = state.jobs[job.id] ?? {};
      if (!isDue(job, current, prior.lastRunDate)) continue;
      const when = dueDate(job, current).date;
      const runId = randomUUID();
      const cancelFile = path.join(root, `${job.id}.cancel`);
      await rm(cancelFile, { force: true });
      state.jobs[job.id] = { ...prior, runId, lastRunDate: when, lastRunAt: current.toISOString(), result: 'running' };
      if (job.kind !== 'projectman') {
        state.jobs[job.id].notificationStatus = 'pending';
        delete state.jobs[job.id].notificationError;
        delete state.jobs[job.id].notifiedAt;
      }
      await writeJson(stateFile, state);
      if (job.kind === 'projectman') {
        const controller = new AbortController();
        activeProjectman = controller;
        if (stopping) controller.abort('scheduler_stop');
        const deadline = Date.now() + Math.min(RUN_TIMEOUT, job.expiresAt ? Math.max(0, Date.parse(job.expiresAt) - now().getTime()) : Infinity);
        const timeout = setTimeout(() => controller.abort('deadline'), Math.max(0, deadline - Date.now()));
        const cancelTimer = setInterval(async () => {
          try { if (await readFile(cancelFile, 'utf8') === runId) controller.abort('user_stop'); } catch {}
        }, 250);
        try {
          const outcome = await projectmanTurn({ root, projectUid: job.projectUid, deadline, signal: controller.signal,
            notify: async ({ stage, uid, message }) => {
              state.jobs[job.id].workUid = uid;
              state.jobs[job.id].notificationStatus = 'pending';
              delete state.jobs[job.id].notificationError;
              delete state.jobs[job.id].notifiedAt;
              await writeJson(stateFile, state);
              let sent = false;
              try {
                sent = await sendTelegram(message, env, fetchImpl, telegramSettings);
                state.jobs[job.id].notificationStatus = sent ? 'sent' : 'not_configured';
                delete state.jobs[job.id].notificationError;
                if (sent) state.jobs[job.id].notifiedAt = now().toISOString();
              } catch (error) {
                state.jobs[job.id].notificationStatus = 'failed';
                state.jobs[job.id].notificationError = error.status ? `http_${error.status}` : 'transport_error';
                onResult(`Projectman ${stage} notification failed`);
              }
              state.jobs[job.id][stage === 'start' ? 'dispatchNotificationStatus' : 'notificationStatus'] = state.jobs[job.id].notificationStatus;
              await writeJson(stateFile, state);
              return sent;
            },
          });
          state.jobs[job.id].result = outcome.status;
        } catch {
          state.jobs[job.id].result = 'failed';
          onResult('Projectman poll/dispatch failed; inspect the job and Projectman state.');
        } finally {
          clearTimeout(timeout);
          clearInterval(cancelTimer);
          activeProjectman = undefined;
          await rm(cancelFile, { force: true });
        }
        state.jobs[job.id].finishedAt = now().toISOString();
        state.jobs[job.id].notificationStatus ??= 'not_needed';
        await writeJson(stateFile, state);
        continue;
      }
      const result = await runScript(path.join(scripts, `${job.id}.sh`), job, { cwd, bash, env, cancelFile, runId, now });
      await rm(cancelFile, { force: true });
      state.jobs[job.id] = { ...state.jobs[job.id], result: result.cancelled ? 'cancelled' : result.ok ? 'success' : 'failed', finishedAt: now().toISOString() };
      await writeJson(stateFile, state);
      const message = `예약 작업 ${job.id} (${job.time ?? `${job.intervalMinutes}분마다`}, ${job.timezone}) ${result.ok ? '완료' : '실패'}\n\n${result.output.trim() || '(출력 없음)'}`;
      try {
        const sent = await sendTelegram(message, env, fetchImpl, telegramSettings);
        state.jobs[job.id].notificationStatus = sent ? 'sent' : 'not_configured';
        delete state.jobs[job.id].notificationError;
        if (sent) state.jobs[job.id].notifiedAt = now().toISOString();
        else { delete state.jobs[job.id].notifiedAt; onResult(visible(message)); }
      } catch (error) {
        state.jobs[job.id].notificationStatus = 'failed';
        state.jobs[job.id].notificationError = error.status ? `http_${error.status}` : error.name === 'TimeoutError' ? 'timeout' : 'transport_error';
        delete state.jobs[job.id].notifiedAt;
        onResult(`${visible(message)}\n\nTelegram 알림 실패: ${state.jobs[job.id].notificationError}`);
      }
      await writeJson(stateFile, state);
    }
  };
  let busy = false, stopping = false, timer, stopPromise;
  const tick = async () => {
    if (busy || stopping) return;
    busy = true;
    try { await executeDue(); }
    catch (error) { onResult(`Scheduler error: ${error.message}`); }
    finally { busy = false; }
  };
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopping = true;
    activeProjectman?.abort('scheduler_stop');
    clearInterval(timer);
    stopPromise = (async () => {
      while (busy) await new Promise(resolve => setTimeout(resolve, 50));
      process.off('SIGINT', stopSignals);
      process.off('SIGTERM', stopSignals);
      process.off('SIGHUP', stopSignals);
      await releaseLock();
    })();
    return stopPromise;
  };
  const stopSignals = () => { void stop().finally(() => process.exit(0)); };
  process.once('SIGINT', stopSignals);
  process.once('SIGTERM', stopSignals);
  process.once('SIGHUP', stopSignals);
  timer = setInterval(() => void tick(), 10_000);
  void tick();
  return stop;
}
