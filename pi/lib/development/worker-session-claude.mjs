import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { visible } from '../../../apps/telegram-gateway/gateway.mjs';
import { startWorkerProjectman } from './worker-projectman.mjs';

const reportSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['completed', 'failed'] },
    summary: { type: 'string' },
    verification: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, ok: { type: 'boolean' }, summary: { type: 'string' } }, required: ['name', 'ok', 'summary'], additionalProperties: false } },
    remainingItems: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    executionErrors: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'summary', 'verification', 'remainingItems', 'decisions', 'executionErrors'],
  additionalProperties: false,
};

function extractReport(event) {
  const candidates = [event?.structured_output, event?.result, event?.content];
  for (const value of candidates) {
    if (value && typeof value === 'object' && !Array.isArray(value) && ['completed', 'failed'].includes(value.status)) return value;
    if (typeof value !== 'string') continue;
    try {
      const parsed = JSON.parse(value);
      if (parsed && ['completed', 'failed'].includes(parsed.status)) return parsed;
    } catch {}
  }
  const text = String(event?.result ?? '');
  return { status: 'failed', summary: text.trim().slice(0, 8000) || 'Claude Code did not return a structured completion report.', verification: [], remainingItems: [], decisions: [], executionErrors: ['Claude Code output did not match the required report schema'] };
}

/** Run one dedicated Claude Code print-mode conversation for an assigned work UID. */
export async function executeClaudeDeveloper(request, { signal, binary = 'claude', spawnImpl = spawn, readWorkflow } = {}) {
  const { run, task } = request;
  signal?.throwIfAborted();
  const systemPromptFile = path.resolve(request.root, 'agents/developer/CLAUDE_WORKER_SYSTEM.md');
  const settingsFile = path.join(run.directory, 'claude-mcp-config.json');
  await readFile(systemPromptFile, 'utf8');
  const projectman = await startWorkerProjectman(request, { signal, readWorkflow });
  try {
    await writeFile(settingsFile, `${JSON.stringify(projectman.config, null, 2)}\n`, { mode: 0o600 });
    const prompt = [
      `Assigned work UID: ${task.uid}`,
      `Run ID: ${run.runId}`,
      'First use the configured Projectman MCP tool that retrieves work by UID. Read exactly the assigned UID and follow its approved plan and completion criteria.',
      'Do not claim, report, change workflow state, message the user, or access work outside this assignment. The S8 worker runner records your final report after your turn ends.',
      'Implement and verify the work in the current directory. Never read, print, copy, or edit .env files, credentials, or authentication data.',
      'At the end return only the required structured JSON report. Set completed only when all completion criteria pass; otherwise set failed and describe the remaining work and errors.',
    ].join('\n');
    const args = [
      '--print', '--output-format', 'stream-json', '--input-format', 'text', '--verbose',
      '--session-id', run.runId,
      '--system-prompt-file', systemPromptFile,
      '--strict-mcp-config', '--mcp-config', settingsFile,
      '--tools', 'Read,Write,Edit,Bash,Glob,Grep',
      '--dangerously-skip-permissions',
      '--json-schema', JSON.stringify(reportSchema),
    ];
    const env = { ...process.env };
    for (const key of ['PHCMS_API_URL', 'PHCMS_MCP_URL', 'PHCMS_ACCESS_TOKEN']) delete env[key];
    signal?.throwIfAborted();
    const child = spawnImpl(binary, args, { cwd: run.workspace, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const eventsFile = path.join(run.directory, 'developer.events.jsonl');
    let finalEvent, stderr = '', outputError, exited = false, killTimer;
    const writeEvent = async event => {
      if (event.type === 'assistant') {
        const names = (event.message?.content ?? []).filter(block => block.type === 'tool_use').map(block => String(block.name).slice(0, 100));
        if (names.length) await appendFile(eventsFile, `${JSON.stringify({ type: 'tool_execution', toolNames: names })}\n`, { mode: 0o600 });
      }
      if (event.type === 'result') {
        finalEvent = event;
        await appendFile(eventsFile, `${JSON.stringify({ type: 'assistant', text: visible(String(event.result ?? '').slice(0, 12000)), stopReason: event.subtype ?? 'unknown' })}\n`, { mode: 0o600 });
      }
    };
    const output = createInterface({ input: child.stdout });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, reason) => {
        exited = true; clearTimeout(killTimer);
        code === 0 ? resolve({ code, reason }) : reject(new Error(`Claude Code worker exited (${reason ?? code})${stderr ? `: ${visible(stderr.slice(-2000))}` : ''}`));
      });
    });
    void done.catch(() => {});
    const abort = () => {
      if (exited || killTimer) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 5000);
      killTimer.unref();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
    try {
      child.stdin.end(prompt);
      for await (const line of output) {
        if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new Error('Claude Code event exceeded the protocol limit');
        try { await writeEvent(JSON.parse(line)); }
        catch (error) { if (error instanceof SyntaxError) continue; outputError = error; abort(); break; }
      }
      await done;
      if (outputError) throw outputError;
      if (signal?.aborted) throw new Error('Claude Code work was canceled');
      if (!finalEvent || finalEvent.is_error || finalEvent.subtype !== 'success') throw new Error('Claude Code did not complete the assigned turn');
      await projectman.verifyReport();
      const report = extractReport(finalEvent);
      await writeFile(path.join(run.directory, 'worker-result.json'), `${JSON.stringify(report)}\n`, { mode: 0o600 });
      return { report };
    } finally {
      signal?.removeEventListener('abort', abort);
      output.close();
      if (!exited) abort();
      await done.catch(() => {});
    }
  } finally { await projectman.close(); }
}
