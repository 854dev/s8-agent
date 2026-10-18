import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import projectman from './projectman.ts';
import { registerScheduler } from './scheduler.ts';
import { managerKb } from '../lib/manager-kb.mjs';
import { projectmanFromEnv } from '../lib/projectman-client.ts';
import { hasReviewedPreflight } from '../lib/projectman-preflight.mjs';
import { MANAGER_TOOLS } from '../lib/manager-launch.mjs';

export { MANAGER_TOOLS };
export const MANAGER_EXTENSION_TOOLS = ['projectman', 'kb', 'scheduler'];
export default function manager(pi: ExtensionAPI, { poll = true } = {}) {
  const libraries = new Map<string, ReturnType<typeof managerKb>>();
  // Development runs stay with the supervisor; general shell work uses bash.
  projectman(new Proxy(pi, { get(target, key) {
    if (key === 'registerTool') return tool => target.registerTool({ ...tool, async execute(id, args, ...rest) {
      if (args.action === 'intake_source' && args.sourcePath !== undefined) throw new Error('Manager cannot read source files; capture a user message instead');
      return tool.execute(id, args, ...rest);
    } });
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } }));
  registerScheduler(pi, { projectmanOnly: true });
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
  pi.on('session_start', () => pi.setActiveTools(MANAGER_TOOLS));
  pi.on('tool_call', event => MANAGER_TOOLS.includes(event.toolName) ? undefined : { block: true, reason: 'Manager role does not permit this tool' });
  let timer: ReturnType<typeof setInterval> | undefined;
  const seen = new Set<string>();
  pi.on('session_start', (_event, ctx) => {
    clearInterval(timer);
    if (!poll) return;
    let checking = false;
    timer = setInterval(async () => {
      if (checking || !ctx.isIdle() || !process.env.PHCMS_ACCESS_TOKEN) return;
      checking = true;
      try {
        const client = projectmanFromEnv();
        const tasks = [...await client.list('task'), ...await client.list('subtask')];
        for (const item of tasks) {
          const workflow = item.detail?.attributes.workflow as any;
          if (!workflow) continue;
          const key = `${item.uid}:${workflow.revision}`;
          const needsPreflight = item.detail?.attributes.state === 'todo' && !hasReviewedPreflight(item, workflow);
          const needsReview = item.detail?.attributes.state === 'review' && !workflow.managerReview;
          const needsFollowup = item.detail?.attributes.state === 'ready' && workflow.review?.decision === 'resume' && workflow.followup?.reviewId !== workflow.review.id;
          const humanQuestion = workflow.review?.pending;
          const incomplete = item.detail?.attributes.state === 'blocked' && workflow.result && !workflow.review?.pending;
          if (!seen.has(key) && (needsPreflight || needsReview || needsFollowup || humanQuestion || incomplete)) {
            seen.add(key);
            if (seen.size > 1000) seen.delete(seen.values().next().value!);
            pi.sendMessage({ customType: 'projectman-update', content: `Projectman 작업 ${item.uid}에 새 계획·결과·장애가 있습니다. workflow_get으로 확인하세요. 실행 전 사람과 대화하고 최종 계획을 확정하세요. 확정 후 개발자의 구현 결정을 질문으로 돌리지 마세요. 미완료·판단·실행 장애·체크포인트를 검토하고 기존 계획이면 retry로 복구하며, 예산 소진 시 결과를 보존하세요. 파일·명령 범위 제한이나 부모 권한 검증은 요구하지 마세요. 완료 결과는 review_result로 검토하고 최종 완료와 구분하세요.`, display: true }, { triggerTurn: true, deliverAs: 'followUp' });
            break;
          }
        }
      } catch { /* Keep pending work in Projectman; retry on the next poll without exposing credentials. */ }
      finally { checking = false; }
    }, 15000);
    timer.unref();
  });
  pi.on('session_shutdown', () => { clearInterval(timer); });
}
