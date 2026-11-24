// child_process.execFile의 timeout은 자식이 SIGTERM을 무시하면 강제로 끝내지 못해
// 프로미스가 영원히 settle되지 않는다. tmux처럼 드물게 멈추는 자식을 띄우는 테스트에서
// 스위트가 통째로 걸리는 것을 막기 위해, 시간이 지나면 SIGTERM 후 SIGKILL로 확정 종료하고
// 항상 일정 시간 안에 resolve/reject하는 실행 헬퍼다. 반환 모양은 execFile과 같다.
import { spawn } from 'node:child_process';
import path from 'node:path';

export function runBounded(cmd, args, { timeoutMs = 5000, killGraceMs = 1000, env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });

    let settled = false;
    let timeout = null;
    let graceTimer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(graceTimer);
      fn(value);
    };

    timeout = setTimeout(() => {
      child.kill('SIGTERM');
      graceTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    }, timeoutMs);

    child.once('error', error => finish(reject, error));
    child.once('close', (code, signal) => {
      if (signal === 'SIGKILL' || signal === 'SIGTERM' || (code !== 0 && code !== null)) {
        const error = new Error(`${cmd} exited with ${signal ? `signal ${signal}` : `code ${code}`}`);
        error.code = code;
        error.signal = signal;
        error.killed = signal === 'SIGKILL';
        finish(reject, error);
      } else {
        finish(resolve, { stdout, stderr });
      }
    });
  });
}

/** running tmux 서버의 소켓 파일 경로를 돌려준다. kill-server는 소켓 파일을 남기므로 정리할 때 unlink한다. */
let socketDir = null;
export async function tmuxSocketPath(run, socket) {
  try {
    const resolved = (await run(['display-message', '-p', '#{socket_path}'])).stdout.trim();
    socketDir = path.dirname(resolved);
    return resolved;
  } catch {
    // 서버가 이미 스스로 꺼진 경우(kill-session이 마지막 세션을 닫는 경우)에는 조회가 실패하므로
    // 이전에 알아낸 디렉터리와 소켓 이름으로 경로를 재구성한다.
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    return path.join(socketDir ?? path.join('/tmp', `tmux-${uid}`), socket);
  }
}