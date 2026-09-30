import { useEffect, useMemo, useState } from 'react'
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Container,
  Divider,
  Grid,
  Group,
  Paper,
  Progress,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core'
import {
  IconArrowRight,
  IconChecklist,
  IconClockHour5,
  IconFileText,
  IconLayoutGrid,
  IconListDetails,
  IconPlayerPause,
  IconRobot,
  IconSparkles,
} from '@tabler/icons-react'
import { buildKnowledgeBaseUrl, getAppBaseUrl, getAppView, type AppView } from './app-route'
import KnowledgeBasePage from './features/knowledge-base/KnowledgeBasePage'
import UploadPage from './features/upload/UploadPage'

type GroupKey = '로컬링크' | '멀티플즈ax' | '854sw'
type TaskStatus = '진행중' | '승인대기' | '보충가능' | '보류'
type TaskPolicy = 'manual_only' | 'assist_allowed' | 'autonomous_allowed'

type TaskItem = {
  id: string
  group: GroupKey
  topic: string
  title: string
  status: TaskStatus
  policy: TaskPolicy
  nextRun: string
  progress: number
  files: string[]
  lastSummary: string
}

type TurnLog = {
  time: string
  task: string
  summary: string
  changed: string
}

type QueueItem = {
  title: string
  task: string
  detail: string
  meta: string
}

const tasks: TaskItem[] = [
  {
    id: 'S8-001',
    group: '로컬링크',
    topic: 'phcms / admin-ui-next',
    title: 'contents preview split-view / workspace polish',
    status: '진행중',
    policy: 'assist_allowed',
    nextRun: '4분 후',
    progress: 72,
    files: [
      'ph-cms/packages/admin-ui-next/app/console/contents/page.tsx',
      'ph-cms/packages/admin-ui-next/src/ui/rich-text-editor-workspace.tsx',
    ],
    lastSummary: 'preview 패턴 비교와 편집 패널 정리 진행중',
  },
  {
    id: 'S8-002',
    group: '멀티플즈ax',
    topic: '기업명 fuzzy matching',
    title: 'OCR 노이즈 대응 threshold / decision rule 확정',
    status: '승인대기',
    policy: 'manual_only',
    nextRun: '승인 필요',
    progress: 46,
    files: ['multiplez-agent/modules/pseudonymization-core/README.md'],
    lastSummary: '정규화 규칙은 정리됨, threshold 결정 대기',
  },
  {
    id: 'S8-003',
    group: '854sw',
    topic: '게임 공통코드',
    title: 'FSM / 사운드 훅 / 간단 AI 선택 로직 범위 정리',
    status: '보충가능',
    policy: 'autonomous_allowed',
    nextRun: 'idle 1턴',
    progress: 31,
    files: ['854_md/p4 - studio854/게임개발-공통코드-FSM-LimboAI-메모.md'],
    lastSummary: '유휴시간에 사례 수집과 비범위 정리 가능',
  },
  {
    id: 'S8-004',
    group: '로컬링크',
    topic: '스탬프투어 데이터 이관',
    title: '영향 범위 / 체크리스트 정리',
    status: '보류',
    policy: 'assist_allowed',
    nextRun: '담당자 확인 후',
    progress: 18,
    files: ['854_md/g - 목표관리/003. 위클리.md'],
    lastSummary: '건수 확인 전 추가 진행 보류',
  },
]

const turnLogs: TurnLog[] = [
  { time: '18:05', task: 'S8-001', summary: 'preview split-view 비교 패턴 정리', changed: 'contents page / workspace UI 메모' },
  { time: '18:00', task: 'S8-002', summary: 'confidence band 구간 초안 정리', changed: 'threshold 메모 업데이트' },
  { time: '17:55', task: 'S8-003', summary: 'FSM 재사용 비범위 보충', changed: '공통코드 메모 보강' },
]

const approvalQueue: QueueItem[] = [
  {
    title: 'fuzzy threshold 확정',
    task: 'S8-002',
    detail: 'high / medium / low confidence 경계 확인 필요',
    meta: 'manual_only',
  },
  {
    title: 'bbox 도입 시점 판단',
    task: 'S8-005',
    detail: '양식 K 좌표 기반 분리 방식을 지금 넣을지 검토 필요',
    meta: 'approval_required',
  },
]

const idleQueue: QueueItem[] = [
  {
    title: 'OCR 실패 샘플 30건 분류',
    task: 'S8-002',
    detail: '실패 유형 태깅 / recall 관점 정리',
    meta: 'idle 2턴',
  },
  {
    title: 'preview split-view 참고 패턴 수집',
    task: 'S8-001',
    detail: '편집/미리보기 2단 분할 사례 메모',
    meta: 'idle 1턴',
  },
  {
    title: 'HUD 훅 사례 메모',
    task: 'S8-003',
    detail: '간단 HUD / sfx hook 연결 사례 정리',
    meta: 'idle 1턴',
  },
]

const statusColorMap: Record<TaskStatus, string> = {
  진행중: 'green',
  승인대기: 'yellow',
  보충가능: 'blue',
  보류: 'gray',
}

const policyLabelMap: Record<TaskPolicy, string> = {
  manual_only: 'manual',
  assist_allowed: 'assist',
  autonomous_allowed: 'auto',
}

function App() {
  const appBaseUrl = getAppBaseUrl(import.meta.env.BASE_URL)
  const [view, setView] = useState<AppView>(() => getAppView(window.location.pathname, appBaseUrl))
  const [viewMode, setViewMode] = useState<'card' | 'table'>('card')
  const [activeGroup, setActiveGroup] = useState<GroupKey | '전체'>('전체')

  useEffect(() => {
    const handlePopState = () => setView(getAppView(window.location.pathname, appBaseUrl))
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [appBaseUrl])

  const filteredTasks = useMemo(() => {
    if (activeGroup === '전체') return tasks
    return tasks.filter((task) => task.group === activeGroup)
  }, [activeGroup])

  const navigate = (nextView: AppView) => {
    const baseUrl = appBaseUrl
    const nextUrl = nextView === 'knowledge-base' ? buildKnowledgeBaseUrl(baseUrl) : baseUrl
    window.history.pushState({}, '', nextUrl)
    setView(nextView)
  }

  if (view === 'knowledge-base') {
    return <KnowledgeBasePage onNavigateDashboard={() => navigate('dashboard')} onNavigateUpload={() => navigate('upload')} />
  }

  if (view === 'upload') {
    return <UploadPage />
  }

  const activeTask = tasks[0]

  return (
    <Container size="xl" py="md">
      <Stack gap="md">
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between" align="flex-start">
            <Stack gap={4}>
              <Group gap="xs">
                <ThemeIcon variant="light" color="dark" size={28} radius="md">
                  <IconClockHour5 size={16} />
                </ThemeIcon>
                <Title order={2}>s8gent</Title>
                <Badge variant="dot" color="green">online</Badge>
              </Group>
              <Text fw={700}>{activeTask.title}</Text>
              <Group gap="xs">
                <Badge color={statusColorMap[activeTask.status]} variant="light">{activeTask.status}</Badge>
                <Badge color="gray" variant="outline">{policyLabelMap[activeTask.policy]}</Badge>
                <Badge color="dark" variant="light">다음 턴 {activeTask.nextRun}</Badge>
              </Group>
            </Stack>

            <Group gap="xs">
              <Button size="xs" variant="light" color="dark" onClick={() => navigate('upload')}>업로드</Button>
              <Button size="xs" variant="light" color="dark" onClick={() => navigate('knowledge-base')}>지식베이스</Button>
              <Button size="xs" color="dark" leftSection={<IconArrowRight size={14} />}>다음 턴</Button>
              <ActionIcon variant="light" color="gray"><IconPlayerPause size={16} /></ActionIcon>
            </Group>
          </Group>
        </Paper>

        <SimpleGrid cols={{ base: 2, md: 5 }} spacing="md">
          <MetricCard label="활성" value="3" icon={<IconChecklist size={16} />} />
          <MetricCard label="승인대기" value="2" icon={<IconRobot size={16} />} />
          <MetricCard label="보충큐" value="3" icon={<IconSparkles size={16} />} />
          <MetricCard label="변경파일" value="7" icon={<IconFileText size={16} />} />
          <MetricCard label="다음 턴" value="04:00" icon={<IconClockHour5 size={16} />} />
        </SimpleGrid>

        <Grid>
          <Grid.Col span={{ base: 12, lg: 8 }}>
            <Paper withBorder p="md" radius="md">
              <Group justify="space-between" mb="md">
                <Group gap="xs">
                  <Title order={3}>작업 보드</Title>
                  <Badge variant="light" color="gray">{filteredTasks.length}</Badge>
                </Group>
                <SegmentedControl
                  size="xs"
                  value={viewMode}
                  onChange={(value) => setViewMode(value as 'card' | 'table')}
                  data={[
                    { value: 'card', label: <Group gap={4}><IconLayoutGrid size={12} /><span>카드</span></Group> },
                    { value: 'table', label: <Group gap={4}><IconListDetails size={12} /><span>표</span></Group> },
                  ]}
                />
              </Group>

              <Tabs value={activeGroup} onChange={(value) => setActiveGroup((value as GroupKey | '전체') ?? '전체')}>
                <Tabs.List>
                  <Tabs.Tab value="전체">전체</Tabs.Tab>
                  <Tabs.Tab value="로컬링크">로컬링크</Tabs.Tab>
                  <Tabs.Tab value="멀티플즈ax">멀티플즈ax</Tabs.Tab>
                  <Tabs.Tab value="854sw">854sw</Tabs.Tab>
                </Tabs.List>
              </Tabs>

              <div style={{ marginTop: 12 }}>
                {viewMode === 'card' ? <TaskCardView tasks={filteredTasks} /> : <TaskTableView tasks={filteredTasks} />}
              </div>
            </Paper>
          </Grid.Col>

          <Grid.Col span={{ base: 12, lg: 4 }}>
            <Stack gap="md">
              <QueuePanel title="승인 대기" items={approvalQueue} />
              <QueuePanel title="유휴 보충 큐" items={idleQueue} />
            </Stack>
          </Grid.Col>
        </Grid>

        <Grid>
          <Grid.Col span={{ base: 12, lg: 6 }}>
            <Paper withBorder p="md" radius="md">
              <Group justify="space-between" mb="md">
                <Title order={3}>현재 작업</Title>
                <Badge color="dark" variant="light">{activeTask.id}</Badge>
              </Group>
              <Stack gap="sm">
                <InfoRow label="그룹" value={activeTask.group} />
                <InfoRow label="토픽" value={activeTask.topic} />
                <InfoRow label="최근 요약" value={activeTask.lastSummary} />
                <div>
                  <Group justify="space-between" mb={6}>
                    <Text size="sm" c="dimmed">진행률</Text>
                    <Text size="sm">{activeTask.progress}%</Text>
                  </Group>
                  <Progress value={activeTask.progress} color="dark" radius="xl" />
                </div>
                <Divider />
                <Stack gap={4}>
                  {activeTask.files.map((file) => (
                    <Text key={file} ff="monospace" size="xs">{file}</Text>
                  ))}
                </Stack>
              </Stack>
            </Paper>
          </Grid.Col>

          <Grid.Col span={{ base: 12, lg: 6 }}>
            <Paper withBorder p="md" radius="md">
              <Group justify="space-between" mb="md">
                <Title order={3}>턴 로그</Title>
                <Badge variant="light" color="gray">최근 3턴</Badge>
              </Group>
              <Stack gap="sm">
                {turnLogs.map((log) => (
                  <Card key={`${log.time}-${log.task}`} withBorder radius="md" padding="sm">
                    <Group justify="space-between" mb={4}>
                      <Group gap="xs">
                        <Badge variant="light" color="dark">{log.task}</Badge>
                        <Text size="xs" c="dimmed">{log.time}</Text>
                      </Group>
                    </Group>
                    <Text size="sm" fw={600}>{log.summary}</Text>
                    <Text size="sm" c="dimmed">{log.changed}</Text>
                  </Card>
                ))}
              </Stack>
            </Paper>
          </Grid.Col>
        </Grid>
      </Stack>
    </Container>
  )
}

function MetricCard({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <Paper withBorder p="sm" radius="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Text size="xs" c="dimmed">{label}</Text>
          <Text fw={800} fz={24} lh={1.1}>{value}</Text>
        </div>
        <ThemeIcon variant="light" color="dark" radius="md" size={28}>{icon}</ThemeIcon>
      </Group>
    </Paper>
  )
}

function TaskCardView({ tasks }: { tasks: TaskItem[] }) {
  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
      {tasks.map((task) => (
        <Card key={task.id} withBorder radius="md" padding="md">
          <Stack gap="sm">
            <Group justify="space-between" align="flex-start">
              <Stack gap={4}>
                <Group gap="xs">
                  <Badge color={statusColorMap[task.status]} variant="light">{task.status}</Badge>
                  <Badge color="gray" variant="outline">{policyLabelMap[task.policy]}</Badge>
                </Group>
                <Text fw={700}>{task.title}</Text>
                <Text size="sm" c="dimmed">{task.group} / {task.topic}</Text>
              </Stack>
              <Badge color="dark" variant="light">{task.id}</Badge>
            </Group>

            <Text size="sm">{task.lastSummary}</Text>

            <Group justify="space-between">
              <Text size="sm" c="dimmed">다음 턴</Text>
              <Text size="sm" fw={600}>{task.nextRun}</Text>
            </Group>

            <Group justify="space-between" align="center" gap="sm">
              <Progress value={task.progress} color="dark" radius="xl" style={{ flex: 1 }} />
              <Text size="xs">{task.progress}%</Text>
            </Group>

            <Stack gap={2}>
              {task.files.slice(0, 2).map((file) => (
                <Text key={file} ff="monospace" size="xs">{file}</Text>
              ))}
            </Stack>
          </Stack>
        </Card>
      ))}
    </SimpleGrid>
  )
}

function TaskTableView({ tasks }: { tasks: TaskItem[] }) {
  return (
    <Table.ScrollContainer minWidth={780}>
      <Table highlightOnHover verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>작업</Table.Th>
            <Table.Th>그룹</Table.Th>
            <Table.Th>상태</Table.Th>
            <Table.Th>정책</Table.Th>
            <Table.Th>다음 턴</Table.Th>
            <Table.Th>진행률</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {tasks.map((task) => (
            <Table.Tr key={task.id}>
              <Table.Td>
                <Stack gap={2}>
                  <Text fw={700}>{task.title}</Text>
                  <Text size="xs" c="dimmed">{task.id}</Text>
                </Stack>
              </Table.Td>
              <Table.Td>{task.group}</Table.Td>
              <Table.Td><Badge color={statusColorMap[task.status]} variant="light">{task.status}</Badge></Table.Td>
              <Table.Td>{policyLabelMap[task.policy]}</Table.Td>
              <Table.Td>{task.nextRun}</Table.Td>
              <Table.Td>
                <Group gap="xs" wrap="nowrap">
                  <Progress value={task.progress} color="dark" radius="xl" style={{ flex: 1 }} />
                  <Text size="xs">{task.progress}%</Text>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  )
}

function QueuePanel({ title, items }: { title: string; items: QueueItem[] }) {
  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" mb="md">
        <Title order={3}>{title}</Title>
        <Badge variant="light" color="gray">{items.length}</Badge>
      </Group>
      <Stack gap="sm">
        {items.map((item) => (
          <Card key={`${item.task}-${item.title}`} withBorder radius="md" padding="sm">
            <Stack gap={4}>
              <Group justify="space-between" align="flex-start">
                <Text fw={700}>{item.title}</Text>
                <Badge variant="light" color="dark">{item.task}</Badge>
              </Group>
              <Text size="sm">{item.detail}</Text>
              <Text size="xs" c="dimmed">{item.meta}</Text>
            </Stack>
          </Card>
        ))}
      </Stack>
    </Paper>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <Group justify="space-between" align="flex-start" gap="md">
      <Text size="sm" c="dimmed">{label}</Text>
      <Text size="sm" ta="right" maw="70%">{value}</Text>
    </Group>
  )
}

export default App
