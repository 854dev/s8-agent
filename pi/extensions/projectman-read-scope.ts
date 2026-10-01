import path from 'node:path';
import { realpathSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  const scope = process.env.S8_AUTOPILOT_SCOPE;
  if (!scope) return;
  const root = realpathSync(scope);
  const tools = new Set(['read', 'grep', 'find', 'ls']);
  pi.on('tool_call', (event, ctx) => {
    if (!tools.has(event.toolName)) return;
    const raw = 'path' in event.input ? event.input.path : undefined;
    if (typeof raw !== 'string' || !raw) return { block: true, reason: 'Autopilot requires a scoped path' };
    const resolved = path.resolve(ctx.cwd, raw.replace(/^@/, ''));
    let actual: string;
    try { actual = realpathSync(resolved); } catch { return { block: true, reason: 'Autopilot cannot resolve path' }; }
    const relative = path.relative(root, actual);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return { block: true, reason: 'Outside autopilot repository scope' };
  });
}
