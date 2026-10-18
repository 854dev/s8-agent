import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run from the unchanged PH-CMS packages/server directory. No server files are written.
const server = process.cwd();
const support = path.dirname(fileURLToPath(import.meta.url));
export default {
  test: { include: [path.join(support, 'workflow.integration.ts')], environment: 'node', cache: false, fileParallelism: false, testTimeout: 60000, hookTimeout: 30000 },
  resolve: { alias: { '@': path.join(server, 'src'), vitest: path.join(server, 'node_modules/vitest/dist/index.js'), jsonwebtoken: path.join(server, 'node_modules/jsonwebtoken/index.js'), kysely: path.join(server, 'node_modules/kysely/dist/esm/index.js') } },
};
