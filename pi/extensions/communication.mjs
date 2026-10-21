import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import { loadS8Config } from '../lib/config/s8-config.mjs';
import { localRequest, listenLocal } from '../lib/communication/local.mjs';
import { sessionInbox } from '../lib/communication/session.mjs';
import { readClaim } from '../lib/agent/worker-run.mjs';

export function registerCommunication(pi, { root, role, workerId, taskUid, researchId }) {
  let close, inbox;
  const researchRequest = () => typeof researchId === 'function' ? researchId() : researchId;
  pi.on('session_start', async (_event, ctx) => {
    await close?.(); inbox?.close();
    if (!loadS8Config(root).communication.enabled) return;
    const requestId = researchRequest();
    if (role === 'worker' && !taskUid && !requestId) return;
    inbox = sessionInbox(pi, ctx, { role, taskUid });
    try { close = await listenLocal(root, role === 'manager' ? 'pi:manager' : `pi:${workerId}:${taskUid ?? requestId}`, input => inbox.receive(input)); }
    catch (error) { inbox.close(); throw error; }
  });
  pi.on('session_shutdown', async () => { inbox?.close(); await close?.(); close = null; });
  pi.registerTool({
    name: 'agent_message', label: 'Agent message',
    description: 'Communicate through Manager only. Manager can ask/follow up with Workers and fan out research; Workers ask, report findings/blockers or propose collaboration to Manager. A reply needs replyTo. Pending means queued for Pi, not read or completed. No offline delivery. Use status to check injection. Never expands Projectman approval.',
    parameters: Type.Object({
      action: Type.Union(['request', 'reply', 'notice', 'proposal', 'result', 'status'].map(value => Type.Literal(value))),
      workerIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 20 })),
      text: Type.Optional(Type.String({ maxLength: 16000 })),
      requestId: Type.Optional(Type.String()), replyTo: Type.Optional(Type.String()),
      groupId: Type.Optional(Type.String()),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: 'Soft response deadline for a research/question request; does not cancel execution. Default 300 seconds.' })),
      taskUid: Type.Optional(Type.String()), runId: Type.Optional(Type.String()), sessionId: Type.Optional(Type.String()),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      if (!loadS8Config(root).communication.enabled) throw new Error('communication is disabled');
      if (role === 'worker' && args.workerIds) throw new Error('Workers can address Manager only');
      if (role === 'worker' && args.taskUid && args.taskUid !== taskUid) throw new Error('Worker messages cannot impersonate another task');
      const targets = role === 'manager' ? [...new Set(args.workerIds ?? [])] : ['manager'];
      if (!targets.length) throw new Error('Manager must specify workerIds');
      if (['status', 'reply'].includes(args.action) && targets.length !== 1) throw new Error('Reply and status require one specific recipient');
      if (args.action === 'status' && !args.requestId) throw new Error('status requires requestId');
      if (args.action !== 'status' && !args.text?.trim()) throw new Error('message text required');
      const researchId = researchRequest();
      const claim = role === 'worker' && taskUid ? await readClaim(root, taskUid) : null;
      if (role === 'worker' && args.runId && args.runId !== claim?.runId) throw new Error('Worker run identity mismatch');
      const requestId = args.requestId ?? researchId ?? randomUUID();
      const groupId = args.groupId ?? (targets.length > 1 ? requestId : undefined);
      const results = await Promise.all(targets.map(async target => {
        const targetRequestId = targets.length > 1 ? randomUUID() : requestId;
        const context = { requestId: targetRequestId, ...(groupId ? { groupId } : {}), ...(args.replyTo ? { replyTo: args.replyTo } : {}), ...(args.taskUid ?? taskUid ? { taskUid: args.taskUid ?? taskUid } : {}), ...(args.runId ?? claim?.runId ? { runId: args.runId ?? claim.runId } : {}), ...(args.sessionId ? { sessionId: args.sessionId } : {}) };
        const result = await localRequest(root, role === 'manager' ? 'communicator' : `worker:${workerId}`, {
          action: 'send', workerId: target,
          type: args.action === 'status' ? 'request.status' : `agent.${args.action}`,
          payload: args.action === 'status' ? { requestId: targetRequestId } : { text: args.text, sourceSessionId: ctx.sessionManager.getSessionId(), ...(researchId ? { researchId } : {}), ...(args.action === 'request' ? { deadlineAt: new Date(Date.now() + (args.timeoutSeconds ?? 300) * 1000).toISOString() } : {}) }, context,
        }, { timeoutMs: 32_000 });
        return { workerId: target, requestId: targetRequestId, ...result };
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ requestId, ...(groupId ? { groupId } : {}), results }) }], details: undefined };
    },
  });
}
