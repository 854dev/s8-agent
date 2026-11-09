// KB 구축 전문 역할. Projectman 작업 루프 없이 매니저와 통신하고 파일·셸 작업을 수행한다.
import { fileURLToPath } from 'node:url';
import { loadProfile } from '../lib/agent/profile.mjs';
import { loadS8Config } from '../lib/config/s8-config.mjs';
import { registerCommunication } from './communication.mjs';
import { registerSecretFreeBash } from './secret-free-bash.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const { tools } = loadProfile('kb');

export default function kb(pi) {
  const config = loadS8Config(root);
  registerCommunication(pi, { root, tokenFile: config.kbAgent.tokenFile });
  registerSecretFreeBash(pi);
  pi.on('session_start', (_event, ctx) => {
    pi.setActiveTools(tools);
    if (!config.communication.enabled && ctx.hasUI) ctx.ui.notify('KB 에이전트: 매니저 통신이 꺼져 있습니다. config.yml의 communication 설정을 확인하세요.', 'info');
  });
  pi.on('tool_call', event => tools.includes(event.toolName) ? undefined : { block: true, reason: 'KB role does not permit this tool' });
}
