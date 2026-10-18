import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { sql } from 'kysely';
import { exerciseProjectmanWorkerPool } from './projectman-worker-integration.mjs';
vi.mock('@/config/envConfig', () => {
	const database = process.env.SERVICE_KEY_TEST_DB;
	if (!database || !/^phcms_service_keys_test_[a-z0-9_]+$/.test(database)) throw new Error('Fresh isolated workflow DB required');
	return { envConfig: { NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_PORT: Number(process.env.DB_PORT ?? 5432), DB_NAME: database, DB_USER: process.env.SERVICE_KEY_TEST_USER, DB_PASSWORD: process.env.SERVICE_KEY_TEST_PASSWORD, DB_SSL: false, DB_POOL_MAX: 8, DB_POOL_IDLE_TIMEOUT: 1000, JWT_SECRET: 'workflow-fixture-key', API_PREFIX: '/api/v2', PORT: 8000, LOG_FILE: '/dev/null', AWS_REGION: 'ap-northeast-2', CORS_ALLOWED_ORIGINS: 'http://localhost:3000', SERVE_STATIC_ADMIN_ENABLED: false, ENABLE_SEED: false, ENSURE_ADMIN: false } };
});
vi.mock('@/lib/firebase', () => ({ initFirebase: () => undefined, getFirebaseStatus: () => ({ enabled: false }) }));
import { buildServer } from '@/index';
import { db, getMigrator } from '@/db';
import { UserService } from '@/service/base/user.service';
import { ServiceKeyService } from '@/service/usecase/service-key.service';
import { setupProjectman } from '@/service/usecase/projectman-setup.service';


let server: ReturnType<typeof buildServer>, agentToken: string, workspaceUid: string;
let activeRequests = 0;
beforeAll(async () => {
  const existing = await sql<{ count: string }>`select count(*) from information_schema.tables where table_schema = 'public'`.execute(db);
  if (Number(existing.rows[0].count) !== 0) throw new Error('Fresh empty integration DB required');
  const migrated = await getMigrator(db).migrateToLatest(); if (migrated.error) throw migrated.error;
  const users = new UserService(db);
  const owner = await users.create({ email: 'wf-owner@example.invalid', password: 'worker-pool-fixture-password', display_name: 'Workflow owner', role: ['admin'] });
  const agent = await users.create({ email: 'wf-agent@example.invalid', display_name: 'Workflow agent', role: ['agent'] });
  agentToken = (await new ServiceKeyService(db).issue(owner.id, agent.uid, { name: 'S8 compatibility fixture', expiresAt: new Date(Date.now() + 3600000).toISOString() })).key;
  await setupProjectman(db, owner.uid, agent.uid);
  server = buildServer(db);
  server.addHook('onRequest', async () => { activeRequests++; });
  server.addHook('onResponse', async () => { activeRequests--; });
  const response = await server.inject({ method: 'POST', url: '/api/v2/contents', headers: { authorization: `Bearer ${jwt.sign({ id: owner.id }, 'workflow-fixture-key')}` }, payload: { channelSlug: 'ph-projectman', type: 'workspace', title: 'S8 integration', status: 'published' } });
  expect(response.statusCode, response.body).toBe(201); workspaceUid = response.json().uid;
});
afterAll(async () => {
  const deadline = Date.now() + 5000;
  while (activeRequests && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  expect(activeRequests).toBe(0);
  server?.server.closeAllConnections();
  try { await server?.close(); } finally { await db.destroy(); }
});
it('connects unchanged PH-CMS to approval, workers, notifications, manager review and human completion', async () => {
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  const result = await exerciseProjectmanWorkerPool({ baseUrl: `${address}/api/v2`, managerToken: agentToken, workspaceUid, login: { email: 'wf-owner@example.invalid', password: 'worker-pool-fixture-password' } });
  expect(result.ok).toBe(true); expect(result.humanCompletion).toBe(true);
  console.log(JSON.stringify({ workerPoolCompatibility: result }));
});
