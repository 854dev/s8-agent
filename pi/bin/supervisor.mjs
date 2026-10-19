import { fileURLToPath } from 'node:url';
import { ensureWorkerPool } from '../lib/development/worker-pool.mjs';
import { supervisorOwner } from '../lib/runtime/services.mjs';
import { projectmanFromEnv } from '../lib/projectman/client.ts';
import { loadDevelopmentPolicy, runDevelopmentLoop, waitForDevelopmentRuns } from '../lib/development/supervisor.mjs';
import { startWorkerCommunicator } from '../lib/development/worker-communicator.mjs';
import { loadS8Config } from '../lib/config/s8-config.mjs';
import { finishStoppedRunCommand } from '../lib/development/finish-stopped-run.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
if (process.argv.includes('--help')) console.log('node pi/bin/supervisor.mjs [--once|--check]\nnode pi/bin/supervisor.mjs --finish-stopped-run UID --run-id UUID --confirm-stopped\nPoll authorized Projectman development work; assign UIDs to persistent Pi workers. Credentials must already be loaded.');
else {
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
  let releaseOwner, communicator;
  try {
    const policy = await loadDevelopmentPolicy(root), client = projectmanFromEnv();
    const capabilities = await client.capabilities();
    if (capabilities.workflowVersion !== 2 || capabilities.atomicClaims !== true || capabilities.idempotentReports !== true) throw new Error('Projectman v2 atomic claims and idempotent reports required');
    if (process.argv.includes('--finish-stopped-run')) {
      console.log(JSON.stringify(await finishStoppedRunCommand(root, client, process.argv.slice(2))));
    } else if (process.argv.includes('--check')) {
      const workspaces = await client.list('workspace');
      console.log(JSON.stringify({ projectmanAuthenticated: true, workspaces: workspaces.length, capabilities, workerIds: Object.keys(policy.workerEntries), communicator: loadS8Config(root).workerCommunicator.url }));
      process.exitCode = capabilities.workflowVersion === 2 ? 0 : 1;
    } else {
      releaseOwner = await supervisorOwner(root);
      communicator = await startWorkerCommunicator({ root, entries: policy.workerEntries, settings: loadS8Config(root).workerCommunicator });
      await ensureWorkerPool(root);
      await runDevelopmentLoop({ root, client, policy, signal: controller.signal, once: process.argv.includes('--once') });
    }
  } catch (error) {
    const status = /HTTP (\d+)/.exec(error.message ?? '')?.[1];
    const reason = error.stoppedRunDiagnostic ?? (status ? `Projectman HTTP ${status}` : error.code === 'ELOCKED' ? 'A supervisor is already running' : /required/.test(error.message ?? '') ? 'Required connection configuration is missing' : 'Connection or trusted policy unavailable');
    console.error(`Development supervisor unavailable: ${reason}. Credentials were not printed.`); process.exitCode = 1;
  } finally { await waitForDevelopmentRuns(root); await communicator?.close(); await releaseOwner?.(); }
}
