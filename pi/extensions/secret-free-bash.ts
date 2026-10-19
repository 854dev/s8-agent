// 비밀값 환경변수(토큰·키·비밀번호 등)를 지운 bash로 기본 bash를 대체한다. 에이전트가 env 출력으로 비밀값을 보는 일을 막는다.
// 같은 사용자 권한의 셸이므로 완전한 격리는 아니다(/proc의 부모 환경 등). 사고성 노출을 줄이는 장치다.
import { createBashTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const SECRET = /(?:TOKEN|PASSWORD|SECRET|API_KEY|ACCESS_KEY|AUTHORIZATION|COOKIE)/i;

export function registerSecretFreeBash(pi: ExtensionAPI, cwd = process.cwd()) {
  const bash = createBashTool(cwd, { spawnHook: context => ({ ...context, env: Object.fromEntries(Object.entries(context.env).filter(([key]) => !SECRET.test(key))) }) });
  pi.registerTool({ ...bash, execute: (id, params, signal, onUpdate) => bash.execute(id, params, signal, onUpdate) });
}
