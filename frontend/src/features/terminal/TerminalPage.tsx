import { useEffect, useRef, useState } from 'react'
import { Button, Group, Select, Stack, Text, Textarea, Title } from '@mantine/core'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { controlInput, terminalKeys } from './key-input'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'

const terminalFontFamily = '"S8 Nerd Symbols", Menlo, Consolas, "Liberation Mono", "Noto Sans Mono CJK KR", "Apple SD Gothic Neo", "Malgun Gothic", monospace'
const shellSession = 's8-host-shell'
const primaryKeys = terminalKeys.filter(([label]) => ['Esc', 'Tab', 'Ctrl+C', '↑', '↓', '←', '→'].includes(label))
const secondaryKeys = terminalKeys.filter(key => !primaryKeys.includes(key))
export default function TerminalPage({ onBack }: { onBack: () => void }) {
  const [sessions, setSessions] = useState<string[]>([])
  const [session, setSession] = useState<string | null>(shellSession)
  const [status, setStatus] = useState('셸에 연결 중…')
  const [connected, setConnected] = useState(false)
  const [revision, setRevision] = useState(0)
  const [ctrl, setCtrl] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [paste, setPaste] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [fontSize, setFontSize] = useState(12)
  const page = useRef<HTMLDivElement>(null)
  const ctrlRef = useRef(false)
  const fontSizeRef = useRef(fontSize)
  const nativeFullscreen = useRef(false)
  const resizeRef = useRef<(() => void) | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  function setControl(value: boolean) { ctrlRef.current = value; setCtrl(value) }
  function send(data: string) {
    const socket = socketRef.current
    if (socket?.readyState !== WebSocket.OPEN) return
    const characters = Array.from(data)
    for (let offset = 0; offset < characters.length; offset += 2048) socket.send(JSON.stringify({ type: 'input', data: characters.slice(offset, offset + 2048).join('') }))
  }
  async function refresh() {
    try {
      const response = await fetch('/api/terminal/sessions', { cache: 'no-store' })
      if (!response.ok) throw new Error()
      const data = await response.json() as { sessions: string[] }
      setSessions(data.sessions)
    } catch { setStatus('세션 목록을 조회하지 못했습니다. 백엔드를 확인하세요.') }
  }
  async function openShell() {
    try {
      const response = await fetch('/api/terminal/shell', { method: 'POST' })
      if (!response.ok) throw new Error()
      const data = await response.json() as { session: string }
      setSession(data.session); setRevision(value => value + 1)
      await refresh()
    } catch { setStatus('셸을 열지 못했습니다. 백엔드를 확인하세요.') }
  }
  async function toggleFullscreen() {
    if (expanded) {
      if (document.fullscreenElement === page.current) {
        try { await document.exitFullscreen() } catch { return }
      }
      setExpanded(false)
    } else {
      setExpanded(true)
      // App-level full screen also works on HTTP and browsers without this API.
      try { await page.current?.requestFullscreen?.() } catch { /* Keep the viewport-filling fallback. */ }
    }
  }
  useEffect(() => { void refresh() }, [])
  useEffect(() => {
    const updateViewport = () => {
      page.current?.style.setProperty('--terminal-viewport-height', `${window.visualViewport?.height ?? window.innerHeight}px`)
      page.current?.style.setProperty('--terminal-viewport-top', `${window.visualViewport?.offsetTop ?? 0}px`)
      resizeRef.current?.()
    }
    const updateFullscreen = () => {
      const active = document.fullscreenElement === page.current
      if (active || nativeFullscreen.current) setExpanded(active)
      nativeFullscreen.current = active
    }
    updateViewport()
    window.addEventListener('resize', updateViewport)
    window.visualViewport?.addEventListener('resize', updateViewport)
    window.visualViewport?.addEventListener('scroll', updateViewport)
    document.addEventListener('fullscreenchange', updateFullscreen)
    return () => {
      window.removeEventListener('resize', updateViewport)
      window.visualViewport?.removeEventListener('resize', updateViewport)
      window.visualViewport?.removeEventListener('scroll', updateViewport)
      document.removeEventListener('fullscreenchange', updateFullscreen)
    }
  }, [])
  useEffect(() => {
    if (!expanded) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [expanded])
  useEffect(() => {
    if (!session || !container.current) return
    const terminal = new Terminal({ cursorBlink: true, fontFamily: terminalFontFamily, fontSize: fontSizeRef.current, scrollback: 3000 })
    terminalRef.current = terminal
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container.current)
    fit.fit()
    const url = new URL('/api/terminal/ws', window.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('session', session)
    const socket = new WebSocket(url)
    socketRef.current = socket
    setStatus('연결 중…'); setConnected(false); setControl(false)
    const sendSize = () => {
      fit.fit()
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: Math.min(300, Math.max(2, terminal.cols)), rows: Math.min(150, Math.max(2, terminal.rows)) }))
    }
    resizeRef.current = sendSize
    // Font downloads must not delay the shell connection or refresh a disposed terminal.
    void document.fonts?.load('12px "S8 Nerd Symbols"', '\uf4d3').then(() => {
      if (terminalRef.current !== terminal) return
      sendSize()
      terminal.refresh(0, terminal.rows - 1)
    }).catch(() => { /* Keep system font fallback if the icon font cannot load. */ })
    socket.onopen = () => { setStatus('연결됨'); setConnected(true); sendSize() }
    socket.onmessage = event => { if (typeof event.data === 'string') terminal.write(event.data) }
    socket.onerror = () => setStatus('연결 오류')
    socket.onclose = () => { setConnected(false); setControl(false); setStatus('연결 종료. 재연결하거나 셸 열기를 누르세요.') }
    const input = terminal.onData(data => {
      if (ctrlRef.current) { setControl(false); send(controlInput(data)) }
      else send(data)
    })
    const observer = new ResizeObserver(sendSize)
    observer.observe(container.current)
    return () => {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
      observer.disconnect(); input.dispose(); socket.close(); terminal.dispose()
      terminalRef.current = null; socketRef.current = null; resizeRef.current = null
    }
  }, [session, revision])
  useEffect(() => {
    fontSizeRef.current = fontSize
    if (terminalRef.current) terminalRef.current.options.fontSize = fontSize
    const frame = requestAnimationFrame(() => resizeRef.current?.())
    return () => cancelAnimationFrame(frame)
  }, [fontSize, expanded])
  const keyButton = ([label, data]: readonly [string, string]) => <Button key={label} size="xs" variant="light" disabled={!connected} onClick={() => { setControl(false); send(data); terminalRef.current?.focus() }}>{label}</Button>
  return <div ref={page} className={`terminal-page${expanded ? ' terminal-page--fullscreen' : ''}`}>
    <header className="terminal-topbar">
      <Title order={2} className="terminal-heading">S8 터미널</Title>
      <Button size="xs" variant="light" aria-label="글자 축소" disabled={fontSize <= 8} onClick={() => setFontSize(value => Math.max(8, value - 1))}>A−</Button>
      <output aria-label="글자 크기">{fontSize}px</output>
      <Button size="xs" variant="light" aria-label="글자 확대" disabled={fontSize >= 24} onClick={() => setFontSize(value => Math.min(24, value + 1))}>A+</Button>
      <Button size="xs" variant="light" aria-pressed={expanded} onClick={() => void toggleFullscreen()}>{expanded ? '전체화면 해제' : '전체화면'}</Button>
      {!expanded && <Button size="xs" variant="light" onClick={onBack}>뒤로</Button>}
    </header>
    <details className="terminal-settings" onToggle={() => resizeRef.current?.()}>
      <summary>세션·연결 설정 · {session === shellSession ? '호스트 셸' : session ?? '연결 해제'}</summary>
      <Stack gap="xs" className="terminal-settings-content">
        <Text size="xs">PHCMS·S8 서비스 등 호스트의 모든 tmux 세션에 접속합니다. 호스트 셸에서 서비스 명령을 실행할 수 있습니다. 입력·화면 크기는 다른 접속자와 공유됩니다.</Text>
        <Group gap="xs">
          <Select aria-label="터미널 세션" placeholder="세션 선택" comboboxProps={{ withinPortal: false }} data={sessions.map(name => ({ value: name, label: name === shellSession ? '호스트 셸' : name }))} value={session} onChange={setSession} />
          <Button size="xs" onClick={() => void openShell()}>셸 열기</Button>
          <Button size="xs" variant="light" onClick={() => void refresh()}>목록 새로고침</Button>
          <Button size="xs" disabled={!session} onClick={() => setRevision(value => value + 1)}>재연결</Button>
          <Button size="xs" disabled={!session} variant="light" onClick={() => { setSession(null); setConnected(false); setControl(false); setStatus('연결 해제됨. tmux 세션은 유지됩니다.') }}>연결 해제</Button>
          <Button size="xs" variant="light" onClick={() => setFontSize(12)}>기본 글자 크기</Button>
        </Group>
        <Text size="xs">보조 키는 좌우로 밀어 더 볼 수 있습니다. Ctrl은 다음 문자에 한 번 적용됩니다.</Text>
      </Stack>
    </details>
    <Text role="status" className="terminal-status" title={status}>{status}{ctrl ? ' · Ctrl 대기' : ''}</Text>
    <div ref={container} aria-label="터미널" className="terminal-screen" />
    {pasteOpen && <Stack gap="xs" className="terminal-paste">
      <Textarea label="붙여넣을 텍스트" placeholder="길게 눌러 붙여넣으세요." value={paste} onChange={event => setPaste(event.currentTarget.value)} rows={2} />
      <Text size="xs">Enter는 추가하지 않습니다. 여러 줄 텍스트는 실행될 수 있으므로 확인하세요.</Text>
      <Group gap="xs">
        <Button size="xs" disabled={!connected || !paste} onClick={() => { setControl(false); send(paste); setPaste(''); setPasteOpen(false); terminalRef.current?.focus() }}>입력 보내기</Button>
        <Button size="xs" variant="light" onClick={() => setPasteOpen(false)}>닫기</Button>
      </Group>
    </Stack>}
    <div className="terminal-shortcuts" aria-label="터미널 보조 키">
      <div className="terminal-key-row">
        <Button size="xs" disabled={!connected} variant={ctrl ? 'filled' : 'light'} aria-pressed={ctrl} onClick={() => { setControl(!ctrlRef.current); terminalRef.current?.focus() }}>Ctrl</Button>
        {primaryKeys.map(keyButton)}
      </div>
      <div className="terminal-key-row">
        <Button size="xs" variant="light" disabled={!connected} onClick={() => terminalRef.current?.focus()}>키보드</Button>
        <Button size="xs" variant="light" disabled={!connected} aria-expanded={pasteOpen} onClick={() => setPasteOpen(value => !value)}>붙여넣기</Button>
        {secondaryKeys.map(keyButton)}
      </div>
    </div>
  </div>
}
