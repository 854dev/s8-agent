export default function local(pi) {
  const tools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
  pi.on('session_start', () => pi.setActiveTools(tools));
  pi.on('tool_call', event => tools.includes(event.toolName) ? undefined : { block: true, reason: 'Local mode does not permit this tool' });
}
