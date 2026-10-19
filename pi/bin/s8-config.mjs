#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { agentRoot, loadS8Config, migrateLegacyWorkerCount, telegramConfigFromEnv } from '../lib/config/s8-config.mjs';

try {
  const [action = 'show'] = process.argv.slice(2);
  if (action === 'init') {
    const { source: _source, ...telegram } = telegramConfigFromEnv();
    await writeFile(path.join(agentRoot, 's8-config.yml'), stringify({ telegram, 'worker-entries': {
      'worker-1': { agent: 'pi', host: 'local', launch: 'managed' },
      'worker-2': { agent: 'pi', host: 'local', launch: 'managed' },
    }, 'worker-communicator': { bindAddress: '127.0.0.1', port: 38771, url: 'http://127.0.0.1:38771' }, publicUrl: null }), { flag: 'wx', mode: 0o600 });
    console.log('Created s8-config.yml from inherited Telegram IDs and two explicit local Pi worker entries. Existing files are never overwritten.');
    if (!telegram.scheduleChatId) console.log('scheduleChatId is not set; select an allowed recipient before unattended operation.');
  } else if (action === 'migrate-workers') {
    const result = migrateLegacyWorkerCount();
    console.log(`Migrated legacy worker slots to explicit IDs: ${result.workerIds.join(', ')}`);
  } else if (action === 'worker-token' || action === 'rotate-worker-token') {
    const workerId = process.argv[3], config = loadS8Config();
    if (!workerId || !config.workerEntries[workerId]) throw new Error('A configured worker ID is required');
    const { getWorkerState } = await import('../lib/development/worker-store.mjs');
    const { workerTokenForProvisioning, rotateWorkerToken } = await import('../lib/development/worker-auth.mjs');
    if (action === 'rotate-worker-token') {
      const state = await getWorkerState(agentRoot, workerId);
      if (state?.runId && !['idle', 'stopping'].includes(state.status)) throw new Error('Cannot rotate authentication while the worker owns an active or unknown run');
    }
    const file = action === 'worker-token' ? await workerTokenForProvisioning(agentRoot, workerId) : await rotateWorkerToken(agentRoot, workerId);
    console.log(`${action === 'worker-token' ? 'Worker token file' : 'Worker token rotated'}: ${file}`);
    console.log('Transfer this file securely to the worker device. The token is never printed; rotation invalidates the previous token.');
    process.exit(0);
  } else if (action !== 'show') throw new Error('Usage: node pi/bin/s8-config.mjs [init|show|migrate-workers|worker-token <workerId>|rotate-worker-token <workerId>]');
  console.log(JSON.stringify(loadS8Config(), null, 2));
} catch (error) {
  console.error(error.code === 'EEXIST' ? 's8-config.yml already exists; no settings were changed.' : error.message);
  process.exitCode = 1;
}
