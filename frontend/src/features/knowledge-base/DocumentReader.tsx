import { useEffect, useState, type ComponentProps } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fetchDocument } from './api'
import type { DocumentResponse } from './types'

type ReaderState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; document: DocumentResponse }
  | { status: 'error' }

type DocumentReaderProps = {
  path: string | null
  onBack?: () => void
}

function fileName(path: string) {
  return path.split('/').at(-1) ?? path
}

function MarkdownLink({ href, children, ...props }: ComponentProps<'a'>) {
  const external = href?.startsWith('http://') || href?.startsWith('https://')
  return (
    <a
      {...props}
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noreferrer noopener' : undefined}
    >
      {children}
    </a>
  )
}

export default function DocumentReader({ path, onBack }: DocumentReaderProps) {
  const [state, setState] = useState<ReaderState>({ status: 'idle' })

  useEffect(() => {
    if (!path) {
      setState({ status: 'idle' })
      return
    }

    const controller = new AbortController()
    setState({ status: 'loading' })
    fetchDocument(path, controller.signal)
      .then((document) => setState({ status: 'ready', document }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' })
      })

    return () => controller.abort()
  }, [path])

  if (!path || state.status === 'idle') {
    return <section className="kb-reader kb-reader--empty"><p>문서를 선택하세요</p></section>
  }

  if (state.status === 'loading') {
    return <section className="kb-reader" aria-busy="true"><p>문서를 불러오는 중입니다...</p></section>
  }

  if (state.status === 'error') {
    return <section className="kb-reader" role="alert"><p>문서를 불러오지 못했습니다. 경로와 API 연결을 확인하세요.</p></section>
  }

  return (
    <section className="kb-reader">
      <header className="kb-reader__header">
        {onBack && <button type="button" onClick={onBack}>목록</button>}
        <div>
          <h1>{fileName(state.document.path)}</h1>
          <p>{state.document.path}</p>
          <time dateTime={state.document.mtime}>{new Date(state.document.mtime).toLocaleString('ko-KR')}</time>
        </div>
      </header>
      <article className="kb-reader__content">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>
          {state.document.content}
        </ReactMarkdown>
      </article>
    </section>
  )
}
