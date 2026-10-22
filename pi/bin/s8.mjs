// s8.sh의 진입점: tmux 런타임·예약 데몬·작업 워커 실행. 에이전트 실행 자체는 start-*-agent.sh(pi/bin/agent.mjs)가 맡는다.
//   work UID              승인된 작업의 워커를 s8-workers 세션 창에 실행(lib/agent/work.mjs)
//   finish UID --run-id UUID --confirm-stopped   멈춘 실행을 실패로 보고해 마무리(lib/agent/finish.mjs)
//   service scheduler     예약 데몬을 이 프로세스에서 실행(tmux 서비스 창, 수동 진단)
//   service worker ID     상주 워커 루프를 이 프로세스에서 실행(s8-workers:worker-ID 창, lib/agent/resident.mjs)
//   그 밖                 런타임 시작: 옵션 해석·선택 메뉴·tmux 런타임 (재)시작(user-command.mjs)
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv, kbRoot, preparePiEnvironment, usageError } from '../lib/agent/launch.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

async function runScheduler(args) {
  if (args.length) throw usageError('스케줄러는 추가 인자를 받지 않습니다.');
  // 예약 작업은 KB 저장소에서 Pi를 실행하므로 Pi 경로와 작업 디렉터리를 준비한다.
  loadEnv(root);
  process.env.S8_KB_ROOT = await kbRoot(root);
  await preparePiEnvironment(root);
  process.chdir(process.env.S8_KB_ROOT);
  const script = path.join(root, 'pi/bin/scheduler.mjs');
  process.argv.splice(1, Infinity, script);
  await import(pathToFileURL(script).href);
}

async function runResident(args) {
  if (args.length !== 1) throw usageError('사용법: ./s8.sh service worker ID');
  loadEnv(root);
  const [{ loadS8Config }, resident, { startWork, WORK_SESSION }, { windows, runTmux }, { acquirePidLock }, { projectmanFromEnv }] = await Promise.all([
    import('../lib/config/s8-config.mjs'), import('../lib/agent/resident.mjs'), import('../lib/agent/work.mjs'),
    import('../lib/runtime/tmux-windows.mjs'), import('../lib/runtime/process.mjs'), import('../lib/projectman/client.ts'),
  ]);
  const config = loadS8Config(root);
  const worker = config.workers.find(item => item.id === args[0]);
  if (!worker) throw usageError(`s8-config.yml의 workers에 없는 워커입니다: ${args[0]}`);
  const lock = resident.residentLockFile(root, worker.id);
  await mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
  const release = await acquirePidLock(lock);
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => controller.abort());
  // Projectman 연결 설정이 없으면 지시도 ready 작업도 다룰 수 없으므로 시작하지 않는다.
  try {
    const client = projectmanFromEnv();
    await resident.runResidentWorker(root, worker, {
      client,
      start: uid => startWork(root, uid, { client, workerId: worker.id }),
      taskAlive: async uid => (await windows(runTmux, WORK_SESSION).catch(() => [])).some(window => window.name === uid && !window.dead),
    }, { signal: controller.signal });
  } finally { await release(); }
}

async function runCommunicator(args) {
  if (args.length) throw usageError('사용법: ./s8.sh service communicator');
  // Credentials live in an explicit private file; this service does not need .env.
  const [{ loadS8Config }, { runCommunicator }, { acquirePidLock }] = await Promise.all([
    import('../lib/config/s8-config.mjs'), import('../lib/communication/service.mjs'), import('../lib/runtime/process.mjs'),
  ]);
  const config = loadS8Config(root).communication;
  if (!config.enabled || !config.server) throw usageError('communication.enabled와 server 설정이 필요합니다.');
  const lock = path.join(root, '.s8-runtime/communication/owner.lock');
  await mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
  const release = await acquirePidLock(lock);
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => controller.abort());
  let close;
  try {
    close = await runCommunicator(root, config, { log: event => console.log(JSON.stringify(event)) });
    console.log(`매니저 통신 서버 시작: ${config.server.bindIp}:${config.server.port}`);
    if (!controller.signal.aborted) await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
  } finally { await close?.(); await release(); }
}

async function runWork([uid, ...rest]) {
  if (!uid || rest.length) throw usageError('사용법: ./s8.sh work UID');
  loadEnv(root);
  const { startWork } = await import('../lib/agent/work.mjs');
  const result = await startWork(root, uid);
  console.log(result.running ? `이미 실행 중: ${result.target}` : `워커 ${result.resumed ? '재개' : '시작'}: ${result.target} (${result.worktree})`);
  console.log(`접속: tmux attach-session -t ${result.target}`);
}

async function runFinish(args) {
  const [uid, flag, runId, confirm] = args;
  if (args.length !== 4 || flag !== '--run-id' || confirm !== '--confirm-stopped') throw usageError('사용법: ./s8.sh finish UID --run-id UUID --confirm-stopped');
  loadEnv(root);
  const [{ finishStoppedRun }, { projectmanFromEnv }] = await Promise.all([import('../lib/agent/finish.mjs'), import('../lib/projectman/client.ts')]);
  const result = await finishStoppedRun({ root, client: projectmanFromEnv(), uid, runId, confirmed: true });
  console.log(result.status === 'already-finished' ? `이미 끝난 실행입니다: ${uid} (${result.state})` : `실패로 마무리했습니다: ${uid} → ${result.state}`);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'work') await runWork(args);
  else if (command === 'finish') await runFinish(args);
  else if (command === 'service') {
    if (args[0] === 'scheduler') await runScheduler(args.slice(1));
    else if (args[0] === 'worker') await runResident(args.slice(1));
    else if (args[0] === 'communicator') await runCommunicator(args.slice(1));
    else throw usageError('서비스는 scheduler, worker ID, communicator입니다.');
  } else if (command === 'workers') {
    if (args.length) throw usageError('사용법: ./s8.sh workers');
    const { startResidentWorkers } = await import('../lib/runtime/services.mjs');
    console.log(JSON.stringify(await startResidentWorkers(root)));
  } else {
    // 런타임 제어 모듈은 사용자 실행에서만 불러온다(서비스 시작을 가볍게 유지).
    const { runUserCommand } = await import('../lib/runtime/user-command.mjs');
    await runUserCommand(root, process.argv.slice(2));
  }
} catch (error) {
  console.error(`[S8] ${error.message}`);
  process.exitCode = error.exitCode ?? 1;
}
