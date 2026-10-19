import { readFile, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import managerExtension from '../../extensions/manager.ts';
import { MANAGER_TOOLS } from '../../extensions/manager.ts';
import { visible } from '../../../apps/telegram-gateway/gateway.mjs';

/** Persistent logical manager using the same tools/guards as the default Pi entrypoint. */
export async function openManagerSession({ root, cwd, directory, modelRuntime, model, poll = true, persist = false }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const systemPrompt = await readFile(path.join(root, 'agents/manager/SYSTEM.md'), 'utf8');
  const settingsManager = SettingsManager.inMemory({ packages: [], compaction: { enabled: true }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir: directory, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, systemPrompt, extensionFactories: [pi => managerExtension(pi, { poll })] });
  await loader.reload();
  if (loader.getExtensions().errors.length) throw new Error('Manager extension could not load');
  const sessionManager = persist ? SessionManager.continueRecent(cwd, path.join(root, '.pi-runtime/sessions/manager')) : SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({ cwd, agentDir: directory, modelRuntime, model, thinkingLevel: 'low', resourceLoader: loader, settingsManager, sessionManager, tools: MANAGER_TOOLS });
  let writes = Promise.resolve(), writeError;
  const record = event => { writes = writes.then(() => appendFile(path.join(directory, 'manager.events.jsonl'), `${JSON.stringify(event, (_key, value) => typeof value === 'string' ? visible(value) : value)}\n`, { mode: 0o600 })).catch(error => { writeError = error; void session.abort(); }); };
  record({ type: 'manager_session', sessionId: session.sessionId, systemPrompt, tools: session.getActiveToolNames() });
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'custom') record({ type: 'manager_notification', customType: event.message.customType, content: event.message.content });
    if (event.type === 'tool_execution_start') record({ type: event.type, toolName: event.toolName, args: event.args, toolCallId: event.toolCallId });
    if (event.type === 'tool_execution_end') record({ type: event.type, toolCallId: event.toolCallId, isError: event.isError, result: event.result });
    if (event.type === 'message_end' && event.message.role === 'assistant') record({ type: 'assistant', text: event.message.content.filter(block => block.type === 'text').map(block => block.text).join(''), stopReason: event.message.stopReason, usage: Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(key => [key, Number(event.message.usage?.[key]) || 0])) });
  });
  await session.bindExtensions({ mode: 'print' });
  return {
    sessionId: session.sessionId,
    async prompt(text, signal) {
      const abort = () => { void session.abort(); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (signal?.aborted) throw new Error('Manager request stopped');
        record({ type: 'request', sessionId: session.sessionId, prompt: text });
        await session.prompt(text, { expandPromptTemplates: false }); await writes;
        if (writeError || signal?.aborted) throw new Error('Manager execution or recording stopped');
        const last = session.messages.filter(message => message.role === 'assistant').at(-1);
        if (last?.stopReason !== 'stop') throw new Error('Manager did not finish normally');
        return last.content.filter(block => block.type === 'text').map(block => block.text).join('');
      } finally { signal?.removeEventListener('abort', abort); }
    },
    async close() { await session.extensionRunner.emit({ type: 'session_shutdown' }); await session.abort(); unsubscribe(); await writes; session.dispose(); },
  };
}
