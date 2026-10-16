import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validTerminalSession } from './sessions.mjs';

test('terminal session names allow host services and reject window/pane targets and control characters', () => {
  for (const name of ['phcms', 's8-host-shell', 's8-scheduler', 's8-development-supervisor', '호스트 셸', '-service', 'a'.repeat(80)]) assert.equal(validTerminalSession(name), true);
  for (const name of [null, undefined, '', 'phcms:0', 'phcms.0', 'phcms\nother', 'phcms\n', 'phcms\tother', '\x00', '\x7f']) assert.equal(validTerminalSession(name), false);
});

test('host terminal lists all service sessions and reuses an existing shell without changing ownership', async t => {
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
    const services = ['phcms', 's8-scheduler', 's8-development-supervisor', 'pi-854-md', '호스트 셸'];
    for (const name of services) execFileSync('tmux', ['new-session', '-d', '-s', name]);
    execFileSync('tmux', ['new-session', '-d', '-s', 's8-main']);
    execFileSync('tmux', ['set-option', '-t', 's8-main', '@s8-managed', '1']);
    const sessions = await listTerminalSessions();
    assert.equal(sessions[0], SHELL_SESSION);
    assert.deepEqual(sessions.slice(1).sort(), [...services, 's8-main'].sort());
    execFileSync('tmux', ['kill-session', '-t', '=' + SHELL_SESSION]);
    assert.equal(await ensureShell(), SHELL_SESSION);
    execFileSync('tmux', ['kill-session', '-t', '=' + SHELL_SESSION]);
    execFileSync('tmux', ['new-session', '-d', '-s', SHELL_SESSION]);
    const before = execFileSync('tmux', ['display-message', '-p', '-t', '=' + SHELL_SESSION, '#{pane_id}'], { encoding: 'utf8' });
    assert.equal(await ensureShell(), SHELL_SESSION);
    assert.equal(execFileSync('tmux', ['display-message', '-p', '-t', '=' + SHELL_SESSION, '#{pane_id}'], { encoding: 'utf8' }), before);
    assert.equal(execFileSync('tmux', ['show-option', '-qv', '-t', SHELL_SESSION, '@s8-shell'], { encoding: 'utf8' }), '');
    assert.equal((await listTerminalSessions())[0], SHELL_SESSION);
  `;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, SHELL: '/bin/sh', TMUX: '' },
    stdio: 'pipe', timeout: 15000,
  }));
});
