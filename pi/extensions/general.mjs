// 범용 에이전트 역할: 프로필의 기본 도구(파일·셸·검색)만 허용한다.
import { loadProfile } from '../lib/agent/profile.mjs';

const { tools } = loadProfile('general');
export default function general(pi) {
  pi.on('session_start', () => pi.setActiveTools(tools));
  pi.on('tool_call', event => tools.includes(event.toolName) ? undefined : { block: true, reason: 'General mode does not permit this tool' });
}
