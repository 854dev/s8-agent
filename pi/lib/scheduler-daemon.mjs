import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { dueDate, isDue, validId, validateJob } from './scheduler-store.mjs';
import { visible } from '../../apps/telegram-gateway/gateway.mjs';

const MAX_OUTPUT = 8000;
const RUN_TIMEOUT = 10 * 60_000;
const sendTelegram = async (text, env = process.env, fetchImpl = fetch) => {
  if (!env.TELEGRAM_BOT_TOKEN || !env.S8_SCHEDULE_TELEGRAM_CHAT_ID) return false;
  const allowed = new Set([...(env.TELEGRAM_ALLOWED_USER_IDS ?? '').split(','), ...(env.TELEGRAM_ALLOWED_GROUP_IDS ?? '').split(',')].map(id => id.trim()).filter(Boolean));
  if (!allowed.has(env.S8_SCHEDULE_TELEGRAM_CHAT_ID)) throw new Error('Scheduled Telegram target must be in an allowed user or group list.');
  const safe = Array.from(visible(text));
  for (let offset = 0; offset < safe.length; offset += 3500) {
    const response = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.S8_SCHEDULE_TELEGRAM_CHAT_ID, text: safe.slice(offset, offset + 3500).join('') }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(`Telegram send failed (HTTP ${response.status})`);
  }
  return true;
};

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
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, RUN_TIMEOUT);
    child.on('error', error => finish({ ok: false, output: `${error.message}\n${output}` }));
    child.on('close', code => finish({ ok: !timedOut && !cancelled && code === 0, cancelled, output: `${cancelled ? 'Cancelled by user.\n' : timedOut ? 'Timed out after 10 minutes.\n' : ''}${output}` }));
  });
}

export async function runScheduler({ root, cwd = process.cwd(), bash, env = process.env, fetchImpl = fetch, onResult = console.log, now = () => new Date() }) {
  const scripts = path.join(root, 'scripts');
  const jobsFile = path.join(root, 'jobs.json');
  const stateFile = path.join(root, 'state.json');
  const lockFile = path.join(root, 'owner.lock');
  await mkdir(root, { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await open(lockFile, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Scheduler lock exists. If no scheduler is running, remove .s8-runtime/scheduler/owner.lock and retry.');
    throw error;
  }
  // ponytail: fail closed on stale locks rather than risk two schedulers; manually remove the lock after an unclean crash.
  await lock.writeFile(`${process.pid}\n`);
  const executeDue = async () => {
    const data = await readJson(jobsFile, { version: 1, jobs: [] });
    const state = await readJson(stateFile, { version: 1, jobs: {} });
    if (data.version !== 1 || !Array.isArray(data.jobs) || state.version !== 1 || !state.jobs) throw new Error('Invalid scheduler data.');
    const current = now();
    for (const entry of data.jobs) {
      if (!validId(entry.id) || typeof entry.enabled !== 'boolean') continue;
      const script = await readFile(path.join(scripts, `${entry.id}.sh`), 'utf8').catch(() => '');
      let job;
      try { job = validateJob({ ...entry, script }); } catch { continue; }
      const prior = state.jobs[job.id] ?? {};
      if (!isDue(job, current, prior.lastRunDate)) continue;
      const when = dueDate(job, current).date;
      const runId = randomUUID();
      const cancelFile = path.join(root, `${job.id}.cancel`);
      await rm(cancelFile, { force: true });
      state.jobs[job.id] = { ...prior, runId, lastRunDate: when, lastRunAt: current.toISOString(), result: 'running' };
      await writeJson(stateFile, state);
      const result = await runScript(path.join(scripts, `${job.id}.sh`), job, { cwd, bash, env, cancelFile, runId });
      await rm(cancelFile, { force: true });
      state.jobs[job.id] = { ...state.jobs[job.id], result: result.cancelled ? 'cancelled' : result.ok ? 'success' : 'failed', finishedAt: now().toISOString() };
      await writeJson(stateFile, state);
      const message = `예약 작업 ${job.id} (${job.time ?? `${job.intervalMinutes}분마다`}, ${job.timezone}) ${result.ok ? '완료' : '실패'}\n\n${result.output.trim() || '(출력 없음)'}`;
      try {
        if (!await sendTelegram(message, env, fetchImpl)) onResult(visible(message));
      } catch (error) {
        onResult(`${visible(message)}\n\nTelegram 알림 실패: ${error.message}`);
      }
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
    clearInterval(timer);
    stopPromise = (async () => {
      while (busy) await new Promise(resolve => setTimeout(resolve, 50));
      process.off('SIGINT', stopSignals);
      process.off('SIGTERM', stopSignals);
      await lock.close();
      await rm(lockFile, { force: true });
    })();
    return stopPromise;
  };
  const stopSignals = () => { void stop().finally(() => process.exit(0)); };
  process.once('SIGINT', stopSignals);
  process.once('SIGTERM', stopSignals);
  timer = setInterval(() => void tick(), 10_000);
  void tick();
  return stop;
}
