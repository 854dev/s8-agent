import test from 'node:test';
import assert from 'node:assert/strict';
import { runBounded } from './helpers/run-bounded.mjs';

test('runBounded resolves with stdout and stderr from a quick command', async () => {
  const { stdout, stderr } = await runBounded(process.execPath, ['-e', "console.log('out'); console.error('err')"], { timeoutMs: 5000 });
  assert.equal(stdout, 'out\n');
  assert.equal(stderr, 'err\n');
});

test('runBounded force-kills a child that ignores SIGTERM instead of hanging', async () => {
  // SIGTERM을 무시하고 끝나지 않는 자식도 일정 시간 안에 SIGKILL로 종료돼야 한다.
  const start = Date.now();
  await assert.rejects(
    runBounded(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { timeoutMs: 300, killGraceMs: 100 }),
    error => error.killed === true && error.signal === 'SIGKILL',
  );
  assert.ok(Date.now() - start < 2000, 'must settle within the bounded window, not hang');
});