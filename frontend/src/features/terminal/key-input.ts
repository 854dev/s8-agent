export function controlInput(data: string): string {
  if (data === ' ') return '\x00'
  if (data === '?') return '\x7f'
  const code = data.toUpperCase().charCodeAt(0)
  return data.length === 1 && code >= 64 && code <= 95 ? String.fromCharCode(code & 31) : data
}

export const terminalKeys = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl+C', '\x03'],
  ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'],
  ['Ctrl+B', '\x02'], ['Ctrl+D', '\x04'], ['Ctrl+L', '\x0c'], ['Enter', '\r'], ['⌫', '\x7f'],
] as const
