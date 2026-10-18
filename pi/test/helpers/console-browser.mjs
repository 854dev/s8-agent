import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProjectmanConsole } from '../../lib/projectman/console.mjs';

// Integration-test host only: serves the built app and the real console adapter.
export async function liveConsoleBrowser({ root, baseUrl, directory, login, runtimeRoot = root }) {
  const api = createProjectmanConsole({ root: runtimeRoot, baseUrl });
  const dist = path.join(root, 'frontend/dist');
  const web = http.createServer(async (req, res) => {
    if (req.url.startsWith('/api/projectman/')) { api.emit('request', req, res); return; }
    try {
      const url = new URL(req.url, 'http://localhost');
      const relative = decodeURIComponent(url.pathname).replace(/^\/s8\//, '');
      if (!url.pathname.startsWith('/s8/') || relative.split('/').some(part => part === '..')) { res.writeHead(404).end(); return; }
      const asset = relative.startsWith('assets/');
      const file = path.join(dist, asset ? relative : 'index.html');
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  web.listen(0, '127.0.0.1'); await once(web, 'listening');
  const { chromium } = await import(pathToFileURL(path.join(root, 'frontend/node_modules/playwright/index.mjs')).href);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
    const origin = `http://127.0.0.1:${web.address().port}`;
    return {
      page, origin,
      async open(uid) {
        await page.goto(`${origin}/s8/?task=${uid}`);
        await page.getByLabel('이메일', { exact: true }).fill(login.email);
        await page.getByLabel('비밀번호', { exact: true }).fill(login.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click();
        await page.getByRole('heading', { name: '실행 계획과 완료 조건' }).waitFor();
      },
      async operation(action, click) {
        const response = page.waitForResponse(response => response.url().endsWith('/workflow') && response.request().method() === 'POST' && JSON.parse(response.request().postData()).action === action);
        await click();
        const result = await response;
        if (!result.ok()) throw new Error(`Browser workflow ${action} failed: HTTP ${result.status()}`);
        await page.getByRole('status').waitFor();
      },
      async screenshot(name) { await page.screenshot({ path: path.join(directory, name), fullPage: true }); },
      async close() { await browser.close(); web.closeAllConnections(); await new Promise(resolve => web.close(resolve)); },
    };
  } catch (error) { if (browser) await browser.close(); web.closeAllConnections(); await new Promise(resolve => web.close(resolve)); throw error; }
}
