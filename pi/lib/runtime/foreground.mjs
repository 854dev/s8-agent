// Pi 전경 실행 준비와 실행. start-pi.sh(→ pi/bin/start.mjs)의 --managed·--foreground·--service가 사용한다.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { access, chmod, constants, lstat, mkdir, readlink, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { managerArgs } from '../manager/launch.mjs';
import { validSession } from './managed-sessions.mjs';

/** 사용법 오류. 진입점이 종료 코드 2로 끝낸다. */
export const usageError = message => Object.assign(new Error(message), { exitCode: 2 });

const PACKAGE_COMMANDS = new Set(['install', 'remove', 'uninstall', 'update', 'list', 'config']);
export const isPackageCommand = arg => PACKAGE_COMMANDS.has(arg);

/** 루트 .env의 연결 설정을 환경변수로 덮어쓴다(셸 source와 같은 우선순위). 내용은 출력하지 않는다. */
export function loadEnv(root) {
  const file = path.join(root, '.env');
  if (existsSync(file)) Object.assign(process.env, parseEnv(readFileSync(file, 'utf8')));
}

/** KB 저장소 경로(S8_KB_ROOT, 기본 ../854_md). 상대 경로는 저장소 루트 기준이다. */
export const kbRoot = root => realpath(path.resolve(root, process.env.S8_KB_ROOT || '../854_md'));

/** Pi 실행에 필요한 경로를 확인하고 공용 환경변수를 설정한다. */
export async function preparePiEnvironment(root) {
  const configRoot = path.join(root, 'pi');
  const agentDir = path.join(root, '.pi-runtime');
  const binary = path.join(configRoot, 'node_modules/.bin/pi');
  try { await access(binary, constants.X_OK); }
  catch { throw new Error('Pi가 설치되지 않았습니다. npm ci --ignore-scripts --prefix pi를 실행하세요.'); }
  Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, S8_PI_BINARY: binary, S8_PI_CONFIG_ROOT: configRoot });
  return { configRoot, agentDir, binary };
}

/** 인증·세션은 장비별 비공개 경로(.pi-runtime)에 두고 공용 설정 파일만 링크한다. 다른 파일이 있으면 덮어쓰지 않는다. */
async function linkSharedSettings(agentDir, configRoot) {
  await mkdir(agentDir, { recursive: true });
  await chmod(agentDir, 0o700);
  const link = path.join(agentDir, 'settings.json'), target = path.join(configRoot, 'settings.json');
  let stat;
  try { stat = await lstat(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!stat) return symlink(target, link);
  if (!stat.isSymbolicLink()) throw new Error('런타임 설정 파일이 이미 있습니다. 덮어쓰지 않습니다.');
  if (await readlink(link) !== target) throw new Error('런타임 설정 링크가 공유 설정을 가리키지 않습니다.');
}

const tmux = (...args) => execFileSync('tmux', args, { encoding: 'utf8' }).trim();

/** 모드·관리 세션·Telegram 여부에 맞는 Pi 실행 인자. 자동 발견을 끄고 검토된 확장만 로드한다. */
function piArgs(root, { managed, mode, cwd, telegram }) {
  const configRoot = path.join(root, 'pi'), agentDir = path.join(root, '.pi-runtime');
  const args = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
    '--extension', path.join(configRoot, 'extensions', mode === 'project' ? 'manager.ts' : 'local.mjs')];
  if (managed) {
    // 관리 세션은 세션별(local 모드는 작업 디렉터리별) 대화 디렉터리와 세션 제어 확장을 쓴다.
    const session = tmux('display-message', '-p', '#S');
    if (!validSession(session)) throw new Error('관리 세션에서만 실행할 수 있습니다.');
    const sessionDir = mode === 'local'
      ? path.join(agentDir, 'local', session, createHash('sha256').update(cwd).digest('hex').slice(0, 16))
      : path.join(agentDir, 'managed', session);
    args.push('--session-dir', sessionDir, '--extension', path.join(configRoot, 'extensions/managed-session.mjs'));
  } else if (telegram) args.push('--extension', path.join(configRoot, 'extensions/telegram.mjs'));
  if (mode === 'project') args.push('--system-prompt', path.join(root, 'agents/manager/SYSTEM.md'), '--tools', 'projectman,kb,scheduler,read,bash,edit,write,grep,find,ls');
  else args.push('--system-prompt', path.join(root, 'agents/local/SYSTEM.md'), '--tools', 'read,bash,edit,write,grep,find,ls');
  return args;
}

/** 터미널을 물려받은 자식 프로세스를 실행한다. exited는 종료 코드(신호 종료는 셸처럼 128+번호)로 끝난다. */
function startChild(command, args) {
  const child = spawn(command, args, { stdio: 'inherit' });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? 128 + os.constants.signals[signal]));
  });
  return { child, exited };
}

/**
 * Pi를 이 터미널에서 실행하고 종료 코드를 돌려준다.
 * managed: 런타임 tmux 창 안에서 실행. 매 실행마다 세션 옵션의 Telegram 설정을 다시 읽는다.
 * Pi가 .pi-runtime/restart-<이 프로세스 PID> 파일을 남기고 종료하면(/restart) 최근 대화로 다시 시작한다.
 */
export async function runPi(root, { managed = false, mode, cwd, telegram, args = [] }) {
  if (mode === 'project' || telegram || managed) loadEnv(root);
  const workDir = mode === 'project' ? await kbRoot(root) : await realpath(cwd);
  const { configRoot, agentDir, binary } = await preparePiEnvironment(root);
  await linkSharedSettings(agentDir, configRoot);
  Object.assign(process.env, { PI_TELEMETRY: '0', S8_PI_RESTART_DIR: agentDir });
  process.chdir(workDir);
  // 패키지 관리 명령은 Pi CLI에 그대로 전달한다.
  if (isPackageCommand(args[0])) return startChild(binary, args).exited;
  // 임의 도구·확장·세션 파일 인자로 관리 역할 경계를 바꾸지 못하게 검사한다.
  managerArgs(root, args);

  // 종료 신호를 받으면 Pi를 SIGTERM으로 정상 종료시키고 0으로 끝낸다.
  let current, stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { stopping = true; current?.kill('SIGTERM'); });
  const restartFile = path.join(agentDir, `restart-${process.pid}`);
  let extra = [];
  while (true) {
    if (managed) telegram = tmux('show-option', '-qv', '@s8-telegram') === 'take';
    const { child, exited } = startChild(binary, [...piArgs(root, { managed, mode, cwd: workDir, telegram }), ...extra, ...args]);
    current = child;
    const status = await exited;
    if (stopping) return 0;
    if (!existsSync(restartFile)) return status;
    await rm(restartFile, { force: true });
    extra = ['--continue'];
  }
}
