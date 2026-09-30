export type AppView = 'dashboard' | 'knowledge-base' | 'upload'

function normalizePath(pathname: string) {
  if (pathname.length <= 1) return '/'
  return pathname.replace(/\/+$/, '')
}

function basePath(baseUrl: string) {
  const normalized = normalizePath(baseUrl || '/')
  return normalized === '/' ? '' : normalized
}

export function getAppBaseUrl(configuredBaseUrl = '/') {
  return configuredBaseUrl === '/' ? '/s8/' : configuredBaseUrl
}

export function getAppView(pathname: string, baseUrl = '/'): AppView {
  const base = basePath(baseUrl)
  const knowledgeBasePath = `${base}/knowledge-base`
  const uploadPath = `${base}/upload`
  const normalized = normalizePath(pathname)
  if (normalized === knowledgeBasePath) return 'knowledge-base'
  if (normalized === uploadPath) return 'upload'
  return 'dashboard'
}

export function buildKnowledgeBaseUrl(baseUrl = '/', documentPath?: string) {
  const path = `${basePath(baseUrl)}/knowledge-base`
  if (!documentPath) return path

  const query = new URLSearchParams({ path: documentPath })
  return `${path}?${query.toString()}`
}

export function getSelectedDocumentPath(search: string) {
  const path = new URLSearchParams(search).get('path')
  return path || null
}
