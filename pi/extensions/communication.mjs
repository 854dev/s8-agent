import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import { loadS8Config } from '../lib/config/s8-config.mjs';
import { sessionInbox } from '../lib/communication/session.mjs';
// Imported by path so Pi needs no extra install; the client uses only Node built-ins.
import { connectCommCenter } from '../../apps/comm-center/client.mjs';
import { readTokenFile } from '../../apps/comm-center/registry.mjs';

const ALERTS = { UNAUTHORIZED: 'comm-center rejected this token', VERSION_MISMATCH: 'comm-center protocol version differs; update both sides', DUPLICATE_AGENT: 'another session is already connected with this token' };
const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: undefined });

/** Connect this session to comm-center. Identity and role come from the token; this never creates agents or starts tasks. */
export function registerCommunication(pi, { root }) {
  let inbox, client;
  const shutdown = async () => {
    inbox?.close(); inbox = null;
    await client?.close(); client = null;
  };
  pi.on('session_start', async (_event, ctx) => {
    await shutdown();
    const config = loadS8Config(root).communication;
    if (!config.enabled) return;
    let token;
    // S8_COMM_TOKEN_FILE lets several sessions in one checkout use separate identities.
    try { token = await readTokenFile(process.env.S8_COMM_TOKEN_FILE || config.tokenFile); }
    catch (error) { if (ctx.hasUI) ctx.ui.notify(error.message, 'error'); return; }
    let alerted;
    inbox = sessionInbox(pi, ctx, {
      onInjected: message => client?.ack(message, 'injected'),
      onExpired: message => client?.ack(message, { state: 'rejected', reason: 'Expired before the session became idle' }),
    });
    client = connectCommCenter({
      url: config.url, token,
      onMessage: message => inbox.receive(message),
      onState: (connected, error) => {
        if (connected) { alerted = null; return; }
        if (ALERTS[error] && alerted !== error && ctx.hasUI) ctx.ui.notify(`Communication: ${ALERTS[error]}`, 'warning');
        alerted = error;
      },
    });
  });
  pi.on('session_shutdown', shutdown);
  pi.registerTool({
    name: 'agent_message', label: 'Agent message',
    description: 'Exchange text with connected agents through comm-center. Managers list peers and address Workers with to; Workers reach the Manager and may omit to. Messages never start agents, change worker modes or transfer files; a Worker may carry out Manager instructions with its existing tools and approvals. pending means queued in the recipient session, injected means added to its history; neither means completed. No offline delivery. reply requires replyTo (the received message id); status takes messageId.',
    parameters: Type.Object({
      action: Type.Union(['list', 'request', 'reply', 'notice', 'proposal', 'result', 'status'].map(value => Type.Literal(value))),
      to: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 20 })),
      text: Type.Optional(Type.String({ maxLength: 16000 })),
      replyTo: Type.Optional(Type.String()), groupId: Type.Optional(Type.String()), messageId: Type.Optional(Type.String()),
    }),
    async execute(_id, args) {
      if (!client) throw new Error('Communication is disabled or its token file is unavailable');
      const unavailable = result => result.state === 'unavailable' && client.lastError ? { ...result, connection: client.lastError } : result;
      if (args.action === 'list') return json(unavailable(await client.peers()));
      if (args.action === 'status') {
        if (!args.messageId) throw new Error('status requires messageId');
        return json(unavailable(await client.status(args.messageId)));
      }
      if (!args.text?.trim()) throw new Error('message text required');
      const targets = args.to ? [...new Set(args.to)] : [undefined];
      if (args.action === 'reply' && (!args.replyTo || targets.length !== 1)) throw new Error('reply requires replyTo and one recipient');
      const groupId = args.groupId ?? (targets.length > 1 ? randomUUID() : undefined);
      const results = await Promise.all(targets.map(async to => unavailable(await client.send({ to, type: args.action, text: args.text, replyTo: args.replyTo, groupId }))));
      return json({ ...(groupId ? { groupId } : {}), results });
    },
  });
}
