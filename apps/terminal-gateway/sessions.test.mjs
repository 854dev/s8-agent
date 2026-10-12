import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('host shell creation is shared, survives reuse, and refuses an unowned name collision', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 's8-shell-test-'));
  const socket = `s8-shell-test-${process.pid}`;
  const tmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
  await writeFile(path.join(dir, 'tmux'), `#!/bin/sh\nexec '${tmux}' -L '${socket}' "$@"\n`, { mode: 0o755 });
  t.after(async () => {
    try { execFileSync(tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch {}
    await rm(dir, { recursive: true, force: true });
  });
  const code = `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { ensureShell, listTerminalSessions, SHELL_SESSION } from ${JSON.stringify(new URL('./sessions.mjs', import.meta.url).href)};
    assert.deepEqual(await Promise.all([ensureShell(), ensureShell()]), [SHELL_SESSION, SHELL_SESSION]);
    assert.equal(await ensureShell(), SHELL_SESSION);
    assert.deepEqual(await listTerminalSessions(), [SHELL_SESSION]);
    execFileSync('tmux', ['kill-session', '-t', '=' + SHELL_SESSION]);
    assert.equal(await ensureShell(), SHELL_SESSION);
    execFileSync('tmux', ['kill-session', '-t', '=' + SHELL_SESSION]);
    execFileSync('tmux', ['new-session', '-d', '-s', SHELL_SESSION]);
    await assert.rejects(ensureShell());
    assert.deepEqual(await listTerminalSessions(), []);
  `;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, SHELL: '/bin/sh', TMUX: '' },
    stdio: 'pipe', timeout: 15000,
  }));
});
