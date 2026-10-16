import path from 'node:path';

// No arbitrary arguments, @file attachments, sessions, extensions or tool overrides.
export function managerArgs(root, input) {
  const extra = [];
  const flags = new Set(['--continue', '--print', '--no-session', '--version']);
  const values = new Set(['--model', '--provider', '--thinking']);
  for (let i = 0; i < input.length; i++) {
    const arg = input[i];
    if (flags.has(arg)) extra.push(arg);
    else if (values.has(arg) && input[i + 1] && !/^[-@]/.test(input[i + 1])) extra.push(arg, input[++i]);
    else throw new Error(`Unsupported manager argument: ${arg}. Use the interactive prompt for requests.`);
  }
  return [
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
    '--extension', path.join(root, 'pi/extensions/manager.ts'),
    '--system-prompt', path.join(root, 'agents/manager/SYSTEM.md'),
    '--tools', 'projectman,kb,scheduler',
    '--session-dir', path.join(root, '.pi-runtime/sessions/manager'), ...extra,
  ];
}
