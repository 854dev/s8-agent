import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { safeJson } from '../../lib/storage/json-file.mjs';

// Bounded fixture session for manual evaluation and SDK tests only.
export async function runModelSession({ role, prompt, systemPrompt, tools, runtime, model, run, signal, onProgress = () => {}, maxModelTokens = 100000 }) {
  const settingsManager = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: run.workspace, agentDir: run.directory, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, systemPrompt });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: run.workspace, agentDir: run.directory, modelRuntime: runtime, model, thinkingLevel: 'low', resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(), tools: tools.map(tool => tool.name), customTools: tools.map(tool => ({ ...tool, executionMode: 'sequential' })) });
  const eventFile = path.join(run.directory, `${role}.events.jsonl`);
  let writes = Promise.resolve(), turns = 0, toolCalls = 0, tokens = 0;
  let writeError, budgetReached = false;
  const record = value => { writes = writes.then(() => appendFile(eventFile, `${safeJson(value).replace(/\n\s*/g, '')}\n`, { mode: 0o600 })).catch(error => { writeError = error; void session.abort(); }); };
  record({ type: 'request', role, prompt, systemPrompt, model: { provider: model.provider, id: model.id }, tools: session.getActiveToolNames() });
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'turn_start' && ++turns > 24) { budgetReached = true; void session.abort(); }
    if (event.type === 'tool_execution_start') {
      if (++toolCalls > 50) { budgetReached = true; void session.abort(); return; }
      onProgress(`${role}: ${event.toolName}`);
      record({ type: event.type, toolName: event.toolName, toolCallId: event.toolCallId, args: event.args });
    }
    if (event.type === 'tool_execution_end') record({ type: event.type, toolCallId: event.toolCallId, isError: event.isError, result: event.result });
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const usage = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(key => [key, Number(event.message.usage?.[key]) || 0]));
      tokens += Object.values(usage).reduce((sum, value) => sum + value, 0);
      record({ type: 'assistant', text: event.message.content.filter(block => block.type === 'text').map(block => block.text).join(''), stopReason: event.message.stopReason, usage });
      if (tokens > maxModelTokens) { budgetReached = true; void session.abort(); }
    }
  });
  const abort = () => { void session.abort(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('Smoke run stopped');
    try { await session.prompt(prompt, { expandPromptTemplates: false }); }
    catch (error) { if (budgetReached) throw Object.assign(new Error('Execution budget exhausted'), { code: 'BUDGET_EXHAUSTED' }); throw error; }
    await writes;
    if (writeError) throw new Error('Execution event recording failed');
    if (budgetReached) throw Object.assign(new Error('Execution budget exhausted'), { code: 'BUDGET_EXHAUSTED' });
    if (signal?.aborted) throw new Error('Smoke run stopped or timed out');
    const last = session.messages.filter(message => message.role === 'assistant').at(-1);
    if (last?.stopReason !== 'stop') throw new Error('Model did not finish normally');
    return last.content.filter(block => block.type === 'text').map(block => block.text).join('');
  } finally {
    signal?.removeEventListener('abort', abort);
    unsubscribe();
    await writes;
    session.dispose();
  }
}
