#!/usr/bin/env node
// s8-config.yml 확인·내보내기. 비밀값(.env)은 읽지 않는다.
//   show            검증한 설정을 JSON으로 출력
//   shell-env       라우터·frontend 개발 서버용 export 줄 출력. eval "$(node pi/bin/s8-config.mjs shell-env)"로 쓴다
//   start-command   projectman.startCommand 출력(없으면 빈 출력)
import { loadS8Config, settingsEnv } from '../lib/config/s8-config.mjs';

try {
  const [action = 'show', ...rest] = process.argv.slice(2);
  if (rest.length) throw new Error('Usage: node pi/bin/s8-config.mjs [show|shell-env|start-command]');
  const config = loadS8Config();
  if (action === 'show') console.log(JSON.stringify(config, null, 2));
  else if (action === 'shell-env') {
    const { S8_KB_ROOT, S8_BIND_IP, S8_HTTP_PORT } = settingsEnv(config);
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    for (const [name, value] of Object.entries({ S8_KB_ROOT, S8_BIND_IP, S8_HTTP_PORT })) console.log(`export ${name}=${quote(value)}`);
  } else if (action === 'start-command') process.stdout.write(config.projectman.startCommand ?? '');
  else throw new Error('Usage: node pi/bin/s8-config.mjs [show|shell-env|start-command]');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
