// 단일 에이전트 실행기. 모드 프로필로 Pi 실행 인자를 만들고 이 터미널에서 Pi를 실행한다.
// tmux·서비스·워커 풀은 다루지 않는다(pi/bin/s8.mjs 담당).
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { access, chmod, constants, lstat, mkdir, readlink, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { MODES, loadProfile, resolveMode } from './profile.mjs';
import { applyS8Config } from '../config/s8-config.mjs';

/** 사용법 오류. 진입점이 종료 코드 2로 끝낸다. */
export const usageError = message => Object.assign(new Error(message), { exitCode: 2 });

const PACKAGE_COMMANDS = new Set(['install', 'remove', 'uninstall', 'update', 'list', 'config']);
export const isPackageCommand = arg => PACKAGE_COMMANDS.has(arg);

/**
 * 루트 .env의 비밀값을 환경변수로 불러오고, s8-config.yml의 설정을 내부 환경변수로 넘긴다(설정 파일이 우선).
 * .env는 ~·$VAR 확장 등 셸 문법을 그대로 지원하도록 bash로 읽는다.
 * 값은 출력하지 않으며, 읽기 실패 시에도 bash 오류 출력(값 일부가 섞일 수 있음)을 그대로 내보내지 않는다.
 */
export function loadEnv(root) {
  const file = path.join(root, '.env');
  if (existsSync(file)) loadSecrets(file);
  applyS8Config(root);
}

function loadSecrets(file) {
  let output;
  try { output = execFileSync('bash', ['-c', 'set -a; source "$1" >/dev/null 2>&1 || exit 1; env -0', 'bash', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { throw new Error('.env를 읽지 못했습니다. 셸 문법을 확인하세요.'); }
  for (const entry of output.split('\0')) {
    const index = entry.indexOf('=');
    const name = entry.slice(0, index);
    // bash가 스스로 정하는 변수는 옮기지 않는다.
    if (index > 0 && !['_', 'SHLVL', 'PWD', 'OLDPWD'].includes(name)) process.env[name] = entry.slice(index + 1);
  }
}

/** KB 저장소 경로(s8-config.yml의 kbRoot, 기본 ../854_md). loadEnv가 S8_KB_ROOT로 넘긴다. */
export async function kbRoot(root) {
  const directory = path.resolve(root, process.env.S8_KB_ROOT || '../854_md');
  try { return await realpath(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(`KB 저장소를 찾을 수 없습니다: ${directory}. s8-config.yml의 kbRoot를 이 장비의 KB 경로로 설정하세요.`);
  }
}

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

/**
 * 사용자가 넘긴 Pi 옵션을 검사한다. 임의 도구·확장·세션 파일·@파일 첨부·프롬프트 인자로
 * 역할 경계를 바꾸지 못하도록 허용 목록만 통과시킨다.
 */
export function validatePiOptions(input) {
  const flags = new Set(['--continue', '--print', '--no-session', '--version']);
  const values = new Set(['--model', '--provider', '--thinking']);
  for (let i = 0; i < input.length; i++) {
    const arg = input[i];
    if (flags.has(arg)) continue;
    if (values.has(arg) && input[i + 1] && !/^[-@]/.test(input[i + 1])) { i++; continue; }
    throw new Error(`Unsupported agent argument: ${arg}. Use the interactive prompt for requests.`);
  }
  return input;
}

/**
 * 프로필과 실행 옵션으로 Pi 실행 인자를 만든다. 자동 발견을 끄고 프로필의 확장·스킬만 로드한다.
 * control: tmux 런타임 창에서 실행(세션 제어 확장이 Telegram을 맡는다). telegram: 단독 실행에서 Telegram 연결.
 */
export function piArgs(root, profile, { sessionDir, telegram = false, control = false } = {}) {
  const extensions = [...profile.extensions];
  if (control) extensions.push(path.join(root, 'pi/extensions/managed-session.mjs'));
  else if (telegram) extensions.push(path.join(root, 'pi/extensions/telegram.mjs'));
  return [
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
    ...extensions.flatMap(file => ['--extension', file]),
    ...profile.skills.flatMap(directory => ['--skill', directory]),
    '--system-prompt', profile.systemPrompt,
    '--tools', profile.tools.join(','),
    ...(sessionDir ? ['--session-dir', sessionDir] : []),
  ];
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
 * 에이전트를 이 터미널에서 실행하고 종료 코드를 돌려준다.
 * Pi가 .pi-runtime/restart-<이 프로세스 PID> 파일을 남기고 종료하면(/restart) 최근 대화로 다시 시작한다.
 */
export async function runAgent(root, { mode, cwd = process.cwd(), telegram = false, control = false, sessionDir, uid, args = [] }) {
  const resolved = resolveMode(mode);
  if (!resolved) throw usageError(`모드는 ${MODES.join(', ')} 중 하나여야 합니다: ${mode}`);
  if (uid !== undefined && resolved !== 'worker') throw usageError('--uid는 worker 모드에서만 사용합니다.');
  if (uid !== undefined && !/^[\w-]{1,100}$/.test(uid)) throw usageError(`잘못된 UID입니다: ${uid}`);
  const profile = loadProfile(resolved, root);
  if (profile.loadEnv || telegram || control) loadEnv(root);
  const workDir = profile.workDir === 'kb' ? await kbRoot(root) : await realpath(cwd);
  const { configRoot, agentDir, binary } = await preparePiEnvironment(root);
  await linkSharedSettings(agentDir, configRoot);
  if (sessionDir && path.relative(agentDir, path.resolve(sessionDir)).startsWith('..')) throw usageError('--session-dir는 .pi-runtime 아래여야 합니다.');
  Object.assign(process.env, { PI_TELEMETRY: '0', S8_PI_RESTART_DIR: agentDir, S8_AGENT_MODE: resolved });
  if (uid) process.env.S8_WORKER_UID = uid;
  process.chdir(workDir);
  // 패키지 관리 명령은 Pi CLI에 그대로 전달한다.
  if (isPackageCommand(args[0])) return startChild(binary, args).exited;
  validatePiOptions(args);

  // 종료 신호를 받으면 Pi를 SIGTERM으로 정상 종료시키고 0으로 끝낸다.
  let current, stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { stopping = true; current?.kill('SIGTERM'); });
  const restartFile = path.join(agentDir, `restart-${process.pid}`);
  const base = piArgs(root, profile, { sessionDir, telegram, control });
  // --uid가 있으면 첫 실행에 작업 지시를 넣는다. /restart 재개(--continue)에는 다시 넣지 않는다.
  let extra = uid ? [`uid ${uid} 의 업무를 수행해라.`] : [];
  while (true) {
    const { child, exited } = startChild(binary, [...base, ...args, ...extra]);
    current = child;
    const status = await exited;
    if (stopping) return 0;
    if (!existsSync(restartFile)) return status;
    await rm(restartFile, { force: true });
    extra = ['--continue'];
  }
}
