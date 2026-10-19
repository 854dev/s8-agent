// Projectman 워커 역할: UID 하나를 직접 claim해 수행하고 결과를 보고한다.
// - projectman get: claim(이미 claim했으면 이어감) 후 작업 내용 반환. 세션은 처음 claim한 UID에 고정된다.
// - projectman report: 결과 보고. 보고 후에는 파일·명령 도구를 막는다.
// - claim 전에는 projectman 외 도구를 막고, bash에는 비밀정보 환경변수를 넘기지 않는다.
// S8_WORKER_UID가 있으면 그 UID만 다룬다(start-pi.sh --mode worker --uid).
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { createBashTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { projectmanFromEnv } from '../lib/projectman/client.ts';
import { loadProfile } from '../lib/agent/profile.mjs';
import { claimWork, reportWork, stillActive } from '../lib/agent/worker-run.mjs';

export const WORKER_TOOLS: string[] = loadProfile('worker').tools;
const SECRET = /(?:TOKEN|PASSWORD|SECRET|API_KEY|ACCESS_KEY|AUTHORIZATION|COOKIE)/i;
const CHECK_INTERVAL_MS = 30_000;
const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: undefined });

export default function worker(pi: ExtensionAPI, { root = fileURLToPath(new URL('../..', import.meta.url)), client = projectmanFromEnv(), workerId = process.env.S8_WORKER_ID || 's8-developer' } = {}) {
  const assigned = process.env.S8_WORKER_UID || undefined;
  let claim: any, reported = false, checkedAt = 0;

  pi.registerTool({
    name: 'projectman', label: 'Projectman work',
    description: 'Work on one Projectman task or subtask by UID. get claims it (or resumes your claim) and returns the approved plan; call it first. report records the result once after implementation and verification; do not change files afterwards.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('get'), Type.Literal('report')]), uid: Type.String(),
      status: Type.Optional(Type.Union([Type.Literal('completed'), Type.Literal('failed')])), summary: Type.Optional(Type.String()),
      verification: Type.Optional(Type.Array(Type.Object({ name: Type.String(), ok: Type.Boolean(), summary: Type.String() }))),
      remainingItems: Type.Optional(Type.Array(Type.String())), decisions: Type.Optional(Type.Array(Type.String())), executionErrors: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      const uid = claim?.uid ?? assigned;
      if (uid && args.uid !== uid) throw new Error(`이 세션은 ${uid}만 다룹니다.`);
      if (reported) throw new Error('이미 보고했습니다. 턴을 끝내세요.');
      if (args.action === 'get') {
        const result = await claimWork({ root, client, uid: args.uid, workerId });
        claim = result.claim; checkedAt = Date.now();
        return json(result.work);
      }
      if (!claim) throw new Error('먼저 projectman get으로 작업을 claim하세요.');
      if (!args.status || !args.summary?.trim()) throw new Error('report에는 status와 summary가 필요합니다.');
      const { action: _action, uid: _uid, ...result } = args;
      const outcome = await reportWork({ root, client, claim, result, cwd: ctx.cwd });
      reported = true;
      return json(outcome);
    },
  });

  // 비밀정보 환경변수를 제거한 bash로 기본 bash를 대체한다.
  const bash = createBashTool(process.cwd(), { spawnHook: context => ({ ...context, env: Object.fromEntries(Object.entries(context.env).filter(([key]) => !SECRET.test(key))) }) });
  pi.registerTool({ ...bash, execute: (id, params, signal, onUpdate) => bash.execute(id, params, signal, onUpdate) });

  pi.on('session_start', () => pi.setActiveTools(WORKER_TOOLS));
  pi.on('tool_call', async event => {
    if (!WORKER_TOOLS.includes(event.toolName)) return { block: true, reason: 'Worker role does not permit this tool' };
    if (event.toolName === 'projectman') return undefined;
    if (!claim) return { block: true, reason: '먼저 projectman get으로 작업을 claim하세요.' };
    if (reported) return { block: true, reason: '보고 후에는 파일·명령을 변경하지 않습니다.' };
    // 회수된 작업을 계속 수행하지 않도록 주기적으로 소유권을 확인한다. 일시적 조회 실패는 막지 않는다.
    if (Date.now() - checkedAt > CHECK_INTERVAL_MS) {
      checkedAt = Date.now();
      if (await stillActive(client, claim).catch(() => true) === false) {
        reported = true;
        return { block: true, reason: '작업이 회수되었습니다. 변경을 멈추고 턴을 끝내세요.' };
      }
    }
    return undefined;
  });
}
