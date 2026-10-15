import path from 'node:path';

// Only public assistant text and successful read-tool paths become checkpoints.
// Never retain thinking, tool result bodies, provider diagnostics, or raw protocol records.
// ponytail: bounded frames/blocks/tool history; raise limits only for measured provider/tool needs.
export class PiOutput {
  constructor(scope) {
    this.scope = scope;
    this.pending = '';
    this.discard = false;
    this.blocks = new Map();
    this.calls = new Map();
    this.steps = [];
    this.lastText = '';
    this.reason = 'pending';
    this.settled = false;
  }
  write(chunk) {
    this.pending += chunk;
    let index;
    while ((index = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, index);
      this.pending = this.pending.slice(index + 1);
      if (!this.discard && line.length <= 1_000_000) this.event(line);
      this.discard = false;
    }
    if (this.pending.length > 1_000_000) { this.pending = ''; this.discard = true; }
  }
  event(line) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== 'object') return;
    if (event.type === 'agent_start') this.settled = false;
    if (event.type === 'agent_settled') this.settled = true;
    if (event.type === 'message_start' && event.message?.role === 'assistant') {
      this.blocks.clear(); this.reason = 'pending';
    }
    const delta = event.assistantMessageEvent;
    if (event.type === 'message_update' && Number.isInteger(delta?.contentIndex) && delta.contentIndex >= 0 && delta.contentIndex < 32) {
      if (delta.type === 'text_delta') this.blocks.set(delta.contentIndex, ((this.blocks.get(delta.contentIndex) ?? '') + String(delta.delta ?? '')).slice(-10000));
      if (delta.type === 'text_end') this.blocks.set(delta.contentIndex, String(delta.content ?? '').slice(-10000));
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      this.reason = ['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred'].includes(event.message.stopReason) ? event.message.stopReason : 'pending';
      this.lastText = (Array.isArray(event.message.content) ? event.message.content : []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('').slice(-10000);
      this.blocks.clear();
    }
    if (event.type === 'tool_execution_start' && ['read', 'grep', 'find', 'ls'].includes(event.toolName)) {
      const file = typeof event.args?.path === 'string' ? path.resolve(this.scope, event.args.path) : this.scope;
      const relative = path.relative(this.scope, file);
      const safe = !relative.startsWith('..') && !path.isAbsolute(relative) && !/(?:secret|\.env|\.pi|\.s8-runtime|\.git)/i.test(relative);
      if (this.calls.size < 128) this.calls.set(event.toolCallId, `${event.toolName}${safe ? ` ${relative.replace(/\s+/g, ' ').slice(0, 200) || '.'}` : ''}`);
    }
    if (event.type === 'tool_execution_end') {
      const step = this.calls.get(event.toolCallId);
      this.calls.delete(event.toolCallId);
      if (step && event.isError === false) { this.steps.push(step); this.steps = this.steps.slice(-20); }
    }
  }
  get text() {
    return [...this.blocks].sort(([a], [b]) => a - b).map(([, text]) => text).join('').slice(-10000) || this.lastText;
  }
  get complete() { return this.settled && this.reason === 'stop'; }
  get checkpoint() {
    return [this.steps.length ? `완료된 읽기 도구(본문 제외):\n${this.steps.join('\n')}` : '', this.text].filter(Boolean).join('\n').slice(-10000);
  }
}
