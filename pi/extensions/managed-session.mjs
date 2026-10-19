import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { chmodSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { attach } from './telegram.mjs';
import { validSession } from '../lib/runtime/managed-sessions.mjs';

const tmux = (...args) => execFileSync('tmux', args, { encoding: 'utf8' }).trim();

// S8 관리 세션(tmux s8-*)의 Pi 창에서만 로드된다. 세션 옵션의 Telegram 설정을 따르고,
// 런타임이 Telegram 연결을 옮길 수 있도록 .pi-runtime/<세션>.sock 제어 소켓을 연다.
export default function (pi) {
  const session = tmux('display-message', '-p', '#S');
  const mode = tmux('show-option', '-qv', '@s8-mode') || 'project';
  const autoStart = tmux('show-option', '-qv', '-t', session, '@s8-telegram') === 'take';
  const activate = attach(pi, { autoStart, mode, session, persist: enabled => tmux('set-option', '-t', session, '@s8-telegram', enabled ? 'take' : 'off') });
  let server, socket;
  const stop = async () => {
    if (!server) return;
    const closing = server;
    server = undefined;
    await new Promise(resolve => closing.close(resolve));
    try { unlinkSync(socket); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode !== 'tui' || !process.env.TMUX || !process.env.S8_PI_RESTART_DIR) return;
    await stop();
    if (!validSession(session)) return;
    socket = path.join(process.env.S8_PI_RESTART_DIR, `${session}.sock`);
    // 강제 종료된 Pi가 남긴 소켓은 지운다. 세션 이름은 tmux에서 유일하다.
    try { unlinkSync(socket); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    server = net.createServer(client => {
      client.setTimeout(10000, () => client.destroy());
      client.once('data', async data => {
        try {
          if (data.toString() !== 'telegram') throw new Error('Unknown command');
          await activate.control('take');
          client.end('ok');
        } catch { client.end('error'); }
      });
    });
    server.on('error', error => { ctx.ui.notify(`세션 제어 연결 실패: ${error.code}`, 'error'); });
    server.listen(socket, () => chmodSync(socket, 0o600));
  });
  pi.on('session_shutdown', stop);
}
