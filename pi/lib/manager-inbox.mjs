import path from 'node:path';
import { readdir, readFile, open, rm } from 'node:fs/promises';
import { processAlive } from './worker-pool.mjs';
import { saveJson } from './development-smoke.mjs';

/** Delivery is acknowledged after injection; a crash in between may replay the report. */
export async function drainManagerInbox(root, deliver) {
  const directory = path.join(root, '.s8-runtime/manager-inbox');
  let files;
  try { files = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of files.sort()) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const file = path.join(directory, name), lockFile = `${file}.lock`;
    let lock;
    try { lock = await open(lockFile, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid;
      try { pid = Number(await readFile(lockFile, 'utf8')); } catch (readError) { if (readError.code === 'ENOENT') continue; throw readError; }
      if (!Number.isSafeInteger(pid) || pid < 1 || processAlive(pid)) continue;
      await rm(lockFile, { force: true });
      try { lock = await open(lockFile, 'wx', 0o600); }
      catch (retryError) { if (retryError.code === 'EEXIST') continue; throw retryError; }
    }
    await lock.writeFile(String(process.pid));
    try {
      const report = JSON.parse(await readFile(file, 'utf8'));
      if (report.receivedAt) continue;
      await deliver(report);
      await saveJson(file, { ...report, receivedAt: new Date().toISOString() });
    } finally { await lock.close(); await rm(lockFile, { force: true }); }
  }
}
