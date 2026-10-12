import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('launcher lists managed sessions and reuses an existing session without restarting Pi', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 's8-launcher-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls');
  await writeFile(path.join(dir, 'tmux'), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  list-sessions) printf 's8-main\\t1\\nother\\t1\\ns8-unmanaged\\t\\n';;
  has-session) test -f '${dir}/created';;
  new-session) touch '${dir}/created';;
  set-option|show-option)
    case "$3" in =*) exit 1;; esac
    if [ "$1" = show-option ]; then printf '1'; fi;;
esac
`, { mode: 0o755 });
  const script = fileURLToPath(new URL('../../start-pi.sh', import.meta.url));
  const options = { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TMUX: '' } };
  assert.equal(execFileSync('bash', [script, '--sessions'], options).trim(), 's8-main');
  execFileSync('bash', [script, '--session', 'main'], options);
  execFileSync('bash', [script, '--session', 'main'], options);
  const calls = await readFile(log, 'utf8');
  assert.equal(calls.match(/^new-session /gm).length, 1);
  assert.equal(calls.match(/^attach-session /gm).length, 2);
  assert.ok(calls.includes('--managed'));
  assert.throws(() => execFileSync('bash', [script, '--session', 'bad;name'], { ...options, stdio: 'pipe' }));
});
