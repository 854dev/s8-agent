import { fileURLToPath } from 'node:url';
import { runCounterSmoke, smokeRuntime } from '../lib/development-smoke.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
if (args[0] === '--help') {
  console.log('node pi/bin/counter-smoke.mjs [--check] [--auth-path PATH] [--provider NAME] [--model ID]\nActual model manager/developer smoke test; local Projectman test backend, Docker-only build/test. No .env loading.');
} else {
  const options = { root, onProgress: message => console.log(message) };
  let check = false;
  try {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--check') check = true;
      else if (['--auth-path', '--provider', '--model'].includes(args[i]) && args[i + 1]) {
        const key = { '--auth-path': 'authPath', '--provider': 'provider', '--model': 'modelId' }[args[i]];
        options[key] = args[++i];
      } else throw new Error('Unsupported smoke option');
    }
    if (check) {
      const { model } = await smokeRuntime(options);
      console.log(JSON.stringify({ authenticated: true, provider: model.provider, model: model.id }));
    } else {
      const result = await runCounterSmoke(options);
      console.log(JSON.stringify({ ok: result.ok, backend: result.backend, runId: result.runId, workspace: result.workspace, record: `${result.directory}/result.json` }, null, 2));
      process.exitCode = result.ok ? 0 : 1;
    }
  } catch { console.error('Model/auth preflight failed or invalid options. Credentials were not printed.'); process.exitCode = 1; }
}
