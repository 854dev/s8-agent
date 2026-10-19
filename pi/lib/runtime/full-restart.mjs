// 전체 재시작(/restart all): 공유 서비스 중지 → 인프라(start-infra.sh) 재시작 → 준비 확인 → Pi 런타임 교체.
// 진행 단계는 <directory>/progress.json에 기록해 실패 시 어느 단계에서 멈췄는지 확인할 수 있게 한다.
import { spawn } from 'node:child_process';
import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquirePidLock, waitUntil } from './process.mjs';
import { startPiRuntime, savedRuntimeOptions } from './runtime.mjs';
import { validSession } from './managed-sessions.mjs';
import { runTmux, stopWindow, sessionOption } from './tmux-windows.mjs';

/** start-infra.sh를 실행한다. 출력에 내부 정보가 있을 수 있어 버리고 성공 여부만 본다. */
export async function runInfrastructure(root) {
  await new Promise((resolve, reject) => {
    const child = spawn('bash', [path.join(root, 'start-infra.sh')], { cwd: root, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Infrastructure restart timeout')); }, 600000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Infrastructure restart failed')); });
  });
}

/** 모든 인프라 엔드포인트가 기대한 HTTP 상태를 돌려줄 때까지 0.5초 간격으로 확인한다. */
export async function waitForInfrastructure({ fetchImpl = fetch, timeoutMs = 180000, env = process.env } = {}) {
  // [이름, URL, 정상으로 볼 상태 코드]
  const targets = [
    ['frontend', 'http://127.0.0.1:4178/s8/', [200]],
    ['console', 'http://127.0.0.1:8791/api/projectman/session', [200, 401]],
    ['terminal', 'http://127.0.0.1:8790/api/terminal/health', [200]],
    ['router', `http://${env.S8_BIND_IP || '127.0.0.1'}:${env.S8_HTTP_PORT || 80}/health`, [200]],
  ];
  if (env.PHCMS_API_URL) targets.push(['projectman', `${env.PHCMS_API_URL.replace(/\/$/, '')}/projectman/capabilities`, [200]]);
  const check = async ([name, url, statuses]) => {
    const headers = name === 'projectman' && env.PHCMS_ACCESS_TOKEN ? { headers: { authorization: `Bearer ${env.PHCMS_ACCESS_TOKEN}` } } : {};
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(2000), ...headers });
      await response.body?.cancel();
      return statuses.includes(response.status);
    } catch { return false; }
  };
  const ready = await waitUntil(async () => (await Promise.all(targets.map(check))).every(Boolean), { timeoutMs, intervalMs: 500 });
  if (!ready) throw new Error('Infrastructure readiness timeout');
}

/**
 * 전체 재시작을 수행한다. local 모드 세션은 인프라 없이 Pi만 다시 시작한다.
 * 의존성(run, infra, ready, runtime)은 테스트에서 교체할 수 있다.
 */
export async function runFullRestart(root, { session, directory }, { run = runTmux, infra = runInfrastructure, ready = waitForInfrastructure, runtime = startPiRuntime } = {}) {
  root = await realpath(root);
  if (!validSession(session)) throw new Error('Invalid restart session');
  if (await sessionOption(run, session, '@s8-runtime-root') !== root) throw new Error('Restart session belongs to another checkout');
  // 현재 세션의 모드·작업 디렉터리·Telegram·Pi 인자를 그대로 이어서 다시 시작한다.
  const saved = await savedRuntimeOptions(session, { run });
  if (saved.mode === 'local') return runtime(root, saved);

  // 중복 실행 방지. 잠금 파일 둘째 줄에 실행 기록 디렉터리를 남긴다.
  const release = await acquirePidLock(path.join(root, '.s8-runtime/runtime-restarts/all.lock'), { extra: `${directory}\n` })
    .catch(error => { throw error.code === 'ELOCKED' ? new Error('An all-service restart is already running') : error; });

  let stage = 'stop-services';
  const progress = async value => {
    stage = value;
    await writeFile(path.join(directory, 'progress.json'), JSON.stringify({ stage, at: new Date().toISOString() }), { mode: 0o600 });
  };
  try {
    // 이 체크아웃 소유의 스케줄러 창을 세션과 관계없이 한 번씩 중지한다.
    await progress('stop-services');
    const { stdout } = await run(['list-windows', '-a', '-F', '#{session_name}\t#{window_name}\t#{@s8-window-root}']);
    const stopped = new Set();
    for (const [host, name, checkout] of stdout.trim().split('\n').map(line => line.split('\t'))) {
      if (checkout !== root || name !== 'scheduler' || stopped.has(name)) continue;
      await stopWindow(run, root, host, name);
      stopped.add(name);
    }
    // 인프라가 준비될 때까지 현재 Telegram Pi를 유지해, 실패해도 SSH 없이 보고·재시도할 수 있게 한다.
    await progress('infra'); await infra(root);
    await progress('infra-ready'); await ready();
    await progress('pi');
    const value = await runtime(root, saved);
    await progress('completed');
    return value;
  } catch {
    // 원본 오류에는 인프라 내부 출력이 들어 있을 수 있어 단계 이름만 알린다.
    throw new Error(`전체 재시작 실패: ${stage}. 실행 기록에서 해당 단계를 확인하세요.`);
  } finally { await release(); }
}

/** 재시작을 요청한 Telegram 채팅(주제 포함)에 결과를 보낸다. 실패해도 예외 없이 false를 돌려준다. */
export async function notifyFullRestart(notification, text, { token = process.env.TELEGRAM_BOT_TOKEN, fetchImpl = fetch } = {}) {
  if (!notification || !token) return false;
  const body = { chat_id: notification.chat, ...(notification.thread === undefined ? {} : { message_thread_id: notification.thread }), text };
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    return response.ok && data.ok === true;
  } catch { return false; }
}
