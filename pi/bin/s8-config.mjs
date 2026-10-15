#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { agentRoot, loadTelegramConfig, telegramConfigFromEnv } from '../lib/telegram-config.mjs';

try {
  const [action = 'show'] = process.argv.slice(2);
  if (action === 'init') {
    const { source: _source, ...telegram } = telegramConfigFromEnv();
    await writeFile(path.join(agentRoot, 's8-config.yml'), stringify({ telegram }), { flag: 'wx', mode: 0o600 });
    console.log('Created s8-config.yml from inherited ID settings only. Existing files are never overwritten.');
    if (!telegram.scheduleChatId) console.log('scheduleChatId is not set; select an allowed recipient before unattended operation.');
  } else if (action !== 'show') throw new Error('Usage: node pi/bin/s8-config.mjs [init|show]');
  console.log(JSON.stringify(loadTelegramConfig(), null, 2));
} catch (error) {
  console.error(error.code === 'EEXIST' ? 's8-config.yml already exists; no settings were changed.' : error.message);
  process.exitCode = 1;
}
