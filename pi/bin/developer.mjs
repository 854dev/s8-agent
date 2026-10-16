import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Type } from 'typebox';
import { smokeRuntime, smokeSession, saveJson } from '../lib/development-smoke.mjs';
import { developmentWorkspace, developmentCommand, workspaceChanges } from '../lib/development-workspace.mjs';

let input = '';
for await (const chunk of process.stdin) { input += chunk; if (input.length > 100000) throw new Error('Worker request too large'); }
const request = JSON.parse(input);
const { root, run, task, policy } = request;
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort());
const timer = setTimeout(() => controller.abort(), Math.min(policy.maxTimeMinutes, task.workflow.spec.timeBudgetMinutes) * 60000);
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: undefined });
let question, report;
const verification = [];
try {
  const workspace = developmentWorkspace(run.workspace, task.workflow.spec.allowedPaths);
  const active = () => { if (question || report || controller.signal.aborted) throw new Error('Development work is stopped'); };
  const tools = [{
    name: 'workspace', label: 'Scoped development workspace', description: 'Read/list the isolated repository; write or remove regular files only in approved paths. No credentials, links or hidden runtime paths.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('read'), Type.Literal('list'), Type.Literal('write'), Type.Literal('remove')]), path: Type.Optional(Type.String()), content: Type.Optional(Type.String()) }),
    async execute(_id, args) { active(); return result(args.action === 'write' ? await workspace.write(args.path, args.content) : args.action === 'remove' ? await workspace.remove(args.path) : args.action === 'list' ? await workspace.list(args.path ?? '') : await workspace.read(args.path)); },
  }, {
    name: 'command', label: 'Approved container command', description: `Execute only a preconfigured command name in an isolated container. Allowed: ${task.workflow.spec.commandNames.join(', ')}`,
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, args) {
      active(); if (verification.length >= 10) throw new Error('Command budget exceeded');
      const checked = await developmentCommand({ root, worktree: run.workspace, name: args.name, allowedNames: task.workflow.spec.commandNames, policy, runId: run.runId, signal: controller.signal });
      verification.push({ name: args.name, ok: checked.ok, summary: checked.output.slice(-1000) });
      return result(checked);
    },
  }, {
    name: 'request_decision', label: 'Ask manager or human', description: 'Stop and return a question. Use human for permission, requirement conflicts, scope expansion or preference; manager only for existing facts.',
    parameters: Type.Object({ question: Type.String(), reason: Type.String(), audience: Type.Union([Type.Literal('human'), Type.Literal('manager')]), options: Type.Array(Type.String()), impact: Type.String(), recommendation: Type.String() }),
    async execute(_id, args) { active(); question = args; return result({ status: 'blocked', question }); },
  }, {
    name: 'finish', label: 'Return development report', description: 'Return completed/continue/failed with summary. The supervisor independently validates changed paths and executed command results.',
    parameters: Type.Object({ status: Type.Union([Type.Literal('completed'), Type.Literal('continue'), Type.Literal('failed')]), summary: Type.String() }),
    async execute(_id, args) { active(); report = args; return result({ recorded: true }); },
  }];
  const runtime = await smokeRuntime({ authPath: request.authPath });
  const instructions = await readFile(new URL('../../agents/developer/WORKER_SYSTEM.md', import.meta.url), 'utf8');
  await smokeSession({ ...runtime, role: 'developer', prompt: JSON.stringify({ task, previous: request.previous, projectInstructions: request.projectInstructions }), systemPrompt: instructions, tools, run, signal: controller.signal, maxModelTokens: policy.maxModelTokens ?? 100000 });
  const changes = await workspaceChanges(run.workspace, task.workflow.spec.allowedPaths);
  if (question) report = { status: 'blocked', summary: question.question, question };
  if (!report) report = { status: 'continue', summary: 'No explicit completion report; inspect previous execution events before continuing.' };
  const latest = [...new Map(verification.map(item => [item.name, item])).values()];
  if (report.status === 'completed' && (latest.some(item => !item.ok) || task.workflow.spec.commandNames.filter(name => name !== 'install').some(name => !latest.some(item => item.name === name && item.ok)))) report = { status: 'blocked', summary: 'Required command verification is missing or failed.' };
  const output = { ...report, changedFiles: changes.changedFiles, verification: latest, fingerprints: changes.fingerprints };
  await saveJson(path.join(run.directory, 'worker-result.json'), output);
  process.stdout.write(JSON.stringify(output));
} catch {
  const output = { status: 'failed', summary: 'Development process stopped or failed; inspect public execution records before retrying.', changedFiles: [], verification: verification.slice(-20) };
  await saveJson(path.join(run.directory, 'worker-result.json'), output);
  process.stdout.write(JSON.stringify(output)); process.exitCode = 1;
}
finally { clearTimeout(timer); }
