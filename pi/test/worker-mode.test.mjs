import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { claimWork, reportWork, readClaim } from '../lib/agent/worker-run.mjs';
import { startWork, WORK_SESSION } from '../lib/agent/work.mjs';
import { reportForServer, flushDevelopmentOutbox } from '../lib/development/outbox.mjs';
import { finishStoppedRun } from '../lib/agent/finish.mjs';
import worker from '../extensions/worker.ts';

const exec = promisify(execFile);
const until = async check => { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); } assert.fail('condition timeout'); };

/** 요청 ID로 멱등 처리하는 Projectman 가짜 클라이언트. loseNext면 다음 변경을 반영한 뒤 응답만 잃는다. */
async function fixture(t, { type = 'task', state = 'ready', commandNames = [], repoPath, uids = ['task1'] } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 's8-worker-mode-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rows = new Map(uids.map(uid => [uid, { uid, title: `Fixture ${uid}`, state, workflow: { version: 2, revision: 2, planVersion: 1, planHash: 'p', confirmation: { planVersion: 1, planHash: 'p' }, specHash: 's', grant: { specHash: 's' }, spec: { plan: 'Do it', commandNames, repoPath, dependsOn: [] } } }]));
  const applied = new Map(), operations = [];
  const client = {
    loseNext: false,
    get: async uid => ({ uid, type, title: rows.get(uid).title, detail: { text: 'Write the file' } }),
    getWorkflow: async uid => structuredClone(rows.get(uid)),
    list: async () => [],
    async workflow(uid, operation) {
      if (!applied.has(operation.requestId)) {
        const row = rows.get(uid);
        if (row.workflow.revision !== operation.expectedRevision) throw new Error('PH-CMS request failed (HTTP 409)');
        operations.push(operation);
        if (operation.action === 'claim') { row.state = 'doing'; row.workflow.run = { id: operation.runId, workerId: operation.workerId }; }
        else { row.state = operation.report.status === 'completed' ? 'review' : 'blocked'; row.workflow.result = operation.report; }
        row.workflow.revision++;
        applied.set(operation.requestId, structuredClone(row));
      }
      if (this.loseNext) { this.loseNext = false; throw new Error('PH-CMS request failed (timeout)'); }
      return structuredClone(applied.get(operation.requestId));
    },
  };
  return { root, rows, row: rows.get(uids[0]), client, operations };
}

test('worker claims a ready task once, retrying a lost response with the same request', async t => {
  const f = await fixture(t);
  f.client.loseNext = true;
  await assert.rejects(claimWork({ root: f.root, client: f.client, uid: 'task1', workerId: 'w1' }), /timeout/);
  const { claim, work } = await claimWork({ root: f.root, client: f.client, uid: 'task1', workerId: 'w1' });
  assert.equal(f.operations.length, 1);
  assert.equal(f.row.workflow.run.workerId, 'w1');
  assert.equal(work.runId, claim.runId);
  assert.equal(work.text, 'Write the file');
  // 같은 장비에서 다시 get하면 claim 없이 이어간다.
  assert.equal((await claimWork({ root: f.root, client: f.client, uid: 'task1' })).claim.runId, claim.runId);
  assert.equal(f.operations.length, 1);
});

test('worker refuses non-work items, unready tasks and revoked runs', async t => {
  const project = await fixture(t, { type: 'project' });
  await assert.rejects(claimWork({ root: project.root, client: project.client, uid: 'task1' }), /task 또는 subtask/);
  const todo = await fixture(t, { state: 'todo' });
  await assert.rejects(claimWork({ root: todo.root, client: todo.client, uid: 'task1' }), /ready/);
  const revoked = await fixture(t);
  await claimWork({ root: revoked.root, client: revoked.client, uid: 'task1' });
  revoked.row.workflow.run.id = 'someone-else';
  await assert.rejects(claimWork({ root: revoked.root, client: revoked.client, uid: 'task1' }), /유효하지 않습니다/);
});

test('report is delivered once through the outbox and missing required checks fail the work', async t => {
  const f = await fixture(t, { commandNames: ['test'] });
  const { claim } = await claimWork({ root: f.root, client: f.client, uid: 'task1' });
  const outcome = await reportWork({ root: f.root, client: f.client, claim, cwd: f.root, result: { status: 'completed', summary: 'done', verification: [] } });
  assert.deepEqual(outcome, { status: 'failed', delivered: true, conflict: false, state: 'blocked' });
  const outbox = JSON.parse(await readFile(path.join(f.root, '.s8-runtime/runs', claim.runId, 'outbox.json'), 'utf8'));
  assert.equal(outbox.operation.expectedRevision, claim.revision);
  assert.equal(f.operations.filter(op => op.action === 'report').length, 1);
  await assert.rejects(claimWork({ root: f.root, client: f.client, uid: 'task1' }), /이미 보고/);
});

test('worker extension gates tools on claim and report and stays on one UID', async t => {
  const f = await fixture(t);
  const tools = new Map(), handlers = {};
  const pi = { registerTool: tool => tools.set(tool.name, tool), on: (name, handler) => { handlers[name] = handler; }, setActiveTools() {} };
  worker(pi, { root: f.root, client: f.client, workerId: 'w1' });
  assert.ok(tools.has('bash'), 'bash is replaced by a secret-stripping variant');
  const projectman = tools.get('projectman'), ctx = { cwd: f.root };
  const call = toolName => handlers.tool_call({ toolName, input: {} });
  assert.equal((await call('edit')).block, true);
  assert.equal((await call('kb')).block, true);
  await projectman.execute('1', { action: 'get', uid: 'task1' }, undefined, undefined, ctx);
  assert.equal(await call('edit'), undefined);
  await assert.rejects(projectman.execute('2', { action: 'get', uid: 'task2' }, undefined, undefined, ctx), /task1만/);
  await projectman.execute('3', { action: 'report', uid: 'task1', status: 'completed', summary: 'done', verification: [] }, undefined, undefined, ctx);
  assert.equal(f.row.state, 'review');
  assert.equal((await call('bash')).block, true);
  await assert.rejects(projectman.execute('4', { action: 'report', uid: 'task1', status: 'completed', summary: 'again' }, undefined, undefined, ctx), /이미 보고/);
});

/** git 저장소와 격리된 tmux 서버, 인자를 기록하는 가짜 start-pi.sh를 갖춘 실행기 픽스처. */
async function workFixture(t, options) {
  const f = await fixture(t, { ...options, repoPath: undefined });
  const repo = path.join(f.root, 'repo');
  await mkdir(repo);
  await writeFile(path.join(repo, 'base.txt'), 'base');
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']]) await exec('git', args, { cwd: repo });
  for (const row of f.rows.values()) row.workflow.spec.repoPath = repo;
  const launches = path.join(f.root, 'launches');
  await writeFile(path.join(f.root, 'start-pi.sh'), `echo "$S8_WORKER_ID $*" >> '${launches}'\nexec sleep 60\n`);
  const socket = `s8-work-${randomUUID()}`;
  const run = args => exec('tmux', ['-f', '/dev/null', '-L', socket, ...args], { timeout: 5000 });
  t.after(() => run(['kill-server']).catch(() => {}));
  const start = (uid = 'task1') => startWork(f.root, uid, { client: f.client, run, workerId: 'w1' });
  const launched = () => readFile(launches, 'utf8').then(text => text.trim().split('\n'), () => []);
  return { ...f, repo, run, start, launched };
}

/** start-pi.sh 워커 모드가 하는 일: 넘겨받은 claim을 보내고, 파일을 쓰고, 보고한다. */
async function workAs(f, uid, file, content) {
  const { claim } = await claimWork({ root: f.root, client: f.client, uid });
  const worktree = path.join(f.root, '.s8-runtime/worktrees', uid);
  await writeFile(path.join(worktree, file), content);
  return reportWork({ root: f.root, client: f.client, claim, cwd: worktree, result: { status: 'completed', summary: 'done', verification: [] } });
}

test('run_worker prepares a worktree, hands its claim to a worker window and the worker reports a task patch', async t => {
  const f = await workFixture(t);
  const started = await f.start();
  assert.equal(started.target, `${WORK_SESSION}:task1`);
  assert.equal(f.row.state, 'ready', 'the launcher does not claim');
  await until(async () => (await f.launched()).length === 1);
  assert.equal((await f.launched())[0], `w1 --mode worker --uid task1 --cwd ${started.worktree}`);
  assert.equal((await f.start()).running, true, 'a live worker window is not started twice');
  const { claim } = await claimWork({ root: f.root, client: f.client, uid: 'task1' });
  assert.equal(claim.runId, (await readClaim(f.root, 'task1')).runId);
  assert.equal(f.row.workflow.run.workerId, 'w1');
  await writeFile(path.join(started.worktree, 'out.txt'), 'done');
  await reportWork({ root: f.root, client: f.client, claim, cwd: started.worktree, result: { status: 'completed', summary: 'done', verification: [] } });
  assert.equal(f.row.state, 'review');
  assert.match(await readFile(path.join(f.root, '.s8-runtime/runs', claim.runId, 'task.patch'), 'utf8'), /out\.txt/);
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: f.repo })).stdout, '');
});

test('run_worker resumes a claimed run in the same worktree and refuses unconfirmed or unready work', async t => {
  const f = await workFixture(t, { uids: ['task1', 'task2', 'task3'] });
  const first = await f.start('task1');
  const { claim } = await claimWork({ root: f.root, client: f.client, uid: 'task1' });
  await f.run(['kill-window', '-t', first.target]);
  const resumed = await f.start('task1');
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.worktree, first.worktree);
  assert.equal((await readClaim(f.root, 'task1')).runId, claim.runId);
  f.rows.get('task2').workflow.confirmation = undefined;
  await assert.rejects(f.start('task2'), /confirmation/);
  f.rows.get('task3').state = 'todo';
  await assert.rejects(f.start('task3'), /ready/);
  assert.deepEqual((await readdir(path.join(f.root, '.s8-runtime/worktrees'))).filter(name => !name.endsWith('.json')), ['task1']);
});

test('dependency results compose into the worktree of a later task', async t => {
  const f = await workFixture(t, { uids: ['task1', 'task2'] });
  await f.start('task1');
  await workAs(f, 'task1', 'shared.txt', 'first\n');
  f.rows.get('task1').state = 'done';
  f.rows.get('task2').workflow.spec.dependsOn = ['task1'];
  const second = await f.start('task2');
  assert.equal(await readFile(path.join(second.worktree, 'shared.txt'), 'utf8'), 'first\n');
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: f.repo })).stdout, '');
});

test('report truncation retains failures and never converts failed verification to completion', () => {
  const verification = [{ name: 'first failure', ok: false, summary: 'failed' }, ...Array.from({ length: 25 }, (_, index) => ({ name: `passed-${index}`, ok: true }))];
  const report = reportForServer({ status: 'completed', summary: 'fixture', verification });
  assert.equal(report.status, 'failed');
  assert.equal(report.verification.length, 20);
  assert.equal(report.verification[0].ok, false);
  assert.ok(report.executionErrors.length);
});

test('Telegram retry does not repeat the server report or manager receipt', async t => {
  const f = await fixture(t);
  const { claim } = await claimWork({ root: f.root, client: f.client, uid: 'task1' });
  const settings = { publicUrl: 'https://s8.example.invalid/s8/', telegram: { scheduleChatId: '123' } };
  let attempts = 0;
  const notify = async message => { attempts++; assert.ok(message.includes(`task=task1&run=${claim.runId}`)); if (attempts === 1) throw new Error('unavailable'); return true; };
  // 워커 보고 시 첫 전달: Projectman 보고는 성공하고 Telegram만 실패한다.
  await reportWork({ root: f.root, client: f.client, claim, cwd: f.root, result: { status: 'completed', summary: 'done', verification: [] } }).catch(() => {});
  await flushDevelopmentOutbox({ root: f.root, client: f.client, settings, notify });
  const inbox = path.join(f.root, '.s8-runtime/manager-inbox', `${claim.runId}.json`);
  const received = { ...JSON.parse(await readFile(inbox, 'utf8')), receivedAt: 'fixture' };
  await writeFile(inbox, JSON.stringify(received));
  await Promise.all([flushDevelopmentOutbox({ root: f.root, client: f.client, settings, notify }), flushDevelopmentOutbox({ root: f.root, client: f.client, settings, notify })]);
  assert.equal(f.operations.filter(op => op.action === 'report').length, 1);
  assert.equal(JSON.parse(await readFile(inbox, 'utf8')).receivedAt, 'fixture');
  assert.equal(JSON.parse(await readFile(path.join(f.root, '.s8-runtime/runs', claim.runId, 'outbox.json'), 'utf8')).telegramDelivered, true);
});

test('finish reports a stopped run as failed even without a local claim record, and refuses unsafe cases', async t => {
  const f = await workFixture(t);
  // 다른 장비의 워커가 claim하고 멈춘 상황: 이 장비에는 claim 기록이 없다.
  const runId = randomUUID();
  await f.client.workflow('task1', { action: 'claim', requestId: randomUUID(), expectedRevision: 2, runId, workerId: 'remote' });
  const finish = (options = {}) => finishStoppedRun({ root: f.root, client: f.client, uid: 'task1', runId, confirmed: true, run: f.run, ...options });
  await assert.rejects(finish({ confirmed: false }), /confirm-stopped/);
  await assert.rejects(finish({ runId: 'not-a-uuid' }), /run-id/);
  await assert.rejects(finish({ runId: randomUUID() }), /다릅니다/);
  await f.run(['new-session', '-d', '-s', WORK_SESSION, '-n', 'task1', 'sleep 60']);
  await assert.rejects(finish(), /kill-window/);
  await f.run(['kill-session', '-t', WORK_SESSION]);
  const result = await finish();
  assert.equal(result.state, 'blocked');
  assert.equal(f.row.workflow.result.status, 'failed');
  assert.ok(JSON.parse(await readFile(path.join(f.root, '.s8-runtime/manager-inbox', `${runId}.json`), 'utf8')).uid === 'task1');
  // 재실행해도 보고는 한 번만 반영된다.
  await finish();
  assert.equal(f.operations.filter(op => op.action === 'report').length, 1);
});

test('finish closes a local claim so the worker cannot continue it', async t => {
  const f = await workFixture(t);
  const { claim } = await claimWork({ root: f.root, client: f.client, uid: 'task1' });
  await finishStoppedRun({ root: f.root, client: f.client, uid: 'task1', runId: claim.runId, confirmed: true, run: f.run });
  assert.equal((await readClaim(f.root, 'task1')).reported, true);
  await assert.rejects(claimWork({ root: f.root, client: f.client, uid: 'task1' }), /이미 보고/);
});
