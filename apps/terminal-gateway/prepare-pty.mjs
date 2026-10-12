import { chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// node-pty's macOS prebuilt spawn-helper ships without executable permissions.
if (process.platform !== 'win32') {
  const helper = fileURLToPath(new URL(`./node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`, import.meta.url));
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
