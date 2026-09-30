import { useState, useRef } from 'react'
import { ActionIcon, Button, Card, Container, Group, Progress, Stack, Text, Title } from '@mantine/core'
import { IconUpload, IconFile, IconX, IconCheck, IconTrash } from '@tabler/icons-react'
import { getAppBaseUrl } from '../../app-route'

type UploadFile = {
  file: File
  progress: number
  status: 'pending' | 'uploading' | 'done' | 'error'
  result?: { id: string; savedAs: string; size: number }
  error?: string
}

export default function UploadPage() {
  const [files, setFiles] = useState<UploadFile[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const apiBase = getAppBaseUrl(import.meta.env.BASE_URL).replace(/\/s8\/?$/, '')

  const addFiles = (newFiles: FileList) => {
    const list: UploadFile[] = Array.from(newFiles).map((f) => ({ file: f, progress: 0, status: 'pending' }))
    setFiles((prev) => [...prev, ...list])
  }

  const upload = async (idx: number) => {
    const item = files[idx]
    if (!item || item.status !== 'pending') return

    setFiles((prev) => prev.map((f, i) => (i === idx ? { ...f, status: 'uploading' } : f)))

    const form = new FormData()
    form.append('file', item.file)

    try {
      const res = await fetch(`${apiBase}/api/files/upload`, {
        method: 'POST',
        body: form,
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `HTTP ${res.status}`)
      }
      const result = await res.json()
      setFiles((prev) => prev.map((f, i) =>
        i === idx ? { ...f, status: 'done', progress: 100, result } : f
      ))
    } catch (err) {
      setFiles((prev) => prev.map((f, i) =>
        i === idx ? { ...f, status: 'error', error: String(err) } : f
      ))
    }
  }

  const uploadAll = () => {
    files.forEach((f, i) => { if (f.status === 'pending') upload(i) })
  }

  const clear = () => setFiles([])

  const dropHandler = (e: React.DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
  }

  return (
    <Container size="sm" py="xl">
      <Stack gap="lg">
        <div>
          <Title order={2}>파일 업로드</Title>
          <Text c="dimmed" size="sm">최대 200MB, 이미지·문서·압축파일 가능</Text>
        </div>

        <Card withBorder padding="xl" style={{ borderStyle: 'dashed' }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={dropHandler}
        >
          <Stack align="center" gap="xs">
            <IconUpload size={40} stroke={1} color="gray" />
            <Text size="sm" c="dimmed">파일을 여기에 드래그하거나 클릭해서 선택</Text>
            <input
              ref={inputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => e.target.files && addFiles(e.target.files!)}
            />
            <Button variant="light" size="xs" onClick={() => inputRef.current?.click()}>파일 선택</Button>
          </Stack>
        </Card>

        {files.length > 0 && (
          <Card withBorder padding="md">
            <Group justify="space-between" mb="sm">
              <Text fw={600}>{files.length}개 파일</Text>
              <Group gap="xs">
                <Button size="xs" onClick={uploadAll} disabled={files.every((f) => f.status !== 'pending')}>
                  모두 업로드
                </Button>
                <ActionIcon variant="subtle" color="gray" onClick={clear}><IconTrash size={16} /></ActionIcon>
              </Group>
            </Group>
            <Stack gap="xs">
              {files.map((f, i) => (
                <Card key={i} withBorder padding="xs">
                  <Group gap="sm" wrap="nowrap">
                    <IconFile size={20} stroke={1.5} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Text size="sm" truncate>{f.file.name}</Text>
                      <Text size="xs" c="dimmed">{(f.file.size / 1024 / 1024).toFixed(1)}MB</Text>
                    </div>
                    {f.status === 'pending' && (
                      <Button size="compact-xs" onClick={() => upload(i)}>업로드</Button>
                    )}
                    {f.status === 'uploading' && <Progress size="sm" w={80} value={100} animated />}
                    {f.status === 'done' && (
                      <Group gap={4}>
                        <IconCheck size={18} color="green" />
                        <Text size="xs" c="green">완료</Text>
                      </Group>
                    )}
                    {f.status === 'error' && (
                      <Group gap={4}>
                        <IconX size={18} color="red" />
                        <Text size="xs" c="red" truncate maw={200}>{f.error}</Text>
                      </Group>
                    )}
                  </Group>
                  {f.result && (
                    <Text size="xs" c="dimmed" mt={4}>
                      저장됨: {f.result.savedAs} ({(f.result.size / 1024).toFixed(0)}KB)
                    </Text>
                  )}
                </Card>
              ))}
            </Stack>
          </Card>
        )}
      </Stack>
    </Container>
  )
}