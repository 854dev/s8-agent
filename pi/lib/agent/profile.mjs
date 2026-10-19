// 에이전트 모드 프로필. agents/<모드>/profile.json에 모드별 차이를 데이터로 둔다.
//   systemPrompt 시스템 프롬프트 파일(같은 디렉터리 기준)   extensions pi/extensions 아래 역할 확장
//   tools        허용 도구                                  workDir    cwd(실행 위치·--cwd) | kb(KB 저장소)
//   loadEnv      루트 .env의 연결 설정(Projectman 등)을 불러올지 여부
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../../..', import.meta.url));
export const MODES = ['general', 'manager', 'worker'];
// 이전 이름도 받는다(tmux 런타임 설정에 저장된 값 포함).
const ALIASES = { local: 'general', project: 'manager' };

/** 모드 이름을 정규화한다. 모르는 모드면 null. */
export const resolveMode = (name = 'general') => {
  const mode = ALIASES[name] ?? name;
  return MODES.includes(mode) ? mode : null;
};

/** 모드 프로필을 읽어 절대 경로로 풀어 돌려준다. */
export function loadProfile(mode, root = defaultRoot) {
  const directory = path.join(root, 'agents', mode);
  const profile = JSON.parse(readFileSync(path.join(directory, 'profile.json'), 'utf8'));
  return {
    mode,
    systemPrompt: path.join(directory, profile.systemPrompt),
    extensions: profile.extensions.map(name => path.join(root, 'pi/extensions', name)),
    tools: profile.tools,
    workDir: profile.workDir,
    loadEnv: profile.loadEnv === true,
  };
}
