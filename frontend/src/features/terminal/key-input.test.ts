import { expect, it } from 'vitest'
import { controlInput, terminalKeys } from './key-input'

it('converts mobile Ctrl chords without corrupting IME and multi-character input', () => {
  expect(controlInput('c')).toBe('\x03')
  expect(controlInput('D')).toBe('\x04')
  expect(controlInput('b')).toBe('\x02')
  expect(controlInput('[')).toBe('\x1b')
  expect(controlInput(' ')).toBe('\x00')
  expect(controlInput('?')).toBe('\x7f')
  expect(controlInput('한')).toBe('한')
  expect(controlInput('abc')).toBe('abc')
  expect(terminalKeys.find(([label]) => label === '↑')?.[1]).toBe('\x1b[A')
})
