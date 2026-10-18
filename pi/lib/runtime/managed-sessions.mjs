import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
const exec = promisify(execFile);
export const validSession = name => typeof name === 'string' && /^s8-[A-Za-z0-9_-]{1,40}$/.test(name) && !name.includes('\n');
export async function listSessions() {
  let stdout;
  try { ({ stdout } = await exec('tmux', ['list-sessions', '-F', '#{session_name}\t#{@s8-managed}'], { timeout: 3000, maxBuffer: 65536 })); }
  catch (error) {
    if (/no server running|no sessions|error connecting/.test(error.stderr ?? '')) return [];
    throw error;
  }
  return stdout.trim().split('\n').map(line => line.split('\t'))
    .filter(([name, managed]) => managed === '1' && validSession(name)).map(([name]) => name);
}
export async function moveTelegram(socket) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const client = net.connect(socket);
        client.setTimeout(10000, () => client.destroy(new Error('Session control timeout')));
        client.on('connect', () => client.write('telegram'));
        client.on('error', reject);
        client.on('data', data => { client.end(); data.toString() === 'ok' ? resolve() : reject(new Error('Telegram activation failed')); });
      });
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  throw new Error('Pi session control is not ready');
}
