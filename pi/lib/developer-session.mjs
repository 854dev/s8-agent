import path from 'node:path';
import { readFile, appendFile } from 'node:fs/promises';
import { Type } from 'typebox';
import { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, createCodingTools, createGrepTool, createFindTool, createLsTool } from '@earendil-works/pi-coding-agent';
import { smokeRuntime, saveJson } from './development-smoke.mjs';
import { projectmanFromEnv } from './projectman-client.ts';
import guard from '../extensions/s8-guard.ts';
import { visible } from '../../apps/telegram-gateway/gateway.mjs';

/** A fresh Pi conversation for each UID, inside a persistent worker process. */
export async function executeDeveloper(request, { signal, client = projectmanFromEnv(), runtimeFactory = smokeRuntime } = {}) {
  const { root, run, task } = request;
  const settings = JSON.parse(await readFile(path.join(root, 'pi/settings.json'), 'utf8'));
  const runtime = await runtimeFactory({ authPath: path.join(root, '.pi-runtime/auth.json'), provider: settings.defaultProvider, modelId: settings.defaultModel });
  const systemPrompt = await readFile(path.join(root, 'agents/developer/WORKER_SYSTEM.md'), 'utf8');
  const settingsManager = SettingsManager.inMemory({ packages: [], compaction: { enabled: true } });
  const resourceLoader = new DefaultResourceLoader({ cwd: run.workspace, agentDir: run.directory, settingsManager,
    noExtensions: true, extensionFactories: [pi => guard(pi)],
    noSkills: true, noPromptTemplates: true, systemPrompt });
  await resourceLoader.reload();
  if (resourceLoader.getExtensions().errors.length) throw new Error('Worker guard could not load');
  let report, fetched = false, writes = Promise.resolve(), writeError;
  const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: undefined });
  const tools = [{
    name: 'projectman', label: 'Projectman work',
    description: 'Read your assigned work by UID using get. Finish once using report after implementation and verification. Report is durable; do not modify files afterwards. Failed work is recorded without automatic retry.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('get'), Type.Literal('report')]), uid: Type.String(),
      status: Type.Optional(Type.Union([Type.Literal('completed'), Type.Literal('failed')])), summary: Type.Optional(Type.String()),
      verification: Type.Optional(Type.Array(Type.Object({ name: Type.String(), ok: Type.Boolean(), summary: Type.String() }))),
      remainingItems: Type.Optional(Type.Array(Type.String())), decisions: Type.Optional(Type.Array(Type.String())), executionErrors: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, args) {
      if (args.uid !== task.uid || report) throw new Error('Only the assigned active work may be accessed');
      if (args.action === 'get') {
        const current = await client.getWorkflow(task.uid);
        if (current.state !== 'doing' || current.workflow?.run?.id !== run.runId || current.executionAllowed === false) throw new Error('Assignment is no longer active');
        fetched = true;
        return json({ ...current, projectInstructions: request.projectInstructions, baseCommit: request.baseCommit });
      }
      if (!fetched || !['completed', 'failed'].includes(args.status) || !args.summary?.trim()) throw new Error('Read the assigned UID first, then report with status and summary');
      report = { status: args.status, summary: args.summary, verification: args.verification ?? [], remainingItems: args.remainingItems ?? [], decisions: args.decisions ?? [], executionErrors: args.executionErrors ?? [] };
      await saveJson(path.join(run.directory, 'worker-result.json'), report);
      return json({ recorded: true, runId: run.runId });
    },
  }];
  const codingTools = [...createCodingTools(run.workspace, { bash: { spawnHook: context => ({ ...context, env: Object.fromEntries(Object.entries(context.env).filter(([key]) => !/(?:TOKEN|PASSWORD|SECRET|API_KEY|ACCESS_KEY|AUTHORIZATION|COOKIE)/i.test(key))) }) } }), createGrepTool(run.workspace), createFindTool(run.workspace), createLsTool(run.workspace)].map(tool => ({ ...tool, async execute(...args) {
    if (!fetched || report || signal?.aborted) throw new Error('Read the assigned UID first; no changes after reporting');
    return tool.execute(...args);
  } }));
  const { session } = await createAgentSession({ cwd: run.workspace, agentDir: run.directory, ...runtime,
    modelRuntime: runtime.runtime, resourceLoader, settingsManager, sessionManager: SessionManager.create(run.workspace, path.join(run.directory, 'session')),
    tools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'projectman'], customTools: [...codingTools, ...tools] });
  await session.bindExtensions({ mode: 'print' });
  const unsubscribe = session.subscribe(event => {
    if (['tool_execution_start', 'tool_execution_end', 'message_end'].includes(event.type)) {
      const publicEvent = event.type === 'message_end' ? (event.message?.role === 'assistant' ? { type: 'assistant', text: event.message.content.filter(block => block.type === 'text').map(block => block.text).join(''), stopReason: event.message.stopReason, usage: event.message.usage } : null) : event;
      if (!publicEvent) return;
      const safe = visible(JSON.stringify(publicEvent));
      writes = writes.then(() => appendFile(path.join(run.directory, 'developer.events.jsonl'), `${safe}\n`, { mode: 0o600 })).catch(error => { writeError = error; void session.abort(); });
      if (event.type === 'tool_execution_start') process.stdout.write(`${run.runId}: ${event.toolName}\n`);
    }
  });
  const abort = () => { void session.abort(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('Work canceled');
    await session.prompt(`Assigned work UID: ${task.uid}\nRun ID: ${run.runId}\nRead it using projectman get, carry out the approved plan and verification, then call projectman report.`, { expandPromptTemplates: false });
    await writes;
    if (writeError) throw new Error('Execution recording failed');
    if (!report || signal?.aborted) throw new Error('Worker stopped without a completed report');
    const last = session.messages.filter(message => message.role === 'assistant').at(-1);
    if (last?.stopReason !== 'stop') throw new Error('Worker model did not finish normally');
    return { report };
  } finally { signal?.removeEventListener('abort', abort); unsubscribe(); session.dispose(); await writes; }
}
