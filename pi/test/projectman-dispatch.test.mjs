import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import { runBoundedProcess } from '../lib/projectman-autopilot.ts';
import { runProjectmanTurn, WORK_PROMPT } from '../lib/projectman-dispatch.ts';

const policy = { state: 'ready', autorun: true, autorunMode: 'safe', risk: 'low', requiresApproval: false, allowedActions: ['read'] };
const item = (uid, type, parentUid, attributes = {}) => ({ uid, type, title: uid, status: 'published', created_at: '2026-01-01', updated_at: null, parent: parentUid ? { uid: parentUid } : null, tags: [], detail: { text: 'Read README and cite findings', attributes } });
function fixture() {
  const project = item('cnt_project', 'project', null, { repoPath: process.cwd() });
  const task = item('cnt_task', 'task', project.uid, { ...policy });
  const rows = new Map([[project.uid, project], [task.uid, task]]);
  const transitions = [], notices = [], prompts = [];
  const client = {
    get: async uid => structuredClone(rows.get(uid)),
    list: async (type, parentUid) => [...rows.values()].filter(row => row.type === type && row.parent?.uid === parentUid).map(row => structuredClone(row)),
    transition: async (uid, expectedState, nextState, message, event) => {
      const row = rows.get(uid);
      if (row.detail.attributes.state !== expectedState) throw new Error('PH-CMS request failed (HTTP 409)');
      row.detail.attributes.state = nextState;
      transitions.push({ uid, expectedState, nextState, message, event });
      const log = item(`cnt_log${transitions.length}`, 'work_log', uid);
      log.title = event;
      log.detail.text = message;
      log.created_at = `2026-01-01T00:00:${String(transitions.length).padStart(2, '0')}Z`;
      rows.set(log.uid, log);
    },
  };
  const options = { projectUid: project.uid, deadline: Date.now() + 60000, signal: new AbortController().signal, client, recorder: client,
    paths: { cwd: path.resolve(process.cwd(), '../854_md'), binary: 'fake-pi', guard: 'guard.ts', scopeExtension: 'scope.ts', systemPrompt: 'system.md' },
    notify: async notice => { notices.push(notice); return true; },
    run: async (_binary, args) => { prompts.push(args.at(-1)); return { status: 'completed', output: JSON.stringify({ status: 'completed', summary: 'README checked; citations recorded' }) }; },
  };
  return { project, task, rows, client, transitions, notices, prompts, options };
}

test('one work is one prompt with start/result notices; idle/finished/blocked/canceled polls are silent', async () => {
  const f = fixture();
  assert.equal((await runProjectmanTurn(f.options)).status, 'review');
  assert.equal(f.prompts.length, 1);
  assert.ok(f.prompts[0].startsWith(WORK_PROMPT));
  assert.deepEqual(f.notices.map(n => n.stage), ['start', 'finish']);
  assert.deepEqual(f.transitions.map(t => t.event), ['started', 'completed']);
  for (const state of ['review', 'done', 'blocked', 'canceled', 'todo']) {
    f.task.detail.attributes.state = state;
    assert.equal((await runProjectmanTurn(f.options)).status, 'idle');
  }
  assert.equal(f.notices.length, 2);
  assert.equal(f.prompts.length, 1);
});

test('a partial turn stores its checkpoint in Projectman and the next single prompt resumes it', async () => {
  const f = fixture();
  f.options.run = async (_binary, args) => {
    f.prompts.push(args.at(-1));
    return { status: 'completed', output: JSON.stringify({ status: f.prompts.length === 1 ? 'continue' : 'completed', summary: f.prompts.length === 1 ? 'Section A checked. Remaining: section B. Next: inspect B.' : 'Section B checked; complete.' }) };
  };
  assert.equal((await runProjectmanTurn(f.options)).status, 'ready');
  assert.equal(f.task.detail.attributes.state, 'ready');
  assert.match(f.transitions[1].message, /Remaining: section B/);
  assert.equal((await runProjectmanTurn(f.options)).status, 'review');
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[1], /Remaining: section B/);
  assert.equal(f.notices.length, 4);
});

test('a feature dispatches its first eligible subwork only, never the entire parent', async () => {
  const f = fixture();
  const first = item('cnt_sub1', 'subtask', f.task.uid, { ...policy });
  const second = item('cnt_sub2', 'subtask', f.task.uid, { ...policy });
  f.rows.set(first.uid, first); f.rows.set(second.uid, second);
  assert.equal((await runProjectmanTurn(f.options)).uid, first.uid);
  assert.ok(f.transitions.every(t => t.uid === first.uid));
  assert.equal(f.task.detail.attributes.state, 'ready');
  assert.equal(second.detail.attributes.state, 'ready');
  assert.equal((await runProjectmanTurn(f.options)).status, 'idle'); // first is awaiting review
  first.detail.attributes.state = 'done';
  f.task.tags.push('need:approval');
  assert.equal((await runProjectmanTurn(f.options)).status, 'idle');
  f.task.tags.length = 0;
  assert.equal((await runProjectmanTurn(f.options)).uid, second.uid);
});

test('activation, approval, due time and scope restrictions are not broadened', async () => {
  for (const override of [{ autorun: false }, { requiresApproval: true }, { allowedActions: ['write'] }, { scheduledAt: '2099-01-01T00:00:00Z' }, { scheduledAt: 'invalid' }]) {
    const f = fixture(); Object.assign(f.task.detail.attributes, override);
    assert.equal((await runProjectmanTurn(f.options)).status, 'idle');
    assert.equal(f.notices.length, 0);
  }
  const f = fixture(); f.project.detail.attributes.repoPath = '/';
  await assert.rejects(runProjectmanTurn(f.options), /outside permitted/);
  assert.equal(f.transitions.length, 0);
});

test('atomic ready-to-doing claim prevents duplicate prompts across dispatchers', async () => {
  const f = fixture();
  const results = await Promise.all([runProjectmanTurn(f.options), runProjectmanTurn(f.options)]);
  assert.deepEqual(results.map(r => r.status).sort(), ['idle', 'review']);
  assert.equal(f.prompts.length, 1);
});

test('timeout preserves partial work for another turn; manual stop does not auto-resume', async () => {
  const f = fixture();
  f.options.run = async () => ({ status: 'timeout', output: 'Inspected README; next inspect tests' });
  assert.equal((await runProjectmanTurn(f.options)).status, 'ready');
  assert.match(f.transitions[1].message, /next inspect tests/);
  const controller = new AbortController(); f.options.signal = controller.signal;
  f.options.run = async () => { controller.abort('user_stop'); return { status: 'stopped', output: 'Partial section A' }; };
  assert.equal((await runProjectmanTurn(f.options)).status, 'blocked');
  assert.match(f.transitions.at(-1).message, /Partial section A/);
  const partialFailure = fixture();
  partialFailure.options.run = async () => ({ status: 'failed', output: 'Partial result before token limit; next inspect section B' });
  assert.equal((await runProjectmanTurn(partialFailure.options)).status, 'ready');
  assert.match(partialFailure.transitions[1].message, /next inspect section B/);
});

test('expiry and a changed activation policy never dispatch a prompt', async () => {
  const f = fixture();
  assert.equal((await runProjectmanTurn({ ...f.options, deadline: Date.now() - 1 })).status, 'idle');
  assert.equal(f.transitions.length, 0);
  const transition = f.client.transition;
  f.client.transition = async (...args) => {
    await transition(...args);
    if (args[2] === 'doing') f.task.detail.attributes.autorun = false;
  };
  assert.equal((await runProjectmanTurn(f.options)).status, 'blocked');
  assert.equal(f.prompts.length, 0);
  assert.equal(f.notices.length, 0);
});

test('notification failure never starts a model and does not silently mark work complete', async () => {
  const f = fixture(); f.options.notify = async () => false;
  assert.equal((await runProjectmanTurn(f.options)).status, 'ready');
  assert.equal(f.prompts.length, 0);
  assert.match(f.transitions[1].message, /프롬프트를 실행하지/);
});

test('one real JSON-mode child invocation resumes the previous checkpoint without access to the Projectman key', async t => {
  if (!['darwin', 'linux'].includes(process.platform)) return t.skip('requires supported child-process platform');
  const f = fixture();
  const dir = await mkdtemp(path.join(os.tmpdir(), 's8-prompt-child-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = path.join(dir, 'fake-pi');
  await writeFile(binary, `#!/usr/bin/env node
if(process.env.PHCMS_ACCESS_TOKEN || !process.argv.includes('--mode') || process.argv[process.argv.indexOf('--mode')+1]!=='json') process.exit(9);
const prompt=process.argv.at(-1); const begin=prompt.indexOf('<projectman-data>')+'<projectman-data>'.length;
const data=JSON.parse(prompt.slice(begin,prompt.lastIndexOf('</projectman-data>')));
const resumed=data.history.some(log=>log.text?.includes('checkpoint-A'));
const emit=event=>process.stdout.write(JSON.stringify(event)+'\\n');
emit({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify({status:resumed?'completed':'continue',summary:resumed?'completed-B':'checkpoint-A; next-B'})}]}});
emit({type:'agent_settled'});
`);
  await chmod(binary, 0o700);
  f.options.paths.binary = binary;
  f.options.run = runBoundedProcess;
  assert.equal((await runProjectmanTurn(f.options)).status, 'ready');
  assert.equal((await runProjectmanTurn(f.options)).status, 'review');
  assert.match(f.transitions.at(-1).message, /completed-B/);
  assert.deepEqual(f.notices.map(n => n.stage), ['start', 'finish', 'start', 'finish']);
});

test('recording failure leaves the claimed work for explicit recovery, never a second automatic prompt', async () => {
  const f = fixture(); f.options.recorder = { transition: async () => { throw new Error('fixture-error'); } };
  await assert.rejects(runProjectmanTurn(f.options), /result recording failed/);
  assert.equal(f.task.detail.attributes.state, 'doing');
  assert.equal((await runProjectmanTurn(f.options)).status, 'idle');
  assert.equal(f.prompts.length, 1);
});
