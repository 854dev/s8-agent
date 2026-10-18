import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { chmodSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { attach } from './telegram.mjs';

export default function (pi) {
  const mode = execFileSync('tmux', ['show-option', '-qv', '@s8-mode'], { encoding: 'utf8' }).trim() || 'project';
  const session = execFileSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf8' }).trim();
  const autoStart = execFileSync('tmux', ['show-option', '-qv', '-t', session, '@s8-telegram'], { encoding: 'utf8' }).trim() === 'take';
  const activate = attach(pi, { autoStart, mode, session, persist: enabled => {
    execFileSync('tmux', ['set-option', '-t', session, '@s8-telegram', enabled ? 'take' : 'off']);
  } });
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
    const name = execFileSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf8' }).trim();
    if (!/^s8-[A-Za-z0-9_-]{1,40}$/.test(name)) return;
    socket = path.join(process.env.S8_PI_RESTART_DIR, `${name}.sock`);
    // A killed Pi can leave its socket behind; tmux owns this unique session name.
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
