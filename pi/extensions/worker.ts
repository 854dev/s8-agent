// Projectman 워커 역할: UID 하나를 직접 claim해 수행하고 결과를 보고한다.
// - projectman get: claim(이미 claim했으면 이어감) 후 작업 내용 반환.
// - projectman report: 에이전트가 판단한 결과 보고.
// - 작업 순서와 범위는 프롬프트로 안내한다. bash에는 비밀정보 환경변수를 넘기지 않는다.
// S8_WORKER_UID는 초기 작업과 통신 컨텍스트로 사용한다.
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerSecretFreeBash } from './secret-free-bash.ts';
import { projectmanFromEnv } from '../lib/projectman/client.ts';
import { loadProfile } from '../lib/agent/profile.mjs';
import { claimWork, reportWork } from '../lib/agent/worker-run.mjs';
import { registerCommunication } from './communication.mjs';

export const WORKER_TOOLS: string[] = loadProfile('worker').tools;
const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: undefined });

export default function worker(pi: ExtensionAPI, { root = fileURLToPath(new URL('../..', import.meta.url)), client = undefined as any, workerId = process.env.S8_WORKER_ID || 's8-developer' } = {}) {
  // 클라이언트는 Projectman을 처음 쓸 때 만든다.
  const api = () => (client ??= projectmanFromEnv());
  const assigned = process.env.S8_WORKER_UID || undefined;
  registerCommunication(pi, { root, role: 'worker', workerId, taskUid: assigned });
  let claim: any;

  pi.registerTool({
    name: 'projectman', label: 'Projectman work',
    description: 'Read and claim a Projectman task with get; record your assessed outcome with report. Consult projectman and projectman-worker skills for usage; follow the system prompt and Manager instructions for execution.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('get'), Type.Literal('report')]), uid: Type.String(),
      status: Type.Optional(Type.Union([Type.Literal('completed'), Type.Literal('failed')])), summary: Type.Optional(Type.String()),
      verification: Type.Optional(Type.Array(Type.Object({ name: Type.String(), ok: Type.Boolean(), summary: Type.String() }))),
      remainingItems: Type.Optional(Type.Array(Type.String())), decisions: Type.Optional(Type.Array(Type.String())), executionErrors: Type.Optional(Type.Array(Type.String())),
      changedFiles: Type.Optional(Type.Array(Type.String(), { description: 'Files changed by this work, relative to the task directory.' })),
    }),
    async execute(_id, args) {
      if (args.action === 'get') {
        const result = await claimWork({ root, client: api(), uid: args.uid, workerId });
        claim = result.claim;
        return json(result.work);
      }
      if (!args.status || !args.summary?.trim()) throw new Error('report에는 status와 summary가 필요합니다.');
      if (!claim || claim.uid !== args.uid) claim = (await claimWork({ root, client: api(), uid: args.uid, workerId })).claim;
      const { action: _action, uid: _uid, ...result } = args;
      const outcome = await reportWork({ root, client: api(), claim, result });
      return json(outcome);
    },
  });

  registerSecretFreeBash(pi);

  pi.on('session_start', () => pi.setActiveTools(WORKER_TOOLS));
}
