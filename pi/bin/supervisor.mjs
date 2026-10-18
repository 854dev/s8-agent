import { fileURLToPath } from 'node:url';
import { ensureWorkerPool } from '../lib/development/worker-pool.mjs';
import { supervisorOwner } from '../lib/runtime/services.mjs';
import { projectmanFromEnv } from '../lib/projectman/client.ts';
import { loadDevelopmentPolicy, developmentTick, recoverDevelopmentRuns, waitForDevelopmentRuns } from '../lib/development/supervisor.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
if (process.argv.includes('--help')) console.log('node pi/bin/supervisor.mjs [--once|--check]\nPoll authorized Projectman development work; assign UIDs to persistent Pi workers. Credentials must already be loaded.');
else {
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
  let releaseOwner;
  try {
    const policy = await loadDevelopmentPolicy(root), client = projectmanFromEnv();
    const capabilities = await client.capabilities();
    if (capabilities.workflowVersion !== 2 || capabilities.atomicClaims !== true || capabilities.idempotentReports !== true) throw new Error('Projectman v2 atomic claims and idempotent reports required');
    if (process.argv.includes('--check')) {
      const workspaces = await client.list('workspace');
      console.log(JSON.stringify({ projectmanAuthenticated: true, workspaces: workspaces.length, capabilities, maxConcurrency: policy.maxConcurrency }));
      process.exitCode = capabilities.workflowVersion === 2 ? 0 : 1;
    } else {
      releaseOwner = await supervisorOwner(root);
      await ensureWorkerPool(root);
      await recoverDevelopmentRuns({ root, client });
      do {
        await recoverDevelopmentRuns({ root, client });
        const results = await developmentTick({ root, client, policy, signal: controller.signal });
        for (const result of results) console.log(JSON.stringify(result));
        if (process.argv.includes('--once') || controller.signal.aborted) break;
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, 5000);
          controller.signal.addEventListener('abort', done, { once: true });
          if (controller.signal.aborted) done();
        });
      } while (!controller.signal.aborted);
    }
  } catch (error) {
    const status = /HTTP (\d+)/.exec(error.message ?? '')?.[1];
    const reason = status ? `Projectman HTTP ${status}` : error.code === 'EEXIST' ? 'A supervisor is running or its owner lock needs inspection' : /required/.test(error.message ?? '') ? 'Required connection configuration is missing' : 'Connection or trusted policy unavailable';
    console.error(`Development supervisor unavailable: ${reason}. Credentials were not printed.`); process.exitCode = 1;
  } finally { await waitForDevelopmentRuns(root); await releaseOwner?.(); }
}
