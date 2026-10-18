import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBoundedProcess } from '../lib/bounded-process.mjs';

test('child process completes or is stopped at its deadline', async () => {
  const cwd = process.cwd();
  const ok = await runBoundedProcess(process.execPath, ['-e', "console.log('done')"], cwd, 5000, new AbortController().signal);
  assert.equal(ok.status, 'completed');
  assert.match(ok.output, /done/);
  const expired = await runBoundedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], cwd, 100, new AbortController().signal);
  assert.equal(expired.status, 'timeout');
  const controller = new AbortController();
  const run = runBoundedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], cwd, 5000, controller.signal);
  setTimeout(() => controller.abort(), 100);
  assert.equal((await run).status, 'stopped');
});

test('continuation mode keeps the latest checkpoint and decodes split Korean UTF-8 bytes safely', async () => {
  const script = `process.stdout.write('x'.repeat(12000)); const b=Buffer.from('미완료: 다음 단계는 테스트 확인'); process.stdout.write(b.subarray(0,2)); setTimeout(()=>process.stdout.write(b.subarray(2)),20);`;
  const result = await runBoundedProcess(process.execPath, ['-e', script], process.cwd(), 5000, new AbortController().signal, true);
  assert.equal(result.status, 'completed');
  assert.ok(result.output.length <= 10000);
  assert.ok(result.output.endsWith('미완료: 다음 단계는 테스트 확인'));
  assert.equal(result.output.includes('�'), false);
});
