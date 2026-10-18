import { randomUUID } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import { visible } from '../../../apps/telegram-gateway/gateway.mjs';

export const safeJson = value => JSON.stringify(value, (_key, item) => typeof item === 'string' ? visible(item) : item, 2);

export async function saveJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${safeJson(value)}\n`, { mode: 0o600 });
  await rename(temp, file);
}
