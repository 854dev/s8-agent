import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import { loadS8Config } from '../lib/config/s8-config.mjs';
import { localRequest, listenLocal } from '../lib/communication/local.mjs';
import { startWorkerConnection } from '../lib/communication/client.mjs';
import { sessionInbox } from '../lib/communication/session.mjs';

/** Existing Pi sessions receive messages directly; this never creates an agent or starts a task. */
export function registerCommunication(pi, { root, role, workerId, taskUid }) {
  let close, inbox, connection;
  const shutdown = async () => {
    inbox?.close(); inbox = null;
    await close?.(); close = null;
    await connection?.close(); connection = null;
  };
  pi.on('session_start', async (_event, ctx) => {
    await shutdown();
    const config = loadS8Config(root).communication;
    if (!config.enabled) return;
    inbox = sessionInbox(pi, ctx, { role, taskUid });
    try {
      if (role === 'manager') close = await listenLocal(root, 'pi:manager', input => inbox.receive(input));
      else {
        if (!config.managerUrl) throw new Error('Worker messaging requires communication.managerUrl');
        connection = await startWorkerConnection(config, workerId, { onMessage: input => inbox.receive(input) });
      }
    } catch (error) { await shutdown(); throw error; }
  });
  pi.on('session_shutdown', shutdown);
  pi.registerTool({
    name: 'agent_message', label: 'Agent message',
    description: 'Exchange text with existing connected sessions through Manager. Manager can list peers and send to Workers; Workers address Manager only. Messages never start agents or Projectman tasks, change worker modes or transfer files. Pending means queued, injected means added to session history; neither means completed. No offline delivery. Reply requires replyTo.',
    parameters: Type.Object({
      action: Type.Union(['list', 'request', 'reply', 'notice', 'proposal', 'result', 'status'].map(value => Type.Literal(value))),
      workerIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 20 })),
      text: Type.Optional(Type.String({ maxLength: 16000 })),
      requestId: Type.Optional(Type.String()), replyTo: Type.Optional(Type.String()),
      groupId: Type.Optional(Type.String()),
      taskUid: Type.Optional(Type.String()), sessionId: Type.Optional(Type.String()),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      if (!loadS8Config(root).communication.enabled) throw new Error('communication is disabled');
      if (args.action === 'list') {
        if (role !== 'manager') throw new Error('Only Manager can list peers');
        const result = await localRequest(root, 'communicator', { action: 'peers' });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: undefined };
      }
      if (role === 'worker' && args.workerIds) throw new Error('Workers can address Manager only');
      if (role === 'worker' && args.taskUid && args.taskUid !== taskUid) throw new Error('Worker messages cannot impersonate another task');
      const targets = role === 'manager' ? [...new Set(args.workerIds ?? [])] : ['manager'];
      if (!targets.length) throw new Error('Manager must specify workerIds');
      if (['status', 'reply'].includes(args.action) && targets.length !== 1) throw new Error('Reply and status require one specific recipient');
      if (args.action === 'status' && !args.requestId) throw new Error('status requires requestId');
      if (args.action !== 'status' && !args.text?.trim()) throw new Error('message text required');
      const requestId = args.requestId ?? randomUUID();
      const groupId = args.groupId ?? (targets.length > 1 ? requestId : undefined);
      const results = await Promise.all(targets.map(async target => {
        const targetRequestId = targets.length > 1 ? randomUUID() : requestId;
        const context = { requestId: targetRequestId, ...(groupId ? { groupId } : {}), ...(args.replyTo ? { replyTo: args.replyTo } : {}), ...(args.taskUid ?? taskUid ? { taskUid: args.taskUid ?? taskUid } : {}), ...(args.sessionId ? { sessionId: args.sessionId } : {}) };
        const type = args.action === 'status' ? 'request.status' : `agent.${args.action}`;
        const payload = args.action === 'status' ? { requestId: targetRequestId } : { text: args.text, sourceSessionId: ctx.sessionManager.getSessionId() };
        const result = role === 'manager'
          ? await localRequest(root, 'communicator', { action: 'send', workerId: target, type, payload, context }, { timeoutMs: 32_000 })
          : await connection?.request(type, payload, context) ?? { state: 'unavailable' };
        return { workerId: target, requestId: targetRequestId, ...result };
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ requestId, ...(groupId ? { groupId } : {}), results }) }], details: undefined };
    },
  });
}
