import { createHash } from 'node:crypto';
import { PHCMSClient } from '@ph-cms/client-sdk/core';

const ACCESS_COOKIE = 's8_projectman_session';
const REFRESH_COOKIE = 's8_projectman_refresh';
const ACCESS_SECONDS = 15 * 60;
const REFRESH_SECONDS = 7 * 24 * 60 * 60;
const failure = status => Object.assign(new Error('Console authentication unavailable'), { status });
const statusOf = error => error.status ?? error.statusCode ?? Number(/HTTP (\d+)/.exec(error.message ?? '')?.[1] || 503);
const validToken = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !value.startsWith('phcms_sk_') && /^[A-Za-z0-9_.-]+$/.test(value);
function cookie(req, name) {
  const field = (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  if (!field) return '';
  let value;
  try { value = decodeURIComponent(field.slice(name.length + 1)); } catch { throw failure(401); }
  if (!validToken(value)) throw failure(401);
  return value;
}
function cookies(req, res, pair) {
  const secure = req.headers.origin?.startsWith('https:') || req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  const field = (name, value, seconds) => `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/api/projectman; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', [field(ACCESS_COOKIE, pair?.accessToken ?? '', pair ? ACCESS_SECONDS : 0), field(REFRESH_COOKIE, pair?.refreshToken ?? '', pair ? REFRESH_SECONDS : 0)]);
}
function validPair(pair) {
  if (!validToken(pair?.accessToken) || !validToken(pair?.refreshToken)) throw failure(502);
  return { accessToken: pair.accessToken, refreshToken: pair.refreshToken };
}
export function sdkAuthentication(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw failure(503);
  const sdk = new PHCMSClient({ baseURL: url.origin, apiPrefix: url.pathname, timeout: 10000 });
  return sdk.auth;
}

/** SDK auth stays on the server. Both tokens persist only in HttpOnly cookies. */
export function consoleSessions({ baseUrl, clientFactory, authFactory = sdkAuthentication }) {
  const refreshes = new Map();
  const keyOf = token => createHash('sha256').update(token).digest('hex');
  async function checkedClient(token) {
    const client = clientFactory(token);
    const capabilities = await client.capabilities();
    if (![1, 2].includes(capabilities.workflowVersion)) throw failure(503);
    if (capabilities.actorType !== 'human') throw failure(403);
    return client;
  }
  async function renewed(token) {
    const key = keyOf(token), now = Date.now();
    for (const [id, entry] of refreshes) if (entry.until < now) refreshes.delete(id);
    let entry = refreshes.get(key);
    if (!entry) {
      if (refreshes.size >= 1000) throw failure(503);
      entry = { until: Infinity, canceled: false };
      entry.promise = Promise.resolve().then(() => authFactory(baseUrl).refresh(token)).then(validPair).then(pair => { entry.until = Date.now() + 15000; return pair; });
      refreshes.set(key, entry);
      // Retain a successful refresh briefly so simultaneous requests share the new pair.
      entry.promise.catch(() => { if (refreshes.get(key) === entry) refreshes.delete(key); });
    }
    const pair = await entry.promise;
    if (entry.canceled) throw failure(401);
    return { pair, entry };
  }
  return {
    async login(req, res, input) {
      try {
        const pair = validPair(await authFactory(baseUrl).login(input));
        await checkedClient(pair.accessToken);
        cookies(req, res, pair);
      } catch (error) { throw failure(error.name === 'ValidationError' ? 400 : statusOf(error)); }
    },
    logout(req, res) {
      try { const refresh = cookie(req, REFRESH_COOKIE); const entry = refresh && refreshes.get(keyOf(refresh)); if (entry) entry.canceled = true; } catch { /* Always clear malformed cookies as well. */ }
      cookies(req, res, null);
    },
    async client(req, res) {
      try {
        const access = cookie(req, ACCESS_COOKIE), refresh = cookie(req, REFRESH_COOKIE);
        if (access) {
          try { return await checkedClient(access); }
          catch (error) { if (statusOf(error) !== 401) throw error; }
        }
        if (!refresh) throw failure(401);
        let renewal;
        try { renewal = await renewed(refresh); }
        catch (error) { if ([400, 401, 403].includes(statusOf(error))) throw failure(401); throw error; }
        const client = await checkedClient(renewal.pair.accessToken);
        if (renewal.entry.canceled) throw failure(401);
        cookies(req, res, renewal.pair);
        return client;
      } catch (error) {
        const status = statusOf(error);
        if (status === 401) cookies(req, res, null);
        throw failure(status);
      }
    },
  };
}
