import { describe, expect, it } from 'vitest'
import {
  buildKnowledgeBaseUrl,
  getAppBaseUrl,
  getAppView,
  getSelectedDocumentPath,
} from '../../../app-route'

describe('app route', () => {
  it('keeps the dashboard at the app base path', () => {
    expect(getAppView('/s8/', '/s8/')).toBe('dashboard')
    expect(getAppView('/s8', '/s8/')).toBe('dashboard')
  })

  it('recognizes the knowledge base path with or without a trailing slash', () => {
    expect(getAppView('/s8/knowledge-base', '/s8/')).toBe('knowledge-base')
    expect(getAppView('/s8/knowledge-base/', '/s8/')).toBe('knowledge-base')
  })

  it('falls back to the dashboard for unknown paths', () => {
    expect(getAppView('/s8/settings', '/s8/')).toBe('dashboard')
    expect(getAppView('/other/knowledge-base', '/s8/')).toBe('dashboard')
  })

  it('uses the canonical s8 prefix when Vite reports a root base', () => {
    expect(getAppBaseUrl('/')).toBe('/s8/')
    expect(getAppBaseUrl('/s8/')).toBe('/s8/')
  })

  it('encodes a selected document path in the knowledge base URL', () => {
    expect(buildKnowledgeBaseUrl('/s8/', 'docs/guides/guide one.md'))
      .toBe('/s8/knowledge-base?path=docs%2Fguides%2Fguide+one.md')
    expect(buildKnowledgeBaseUrl('/s8/')).toBe('/s8/knowledge-base')
  })

  it('decodes the selected document path from the query string', () => {
    expect(getSelectedDocumentPath('?path=docs%2Fnotes%2FREADME.md'))
      .toBe('docs/notes/README.md')
    expect(getSelectedDocumentPath('')).toBeNull()
  })
})
