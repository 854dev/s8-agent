/** Worker IDs are persisted in Projectman workflow runs and used as file/socket names. */
export const validWorkerId = id => typeof id === 'string' && id !== 'shell' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);

export function parseWorkerHost(host, { required = true } = {}) {
  if (host == null && !required) return null;
  if (host === 'local') return { kind: 'local', value: 'local' };
  if (typeof host !== 'string' || !host.startsWith('ssh://')) throw new Error('Worker host must be local or an ssh://user@host address');
  let url;
  try { url = new URL(host); } catch { throw new Error('Worker host must be local or an ssh://user@host address'); }
  if (url.protocol !== 'ssh:' || !url.username || url.password || !url.hostname || url.pathname !== '' || url.search || url.hash || url.port) {
    throw new Error('SSH worker host must be ssh://user@host without a port, path, password, query or fragment');
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(decodeURIComponent(url.username)) || !/^[a-zA-Z0-9_.:-]+$/.test(url.hostname)) throw new Error('Invalid SSH worker target');
  return { kind: 'ssh', value: `ssh://${decodeURIComponent(url.username)}@${url.hostname}` };
}
