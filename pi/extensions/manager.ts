import { fileURLToPath } from 'node:url';
import { recoverCompletionReviews } from '../lib/projectman/completion-review.mjs';
import { drainManagerInbox, managerInboxMessage } from '../lib/manager/inbox.mjs';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import projectman from './projectman.ts';
import { registerScheduler } from './scheduler.ts';
import { managerKb } from '../lib/manager/kb.mjs';
import { projectmanFromEnv } from '../lib/projectman/client.ts';
import { hasReviewedPreflight } from '../lib/projectman/preflight.mjs';
import { loadProfile } from '../lib/agent/profile.mjs';
import { startWork } from '../lib/agent/work.mjs';
import { loadS8Config, WORKER_MODES } from '../lib/config/s8-config.mjs';
import { modeOverride, queueInstruction, setWorkerMode, workerStatuses } from '../lib/agent/resident.mjs';
import { flushDevelopmentOutbox } from '../lib/development/outbox.mjs';
import { recordFinishedRuns } from '../lib/manager/run-results.mjs';
import { registerSecretFreeBash } from './secret-free-bash.ts';
import { registerCommunication } from './communication.mjs';

export const MANAGER_TOOLS: string[] = loadProfile('manager').tools;
// bash는 비밀값 환경변수를 지운 버전으로 대체한다.
export const MANAGER_EXTENSION_TOOLS = ['projectman', 'kb', 'scheduler', 'run_worker', 'set_worker_mode', 'agent_message', 'bash'];
const agentRoot = fileURLToPath(new URL('../..', import.meta.url));
const residentWorker = (id: string) => {
  const worker = loadS8Config(agentRoot).workers.find(item => item.id === id);
  if (!worker) throw new Error(`s8-config.yml의 workers에 없는 워커입니다: ${id}`);
  return worker;
};
export default function manager(pi: ExtensionAPI, { poll = true } = {}) {
  registerCommunication(pi, { root: agentRoot });
  const libraries = new Map<string, ReturnType<typeof managerKb>>();
  // Development runs go to a worker (run_worker); general shell work uses bash.
  projectman(pi);
  registerScheduler(pi, { projectmanOnly: true });
  registerSecretFreeBash(pi);
  pi.registerTool({
    name: 'kb', label: 'KB', description: 'KB Markdown search/get/policy/write/delete only. Read policy before editing. Writes require an interactive confirmation and expectedVersion from get (null for create). No code, links or hidden paths.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('search'), Type.Literal('get'), Type.Literal('policy'), Type.Literal('write'), Type.Literal('delete')]), query: Type.Optional(Type.String()), path: Type.Optional(Type.String()), content: Type.Optional(Type.String()), expectedVersion: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
    async execute(_id, args, _signal, _update, ctx) {
      let kb = libraries.get(ctx.cwd);
      if (!kb) { kb = managerKb(ctx.cwd); libraries.set(ctx.cwd, kb); }
      let result;
      if (args.action === 'search') result = await kb.search(args.query);
      else if (args.action === 'policy') result = await kb.guidelines();
      else if (args.action === 'get') result = await kb.document(args.path);
      else {
        if (!ctx.hasUI) throw new Error('KB changes require interactive user confirmation');
        if (args.expectedVersion === undefined) throw new Error('expectedVersion required');
        if (!await ctx.ui.confirm('KB 문서 변경', `${args.action}: ${args.path}\n${args.content ?? '문서를 삭제합니다.'}`)) throw new Error('KB change cancelled');
        result = args.action === 'write' ? await kb.write(args.path, args.content, args.expectedVersion) : await kb.delete(args.path, args.expectedVersion);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: undefined };
    },
  });
  pi.registerTool({
    name: 'run_worker', label: 'Run worker',
    description: 'Start a Projectman task or subtask UID in its task directory. Git and worktree setup are left to the Worker. With workerId, queue it for that resident worker from s8-config.yml (it starts when the worker is free, unless paused). Without workerId, start a one-off worker now, or resume a run this machine already claimed, in tmux window s8-workers:<UID>. The worker claims, implements and reports by itself; its report arrives through the manager inbox.',
    parameters: Type.Object({ uid: Type.String(), workerId: Type.Optional(Type.String()) }),
    async execute(_id, args) {
      if (args.workerId) {
        const worker = residentWorker(args.workerId);
        await queueInstruction(agentRoot, worker.id, args.uid, 'manager');
        const [status] = await workerStatuses(agentRoot, [worker]);
        return { content: [{ type: 'text', text: JSON.stringify({ queued: args.uid, worker: status }) }], details: undefined };
      }
      const result = await startWork(agentRoot, args.uid);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: undefined };
    },
  });
  pi.registerTool({
    name: 'set_worker_mode', label: 'Set worker mode',
    description: 'List resident workers (action list) or change one worker mode at runtime: active polls ready tasks, passive waits for run_worker with workerId or the console, paused takes no new work. mode default reverts to the s8-config.yml value. Change modes only when the user asks.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('list'), Type.Literal('set')]), workerId: Type.Optional(Type.String()), mode: Type.Optional(Type.Union([...WORKER_MODES.map(mode => Type.Literal(mode)), Type.Literal('default')])) }),
    async execute(_id, args) {
      const workers = loadS8Config(agentRoot).workers;
      if (args.action === 'set') {
        if (!args.workerId || !args.mode) throw new Error('set에는 workerId와 mode가 필요합니다.');
        await setWorkerMode(agentRoot, residentWorker(args.workerId).id, args.mode === 'default' ? null : args.mode);
      }
      return { content: [{ type: 'text', text: JSON.stringify({ workers: await workerStatuses(agentRoot, workers) }) }], details: undefined };
    },
  });
  pi.on('session_start', () => pi.setActiveTools(MANAGER_TOOLS));
  pi.on('tool_call', event => MANAGER_TOOLS.includes(event.toolName) ? undefined : { block: true, reason: 'Manager role does not permit this tool' });
  let timer: ReturnType<typeof setInterval> | undefined;
  const seen = new Set<string>();
  pi.on('session_start', (_event, ctx) => {
    clearInterval(timer);
    if (!poll) return;
    let checking = false;
    const check = async () => {
      if (checking || typeof ctx.isIdle !== 'function' || !ctx.isIdle()) return;
      checking = true;
      try {
        const root = fileURLToPath(new URL('../..', import.meta.url));
        const client = process.env.PHCMS_ACCESS_TOKEN ? projectmanFromEnv() : null;
        const tasks = client ? [...await client.list('task'), ...await client.list('subtask')] : [];
        if (client) {
          await recoverCompletionReviews(root, client);
          // 이 장비 워커의 보고 중 전달에 실패한 것을 다시 보낸다(매니저 inbox·Telegram 포함).
          await flushDevelopmentOutbox({ root, client });
          // 원격 워커의 보고는 Projectman에서 찾아 inbox에 넣는다.
          await recordFinishedRuns({ root, items: tasks });
        }
        await drainManagerInbox(root, report => {
          pi.sendMessage(managerInboxMessage(report), { triggerTurn: true, deliverAs: 'followUp' });
        });
        if (!client) return;
        // active 상주 워커가 있으면 ready 작업은 워커가 직접 맡으므로 매니저에게 알리지 않는다.
        const residentActive = (await Promise.all(loadS8Config(root).workers.map(async worker => (await modeOverride(root, worker.id) ?? worker.mode) === 'active'))).some(Boolean);
        for (const item of tasks) {
          const workflow = item.detail?.attributes.workflow as any;
          if (!workflow) continue;
          const key = `${item.uid}:${workflow.revision}`;
          const needsPreflight = item.detail?.attributes.state === 'todo' && !hasReviewedPreflight(item, workflow);
          const needsReview = item.detail?.attributes.state === 'review' && !workflow.managerReview;
          const humanQuestion = workflow.review?.pending;
          const readyToRun = !residentActive && item.detail?.attributes.state === 'ready' && workflow.grant && workflow.run?.status !== 'running';
          if (!seen.has(key) && (needsPreflight || humanQuestion || needsReview || readyToRun)) {
            seen.add(key);
            if (seen.size > 1000) seen.delete(seen.values().next().value!);
            pi.sendMessage({ customType: 'projectman-update', content: `Projectman 작업 ${item.uid}에 업데이트가 있습니다. workflow_get으로 현재 계획·실행·질문·결과를 확인하고 projectman-manager 스킬에 따라 필요한 조치를 판단하세요.`, display: true }, { triggerTurn: true, deliverAs: 'followUp' });
            break;
          }
        }
      } catch { /* Keep pending work in Projectman; retry on the next poll without exposing credentials. */ }
      finally { checking = false; }
    };
    void check();
    timer = setInterval(check, 15000);
    timer.unref();
  });
  pi.on('session_shutdown', () => { clearInterval(timer); });
}
