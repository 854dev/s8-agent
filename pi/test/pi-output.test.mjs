import test from 'node:test';
import assert from 'node:assert/strict';
import { PiOutput } from '../lib/pi-output.mjs';
import { runBoundedProcess } from '../lib/projectman-autopilot.ts';
const frame = value => JSON.stringify(value) + '\n';
const end = (text, reason = 'stop') => ({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: reason } });

test('JSONL captures public checkpoints only and requires agent_settled, not just agent_end', () => {
  const output = new PiOutput(process.cwd());
  output.write('null\ninvalid\n');
  output.write(frame({ type: 'message_start', message: { role: 'assistant' } }));
  output.write(frame({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'fixture-thinking-not-for-records' } }));
  const delta = frame({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: '부분 결과\u2028다음 단계\u2029테스트' } });
  output.write(delta.slice(0, 30)); output.write(delta.slice(30));
  output.write(frame({ type: 'tool_execution_start', toolCallId: 'call1', toolName: 'read', args: { path: 'README.md' } }));
  output.write(frame({ type: 'tool_execution_end', toolCallId: 'call1', isError: false, result: { content: [{ type: 'text', text: 'fixture-tool-body-not-for-records' }] } }));
  assert.match(output.checkpoint, /read README.md/);
  assert.ok(output.checkpoint.includes('부분 결과\u2028다음 단계\u2029테스트'));
  assert.equal(output.checkpoint.includes('fixture-thinking'), false);
  assert.equal(output.checkpoint.includes('fixture-tool-body'), false);
  const report = JSON.stringify({ status: 'completed', summary: 'checked' });
  output.write(frame(end(report)) + frame({ type: 'agent_end', willRetry: false }));
  assert.equal(output.complete, false);
  output.write(frame({ type: 'agent_settled' }));
  assert.equal(output.complete, true);
  assert.equal(output.text, report);
});

test('real child timeout retains public progress without persisting raw tool output or thinking', async () => {
  const script = `const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');
  emit({type:'message_start',message:{role:'assistant'}});
  emit({type:'message_update',assistantMessageEvent:{type:'thinking_delta',contentIndex:0,delta:'fixture-private-thinking'}});
  emit({type:'tool_execution_start',toolCallId:'call1',toolName:'read',args:{path:'README.md'}});
  emit({type:'tool_execution_end',toolCallId:'call1',isError:false,result:{content:[{type:'text',text:'fixture-private-tool-body'}]}});
  emit({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:1,delta:'검토 A 완료; 다음 단계 B'}});
  setInterval(()=>{},1000);`;
  const result = await runBoundedProcess(process.execPath, ['-e', script], process.cwd(), 300, new AbortController().signal, process.cwd(), true, true);
  assert.equal(result.status, 'timeout');
  assert.match(result.output, /read README.md/);
  assert.match(result.output, /검토 A 완료; 다음 단계 B/);
  assert.equal(result.output.includes('fixture-private'), false);
});

test('a JSON-mode zero exit is not completion on token limit or missing settlement', async () => {
  for (const [reason, settled, expected] of [['stop', true, 'completed'], ['length', true, 'timeout'], ['stop', false, 'failed']]) {
    const text = JSON.stringify({ status: 'completed', summary: 'checked' });
    const records = frame(end(text, reason)) + (settled ? frame({ type: 'agent_settled' }) : '');
    const result = await runBoundedProcess(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(records)})`], process.cwd(), 5000, new AbortController().signal, process.cwd(), true, true);
    assert.equal(result.status, expected);
    assert.equal(result.stopReason, reason);
    assert.equal(result.output, text);
  }
});
