// comm-center protocol v1. Shared by the server and the dependency-free client.
// Agents exchange text only; the center fills `from` from the authenticated identity.

export const VERSION = 1;
export const MAX_BYTES = 64 * 1024;
export const MAX_TEXT = 16_000;
export const MAX_PENDING = 100;
export const REQUEST_TIMEOUT_MS = 30_000;
export const HELLO_TIMEOUT_MS = 5_000;
// The center sends `ping` frames this often; clients drop a connection silent for three intervals.
export const HEARTBEAT_MS = 15_000;
export const MESSAGE_TYPES = ['request', 'reply', 'notice', 'proposal', 'result'];
export const ACK_STATES = ['pending', 'injected', 'rejected'];
export const ROLES = ['manager', 'worker'];
export const AGENT_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const ID = /^[A-Za-z0-9_-]{1,120}$/;
export const CLOSE = { version: 4000, unauthorized: 4001, duplicate: 4009, policy: 1008 };

/** Managers address Workers; Workers address Managers. Workers never address each other. */
export const canRoute = (fromRole, toRole) => (fromRole === 'manager' && toRole === 'worker') || (fromRole === 'worker' && toRole === 'manager');

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const optional = (pattern, value) => value === undefined || matches(pattern, value);
const shapes = {
  hello: ['version', 'token'],
  send: ['id', 'to', 'type', 'text', 'replyTo', 'groupId'],
  ack: ['for', 'from', 'state', 'reason'],
  status: ['id', 'messageId'],
  peers: ['id'],
};

/** Validate one client frame. Errors never include frame contents. */
export function parseFrame(value) {
  const fail = () => { throw new Error('comm-center: invalid frame'); };
  if (!object(value) || !Object.hasOwn(shapes, value.kind)) fail();
  if (Object.keys(value).some(key => key !== 'kind' && !shapes[value.kind].includes(key))) fail();
  switch (value.kind) {
    case 'hello':
      if (!Number.isInteger(value.version) || typeof value.token !== 'string') fail();
      break;
    case 'send':
      // Workers may omit `to`; the center routes them to the registered manager.
      if (!matches(ID, value.id) || !optional(AGENT_ID, value.to) || !MESSAGE_TYPES.includes(value.type)) fail();
      if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > MAX_TEXT) fail();
      if (!optional(ID, value.replyTo) || !optional(ID, value.groupId)) fail();
      if (value.type === 'reply' && !value.replyTo) fail();
      break;
    case 'ack':
      if (!matches(ID, value.for) || !matches(AGENT_ID, value.from) || !ACK_STATES.includes(value.state)) fail();
      if (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 200)) fail();
      break;
    case 'status':
      if (!matches(ID, value.id) || !matches(ID, value.messageId)) fail();
      break;
    case 'peers':
      if (!matches(ID, value.id)) fail();
      break;
  }
  return value;
}
