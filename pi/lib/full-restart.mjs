import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startPiRuntime } from './pi-runtime.mjs';
import { validSession } from './managed-sessions.mjs';
import { runTmux, stopWindow, withTmuxLock } from './tmux-windows.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

export async function runInfrastructure(root) {
  await new Promise((resolve, reject) => {
    const child = spawn('bash', [path.join(root, 'start-infra.sh')], { cwd: root, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Infrastructure restart timeout')); }, 600000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Infrastructure restart failed')); });
  });
}

export async function waitForInfrastructure({ fetchImpl = fetch, timeoutMs = 180000, env = process.env } = {}) {
  const targets = [
    ['frontend', 'http://127.0.0.1:4178/s8/', [200]],
    ['console', 'http://127.0.0.1:8791/api/projectman/session', [200, 401]],
    ['terminal', 'http://127.0.0.1:8790/api/terminal/health', [200]],
    ['router', `http://${env.NGINX_BIND_IP || '127.0.0.1'}:${env.NGINX_HTTP_PORT || 80}/health`, [200]],
  ];
  if (env.PHCMS_API_URL) targets.push(['projectman', `${env.PHCMS_API_URL.replace(/\/$/, '')}/projectman/capabilities`, [200]]);
  const deadline = Date.now() + timeoutMs;
  do {
    const ready = await Promise.all(targets.map(async ([name, url, statuses]) => {
      try { const response = await fetchImpl(url, { signal: AbortSignal.timeout(2000), ...(name === 'projectman' && env.PHCMS_ACCESS_TOKEN ? { headers: { authorization: `Bearer ${env.PHCMS_ACCESS_TOKEN}` } } : {}) }); await response.body?.cancel(); return statuses.includes(response.status); }
      catch { return false; }
    }));
    if (ready.every(Boolean)) return;
    if (Date.now() >= deadline) throw new Error('Infrastructure readiness timeout');
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (true);
}

export async function runFullRestart(root, options, directory, { run = runTmux, infra = runInfrastructure, ready = waitForInfrastructure, runtime = startPiRuntime } = {}) {
  root = await realpath(root);
  const session = options.session;
  if (!validSession(session)) throw new Error('Invalid restart session');
  const owner = (await run(['show-option', '-qv', '-t', session, '@s8-runtime-root'])).stdout.trim();
  if (owner !== root) throw new Error('Restart session belongs to another checkout');
  const lockName = 's8-full-restart-' + createHash('sha256').update(root).digest('hex');
  const lockFile = path.join(root, '.s8-runtime/runtime-restarts/all.lock');
  const handle = await withTmuxLock(run, lockName, async () => {
    try {
      const previous = JSON.parse(await readFile(lockFile, 'utf8'));
      if (!Number.isInteger(previous.pid) || previous.pid < 1 || alive(previous.pid)) throw new Error('An all-service restart is already running');
      await rm(lockFile);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const file = await open(lockFile, 'wx', 0o600);
    await file.writeFile(JSON.stringify({ pid: process.pid, directory }));
    return file;
  });
  let stage = 'stop-services';
  const progress = async value => { stage = value; await writeFile(path.join(directory, 'progress.json'), JSON.stringify({ stage, at: new Date().toISOString() }), { mode: 0o600 }); };
  try {
    await progress('stop-services');
    const { stdout } = await run(['list-windows', '-a', '-F', '#{session_name}\t#{window_name}\t#{@s8-window-root}']);
    const stopped = new Set();
    for (const line of stdout.trim().split('\n')) {
      const [host, name, checkout] = line.split('\t');
      if (checkout === root && ['scheduler', 'supervisor'].includes(name) && !stopped.has(name)) {
        await stopWindow(run, root, host, name); stopped.add(name);
      }
    }
    // Keep the current Telegram Pi alive until infra is ready, so failures can
    // be reported and retried without SSH. The runtime replaces Pi afterwards.
    await progress('infra'); await infra(root);
    await progress('infra-ready'); await ready();
    await progress('pi');
    const value = await runtime(root, { session, args: [], scheduler: true, supervisor: true, telegram: true });
    await progress('completed');
    return value;
  } catch {
    throw new Error(`전체 재시작 실패: ${stage}. 실행 기록에서 해당 단계를 확인하세요.`);
  } finally {
    await handle.close();
    await withTmuxLock(run, lockName, () => rm(lockFile, { force: true }));
  }
}

export async function notifyFullRestart(notification, text, { token = process.env.TELEGRAM_BOT_TOKEN, fetchImpl = fetch } = {}) {
  if (!notification || !token) return false;
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: notification.chat, ...(notification.thread === undefined ? {} : { message_thread_id: notification.thread }), text }), signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    return response.ok && data.ok === true;
  } catch { return false; }
}
