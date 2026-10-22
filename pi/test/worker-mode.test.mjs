import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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

test('claim delegates workflow eligibility to the server and accepts unconfirmed local metadata', async t => {
  const project = await fixture(t, { type: 'project' });
  await assert.rejects(claimWork({ root: project.root, client: project.client, uid: 'task1' }), /task 또는 subtask/);
  const f = await fixture(t, { state: 'todo' });
  f.row.workflow.confirmation = undefined;
  f.row.workflow.grant = undefined;
  await claimWork({ root: f.root, client: f.client, uid: 'task1' });
  assert.equal(f.operations[0].action, 'claim');
});

test('report preserves the Worker assessment even without named checks', async t => {
  const f = await fixture(t, { commandNames: ['test'] });
  const { claim } = await claimWork({ root: f.root, client: f.client, uid: 'task1' });
  const outcome = await reportWork({ root: f.root, client: f.client, claim, cwd: f.root, result: { status: 'completed', summary: 'done', verification: [] } });
  assert.deepEqual(outcome, { status: 'completed', delivered: true, conflict: false, state: 'review' });
  const outbox = JSON.parse(await readFile(path.join(f.root, '.s8-runtime/runs', claim.runId, 'outbox.json'), 'utf8'));
  assert.equal(outbox.operation.expectedRevision, claim.revision);
  assert.equal(f.operations.filter(op => op.action === 'report').length, 1);
  assert.equal((await claimWork({ root: f.root, client: f.client, uid: 'task1' })).claim.reported, true);
});

test('worker file and shell tools remain available before claim and after report', async t => {
  const f = await fixture(t);
  const tools = new Map(), handlers = {};
  worker({ registerTool: tool => tools.set(tool.name, tool), on: (name, handler) => { handlers[name] = handler; }, setActiveTools() {} }, { root: f.root, client: f.client });
  const call = toolName => handlers.tool_call?.({ toolName, input: {} });
  for (const name of ['edit', 'write', 'bash', 'read']) assert.equal(await call(name), undefined);
  const projectman = tools.get('projectman'), ctx = { cwd: f.root };
  await projectman.execute('get', { action: 'get', uid: 'task1' }, undefined, undefined, ctx);
  await projectman.execute('report', { action: 'report', uid: 'task1', status: 'completed', summary: 'done' }, undefined, undefined, ctx);
  for (const name of ['edit', 'write', 'bash', 'read', 'agent_message']) assert.equal(await call(name), undefined);
});

/** git 저장소와 격리된 tmux 서버, 인자를 기록하는 가짜 start-worker-agent.sh를 갖춘 실행기 픽스처. */
async function workFixture(t, options) {
  const f = await fixture(t, { ...options, repoPath: undefined });
  const repo = path.join(f.root, 'repo');
  await mkdir(repo);
  await writeFile(path.join(repo, 'base.txt'), 'base');
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']]) await exec('git', args, { cwd: repo });
  for (const row of f.rows.values()) row.workflow.spec.repoPath = repo;
  const launches = path.join(f.root, 'launches');
  await writeFile(path.join(f.root, 'start-worker-agent.sh'), `echo "$S8_WORKER_ID $*" >> '${launches}'\nexec sleep 60\n`);
  const socket = `s8-work-${randomUUID()}`;
  const run = args => exec('tmux', ['-f', '/dev/null', '-L', socket, ...args], { timeout: 5000 });
  t.after(() => run(['kill-server']).catch(() => {}));
  const start = (uid = 'task1') => startWork(f.root, uid, { client: f.client, run, workerId: 'w1' });
  const launched = () => readFile(launches, 'utf8').then(text => text.trim().split('\n'), () => []);
  return { ...f, repo, run, start, launched };
}

async function workAs(f, uid, file, content) {
  const { claim } = await claimWork({ root: f.root, client: f.client, uid });
  await writeFile(path.join(f.repo, file), content);
  return reportWork({ root: f.root, client: f.client, claim, cwd: f.repo, result: { status: 'completed', summary: 'done', verification: [] } });
}

test('run_worker uses the task directory without touching Git index or preparing worktrees', async t => {
  const f = await workFixture(t);
  await writeFile(path.join(f.repo, 'base.txt'), 'user staged change');
  await exec('git', ['add', 'base.txt'], { cwd: f.repo });
  const before = (await exec('git', ['write-tree'], { cwd: f.repo })).stdout;
  const started = await f.start();
  assert.equal(started.worktree, f.repo);
  assert.equal(started.target, `${WORK_SESSION}:task1`);
  await until(async () => (await f.launched()).length === 1);
  assert.equal((await f.launched())[0], `w1 --uid task1 --cwd ${f.repo}`);
  assert.equal((await f.start()).running, true);
  await workAs(f, 'task1', 'out.txt', 'done');
  assert.equal(f.row.state, 'review');
  assert.equal((await exec('git', ['write-tree'], { cwd: f.repo })).stdout, before);
  await assert.rejects(readdir(path.join(f.root, '.s8-runtime/worktrees')), /ENOENT/);
});

test('nonempty non-Git folders and Git subdirectories start without repository restrictions', async t => {
  for (const nonGit of [true, false]) {
    const f = await workFixture(t);
    const directory = path.join(f.repo, 'nested');
    await mkdir(directory);
    await writeFile(path.join(directory, 'firebase.json'), '{}');
    if (nonGit) await rm(path.join(f.repo, '.git'), { recursive: true });
    f.row.workflow.spec.repoPath = directory;
    f.row.workflow.confirmation = undefined;
    f.row.workflow.spec.assignee = 'another-worker';
    const started = await f.start();
    assert.equal(started.worktree, directory);
    assert.deepEqual((await readdir(directory)).sort(), ['firebase.json']);
  }
});

test('run_worker resumes the original claim and leaves state validation to Projectman', async t => {
  const f = await workFixture(t, { uids: ['task1', 'task2', 'task3'] });
  const first = await f.start('task1');
  const { claim } = await claimWork({ root: f.root, client: f.client, uid: 'task1' });
  await f.run(['kill-window', '-t', first.target]);
  const resumed = await f.start('task1');
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.worktree, first.worktree);
  assert.equal((await readClaim(f.root, 'task1')).runId, claim.runId);
  f.rows.get('task2').workflow.confirmation = undefined;
  assert.equal((await f.start('task2')).worktree, f.repo);
  f.rows.get('task3').state = 'todo';
  assert.equal((await f.start('task3')).worktree, f.repo);
  await f.run(['kill-window', '-t', `${WORK_SESSION}:task3`]);
  // 콘솔의 retry로 blocked에서 ready로 돌아온 작업은 끝난 실행 기록이 있어도 다시 실행한다.
  Object.assign(f.rows.get('task3'), { state: 'ready', workflow: { ...f.rows.get('task3').workflow, run: { id: 'old', status: 'finished' } } });
  assert.equal((await f.start('task3')).resumed, false);
  await assert.rejects(readdir(path.join(f.root, '.s8-runtime/worktrees')), /ENOENT/);
});

test('sequential tasks share the directory without automatic patch imports', async t => {
  const f = await workFixture(t, { uids: ['task1', 'task2'] });
  await f.start('task1');
  await workAs(f, 'task1', 'shared.txt', 'first\n');
  f.rows.get('task1').state = 'done';
  f.rows.get('task2').workflow.spec.dependsOn = ['task1'];
  const second = await f.start('task2');
  assert.equal(await readFile(path.join(second.worktree, 'shared.txt'), 'utf8'), 'first\n');
  assert.match((await exec('git', ['status', '--porcelain'], { cwd: f.repo })).stdout, /shared.txt/);
});

test('resolved problems in executionErrors keep a completed report completed', () => {
  const report = reportForServer({ status: 'completed', summary: 'done', verification: [{ name: 'test', ok: true }], executionErrors: ['테스트 기대값을 바로잡았고 최종 검증은 통과했다.'] });
  assert.equal(report.status, 'completed');
  assert.deepEqual(report.executionErrors, ['테스트 기대값을 바로잡았고 최종 검증은 통과했다.']);
});

test('report retains failed checks without overriding the Worker assessment', () => {
  const verification = [{ name: 'first failure', ok: false, summary: 'failed' }, ...Array.from({ length: 25 }, (_, index) => ({ name: `passed-${index}`, ok: true }))];
  const report = reportForServer({ status: 'completed', summary: 'fixture', verification });
  assert.equal(report.status, 'completed');
  assert.equal(report.verification.length, 20);
  assert.equal(report.verification[0].ok, false);
  assert.equal(report.executionErrors.length, 0);
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

for (const messaging of [false, true]) test(`finish requires explicit stopped confirmation and the current run independently of messaging (${messaging})`, async t => {
  const f = await workFixture(t);
  if (messaging) await writeFile(path.join(f.root, 's8-config.yml'), 'communication:\n  enabled: true\n  url: ws://127.0.0.1:8090\n  tokenFile: /fixture/token.json\n');
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

test('finish marks a local claim reported for resident scheduling', async t => {
  const f = await workFixture(t);
  const { claim } = await claimWork({ root: f.root, client: f.client, uid: 'task1' });
  await finishStoppedRun({ root: f.root, client: f.client, uid: 'task1', runId: claim.runId, confirmed: true, run: f.run });
  assert.equal((await readClaim(f.root, 'task1')).reported, true);
  assert.equal((await claimWork({ root: f.root, client: f.client, uid: 'task1' })).claim.reported, true);
});

for (const distributed of [false, true]) test(`launcher resumes a lost claim response without a second claim (distributed=${distributed})`, async t => {
  const f = await workFixture(t);
  if (distributed) await writeFile(path.join(f.root, 's8-config.yml'), `communication:\n  enabled: true\n  url: ws://127.0.0.1:8090\n  tokenFile: /fixture/token.json\n`);
  const first = await f.start();
  f.client.loseNext = true;
  await assert.rejects(claimWork({ root: f.root, client: f.client, uid: 'task1', workerId: 'w1' }), /timeout/);
  const pending = await readClaim(f.root, 'task1');
  assert.equal(pending.revision, undefined);
  assert.equal(f.row.state, 'doing');
  await f.run(['kill-window', '-t', `${WORK_SESSION}:task1`]);
  const resumed = await f.start();
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.worktree, first.worktree);
  const result = await claimWork({ root: f.root, client: f.client, uid: 'task1', workerId: 'w1' });
  assert.equal(result.claim.runId, pending.runId);
  assert.equal(f.operations.filter(operation => operation.action === 'claim').length, 1);
});

test('sequential tasks can revert a prior change directly in the working directory', async t => {
  const f = await workFixture(t, { uids: ['task1', 'task2', 'task3'] });
  await f.start('task1');
  await workAs(f, 'task1', 'base.txt', 'parent change\n');
  f.rows.get('task1').state = 'done';
  f.rows.get('task2').workflow.spec.dependsOn = ['task1'];
  await f.start('task2');
  await workAs(f, 'task2', 'base.txt', 'base');
  f.rows.get('task2').state = 'done';
  f.rows.get('task3').workflow.spec.dependsOn = ['task2'];
  const third = await f.start('task3');
  assert.equal(await readFile(path.join(third.worktree, 'base.txt'), 'utf8'), 'base');
});
