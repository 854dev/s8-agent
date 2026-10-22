// comm-center entry point. Settings come from the environment (see .env.example); there are no secrets in it.
import { isIP } from 'node:net';
import { startCommCenter } from './server.mjs';

const fail = message => { console.error(`comm-center: ${message}`); process.exit(1); };
const agentsFile = process.env.COMM_CENTER_AGENTS_FILE;
const host = process.env.COMM_CENTER_HOST ?? '127.0.0.1';
const port = Number(process.env.COMM_CENTER_PORT ?? 8090);
if (!agentsFile) fail('COMM_CENTER_AGENTS_FILE is required');
// Bind to one specific address: loopback or the private network interface.
if (!isIP(host) || ['0.0.0.0', '::'].includes(host)) fail('COMM_CENTER_HOST must be a specific IP address');
if (!Number.isInteger(port) || port < 1 || port > 65535) fail('COMM_CENTER_PORT must be a port number');

let center;
try {
  // Logs carry connection and delivery metadata only, never message text or tokens.
  center = await startCommCenter({ agentsFile, host, port, onEvent: event => console.log(JSON.stringify(event)) });
} catch (error) { fail(error.message); }
console.log(`comm-center listening on ${host}:${center.address.port}`);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, async () => { await center.close(); process.exit(0); });
