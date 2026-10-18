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
let report;
const verification = [];
try {
  const workspace = developmentWorkspace(run.workspace);
  const active = () => { if (report || controller.signal.aborted) throw new Error('Development work is stopped'); };
  const tools = [{
    name: 'workspace', label: 'Development workspace', description: 'Read/list the isolated repository; write or remove regular source files. No credentials, links or hidden runtime paths.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('read'), Type.Literal('list'), Type.Literal('write'), Type.Literal('remove')]), path: Type.Optional(Type.String()), content: Type.Optional(Type.String()) }),
    async execute(_id, args) { active(); return result(args.action === 'write' ? await workspace.write(args.path, args.content) : args.action === 'remove' ? await workspace.remove(args.path) : args.action === 'list' ? await workspace.list(args.path ?? '') : await workspace.read(args.path)); },
  }, {
    name: 'command', label: 'Development command', description: 'Execute a shell command in the isolated repository container, or a configured command by name. Commands are not limited by the plan.',
    parameters: Type.Object({ name: Type.Optional(Type.String()), command: Type.Optional(Type.String()) }),
    async execute(_id, args) {
      active(); if (!args.name && !args.command) throw new Error('name or command required');
      const checked = await developmentCommand({ root, worktree: run.workspace, name: args.name, command: args.command, policy, runId: run.runId, signal: controller.signal });
      verification.push({ name: (args.name ?? args.command).slice(0, 100), ok: checked.ok, summary: checked.output.slice(-1000) });
      return result(checked);
    },
  }, {
    name: 'finish', label: 'Return development report', description: 'Return completed/continue/failed with summary. The supervisor independently validates changed paths and executed command results.',
    parameters: Type.Object({ status: Type.Union([Type.Literal('completed'), Type.Literal('continue'), Type.Literal('failed')]), summary: Type.String(), remainingItems: Type.Array(Type.String()), decisions: Type.Array(Type.String()), executionErrors: Type.Array(Type.String()), checkpoint: Type.String() }),
    async execute(_id, args) { active(); report = args; return result({ recorded: true }); },
  }];
  const runtime = await smokeRuntime({ authPath: request.authPath });
  const instructions = await readFile(new URL('../../agents/developer/WORKER_SYSTEM.md', import.meta.url), 'utf8');
  await smokeSession({ ...runtime, role: 'developer', prompt: JSON.stringify({ task, preflight: request.preflight, previous: request.previous, projectInstructions: request.projectInstructions }), systemPrompt: instructions, tools, run, signal: controller.signal, maxModelTokens: policy.maxModelTokens ?? 100000 });
  const changes = await workspaceChanges(run.workspace);
  if (!report) report = { status: 'continue', summary: 'No explicit completion report; resume using saved execution events.', remainingItems: ['Finish the planned work and verification'], decisions: [], executionErrors: [], checkpoint: 'Inspect the previous execution events and saved workspace.' };
  const latest = [...new Map(verification.map(item => [item.name, item])).values()];
  if (report.status === 'completed' && (report.remainingItems.length || report.executionErrors.length || latest.some(item => !item.ok) || task.workflow.spec.commandNames.filter(name => name !== 'install').some(name => !latest.some(item => item.name === name && item.ok)))) report = { ...report, status: 'continue', summary: `Required command verification is missing or failed. Repair and run the planned checks in the next execution. ${report.summary}`.slice(0, 8000) };
  const output = { ...report, baseCommit: request.baseCommit, changedFiles: changes.changedFiles, verification: latest, fingerprints: changes.fingerprints };
  await saveJson(path.join(run.directory, 'worker-result.json'), output);
  process.stdout.write(JSON.stringify(output));
} catch (error) {
  const resumable = controller.signal.aborted || error.code === 'BUDGET_EXHAUSTED';
  const output = { status: resumable ? 'continue' : 'failed', summary: 'Development process stopped; saved execution records and workspace are available.', remainingItems: ['Resume from saved execution records'], decisions: [], executionErrors: resumable ? [] : ['Worker execution failed'], checkpoint: 'Inspect saved workspace and execution events.', changedFiles: [], verification: verification.slice(-20) };
  await saveJson(path.join(run.directory, 'worker-result.json'), output);
  process.stdout.write(JSON.stringify(output)); process.exitCode = 1;
}
finally { clearTimeout(timer); }
