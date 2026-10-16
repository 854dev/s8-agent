import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, open, rm, realpath } from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const definitions = {
  scheduler: { session: 's8-scheduler', lock: '.s8-runtime/scheduler/owner.lock' },
  supervisor: { session: 's8-development-supervisor', lock: '.s8-runtime/services/supervisor.lock' },
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
async function ownerPid(file) {
  try { const value = (await readFile(file, 'utf8')).split('\n')[0]; if (!/^[1-9]\d*$/.test(value)) throw new Error('잘못된 서비스 잠금 파일입니다.'); return Number(value); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** 서비스는 매니저 세션과 독립적으로 유지하고, 같은 저장소의 실행을 재사용한다. */
export async function startPiServices(root, { scheduler = true, supervisor = true, run = (args => exec('tmux', args, { timeout: 5000, maxBuffer: 65536 })) } = {}) {
  root = await realpath(root);
  const results = [];
  for (const [name, enabled] of Object.entries({ scheduler, supervisor })) {
    if (!enabled) continue;
    const service = definitions[name], target = `=${service.session}`;
    const pid = await ownerPid(path.join(root, service.lock));
    if (pid && alive(pid)) { results.push({ service: name, reused: true, pid }); continue; }
    const exists = async () => { try { await run(['has-session', '-t', target]); return true; } catch { return false; } };
    let reused = await exists();
    if (!reused) {
      if (pid) throw new Error(`${name}의 종료된 프로세스 잠금이 남아 있습니다. 실행 여부를 확인한 뒤 ${service.lock}를 정리하세요.`);
      try {
        // tmux 명령 목록에서 생성과 소유 저장소 표시를 함께 반영한다.
        await run(['new-session', '-d', '-s', service.session, '-c', root, `exec bash ${quote(path.join(root, 'start-pi.sh'))} --service ${name}`, ';', 'set-option', '-t', service.session, '@s8-service-root', root]);
      } catch {
        if (!await exists()) throw new Error(`${name}를 시작하지 못했습니다. tmux 설치와 서비스 설정을 확인하세요.`);
        reused = true;
      }
    }
    const marker = (await run(['show-option', '-t', service.session, '-qv', '@s8-service-root'])).stdout.trim();
    if (marker !== root) {
      // 이전 버전에서 직접 띄운 같은 저장소의 서비스 세션도 그대로 인계한다.
      const cwd = (await run(['display-message', '-p', '-t', `${service.session}:0.0`, '#{pane_current_path}'])).stdout.trim();
      if (marker || cwd !== root) throw new Error(`${service.session}은 다른 작업 경로의 세션입니다. 자동으로 변경하지 않습니다.`);
      await run(['set-option', '-t', service.session, '@s8-service-root', root]);
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    if (!await exists()) throw new Error(`${name}가 시작 직후 종료됐습니다. --service 옵션으로 오류를 확인하거나 --no-${name}로 제외하세요.`);
    results.push({ service: name, session: service.session, reused });
  }
  return results;
}

/** 별도로 실행한 슈퍼바이저와 통합 실행의 중복도 같은 PID 잠금으로 차단한다. */
export async function supervisorOwner(root) {
  const directory = path.join(root, '.s8-runtime/services');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'supervisor.lock');
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(`${process.pid}\n`); }
  catch (error) { await handle.close(); await rm(file, { force: true }); throw error; }
  return async () => { await handle.close(); await rm(file, { force: true }); };
}
