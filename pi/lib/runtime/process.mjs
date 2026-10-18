import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { PiOutput } from './output.mjs';

// Linux keeps GNU timeout as an independent deadline owner.
// ponytail: macOS uses the Pi parent timer; add a detached watchdog if forced parent crashes leave orphaned children.
export async function runBoundedProcess(binary, args, cwd, maxMs, signal, keepTail = false, piJson = false) {
  if (!['linux', 'darwin'].includes(process.platform) || !Number.isFinite(maxMs) || maxMs <= 0 || signal.aborted) {
    return { status: 'stopped', output: '' };
  }
  const env = { ...process.env };
  delete env.PHCMS_ACCESS_TOKEN;
  delete env.PHCMS_API_URL;
  const linux = process.platform === 'linux';
  const child = spawn(linux ? '/usr/bin/timeout' : binary,
    linux ? ['--signal=TERM', '--kill-after=2s', `${Math.max(1, Math.ceil(maxMs / 1000))}s`, binary, ...args] : args,
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let status;
  let forceKill;
  let output = '';
  const killGroup = sig => { if (child.pid) { try { process.kill(-child.pid, sig); } catch (error) { if (error?.code !== 'ESRCH') throw error; } } };
  const stop = reason => {
    if (status) return;
    status = reason;
    killGroup('SIGTERM');
    forceKill = setTimeout(() => killGroup('SIGKILL'), 2000);
  };
  const timer = setTimeout(() => stop('timeout'), maxMs);
  const onAbort = () => stop('stopped');
  const onExit = () => { killGroup('SIGKILL'); };
  signal.addEventListener('abort', onAbort, { once: true });
  process.once('exit', onExit);
  const decoder = new StringDecoder('utf8');
  const events = piJson ? new PiOutput(cwd) : undefined;
  child.stdout?.on('data', chunk => {
    const text = decoder.write(chunk);
    if (events) events.write(text);
    else { const next = output + text; output = keepTail ? next.slice(-10000) : next.slice(0, 10000); }
  });
  child.stderr?.resume(); // Never persist diagnostics: they may contain credentials.
  try {
    return await new Promise(resolve => {
      child.once('error', () => resolve({ status: 'failed', output: '' }));
      child.once('close', code => {
        const finished = status ?? (linux && (code === 124 || code === 137) ? 'timeout' : code !== 0 ? 'failed' : events ? events.reason === 'length' ? 'timeout' : events.complete ? 'completed' : 'failed' : 'completed');
        resolve({ status: finished, output: events ? finished === 'completed' ? events.text : events.checkpoint : output, ...(events ? { stopReason: events.reason } : {}) });
      });
    });
  } finally {
    clearTimeout(timer);
    if (forceKill) clearTimeout(forceKill);
    signal.removeEventListener('abort', onAbort);
    process.removeListener('exit', onExit);
    // A child can outlive timeout if it ignores TERM; kill its process group.
    killGroup('SIGKILL');
  }
}
