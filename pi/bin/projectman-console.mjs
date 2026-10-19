import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { createProjectmanConsole } from '../lib/projectman/console.mjs';
import { loadEnv } from '../lib/agent/launch.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
// 멈춘 실행 마무리는 에이전트 서비스 키로 보고하므로 루트 .env의 연결 설정을 읽는다(값은 출력하지 않는다).
loadEnv(root);
const server = createProjectmanConsole({ root });
const index = process.argv.indexOf('--host');
const host = index < 0 ? '127.0.0.1' : process.argv[index + 1];
if (!host || isIP(host) !== 4 || host === '0.0.0.0') throw new Error('Bind the console API to a specific local/Tailscale IPv4 only');
server.listen(8791, host, () => console.log(`Projectman console API: http://${host}:8791/api/projectman`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
