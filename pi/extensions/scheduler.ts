import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Type } from 'typebox';
import { withFileMutationQueue, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { scheduleRoot, validId, validateJob } from '../lib/scheduler-store.mjs';

const parameters = Type.Object({
  action: Type.Union([Type.Literal('list'), Type.Literal('create'), Type.Literal('update'), Type.Literal('delete')]),
  id: Type.Optional(Type.String()),
  time: Type.Optional(Type.String()),
  intervalMinutes: Type.Optional(Type.Integer()),
  timezone: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  script: Type.Optional(Type.String()),
});

export default function (pi: ExtensionAPI) {
  if (!process.env.S8_PI_CONFIG_ROOT) throw new Error('Run S8 through start-pi.sh to use the scheduler.');
  const agentRoot = path.resolve(process.env.S8_PI_CONFIG_ROOT, '..');
  const root = scheduleRoot(agentRoot);
  const scripts = path.join(root, 'scripts');
  const jobsFile = path.join(root, 'jobs.json');
  const stateFile = path.join(root, 'state.json');
  const readJobs = async () => {
    try {
      const data = JSON.parse(await readFile(jobsFile, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.jobs)) throw new Error('Invalid scheduler job file');
      return data.jobs;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  const saveJobs = async jobs => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temp = `${jobsFile}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, jobsFile);
  };
  const withStoreLock = async fn => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    let lock;
    try { lock = await open(`${jobsFile}.lock`, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('Schedule CRUD is locked. If no Pi operation is active, remove the stale jobs.json.lock file.');
      throw error;
    }
    try { return await fn(); }
    finally { await lock.close(); await rm(`${jobsFile}.lock`, { force: true }); }
  };
  const confirm = async (ctx, title, message) => {
    if (!ctx.hasUI) throw new Error('Schedule changes require an interactive confirmation.');
    if (!await ctx.ui.confirm(title, message)) throw new Error('Cancelled by user.');
  };

  pi.registerTool({
    name: 'scheduler',
    label: 'Scheduler',
    description: 'CRUD for daily or interval shell-script jobs. Scripts execute as the current OS user at the scheduled local time. Creating, changing, or deleting a job requires interactive user confirmation. Use list/create/update/delete.',
    parameters,
    async execute(_id, args, _signal, _onUpdate, ctx) {
      return withFileMutationQueue(jobsFile, async () => {
        if (args.action === 'list') {
          const jobs = await readJobs();
          let state = { jobs: {} };
          try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          return { content: [{ type: 'text', text: JSON.stringify(jobs.map(job => ({ ...job, ...(state.jobs?.[job.id] ?? {}) })), null, 2) || '[]' }], details: undefined };
        }
        return withStoreLock(async () => {
          const jobs = await readJobs();
          if (!validId(args.id)) throw new Error('A valid schedule id is required.');
        const index = jobs.findIndex(job => job.id === args.id);
        const scriptPath = path.join(scripts, `${args.id}.sh`);

        if (args.action === 'create') {
          if (index >= 0) throw new Error('Schedule id already exists.');
          const job = validateJob({
            id: args.id, time: args.time, intervalMinutes: args.intervalMinutes, timezone: args.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
            script: args.script,
          });
          await confirm(ctx, '예약 작업 생성', `${job.id} · ${job.time ? `매일 ${job.time}` : `${job.intervalMinutes}분마다`} (${job.timezone}) · ${args.enabled ?? true ? '활성화' : '중지 상태'}\n현재 사용자 권한으로 실행됩니다. 아래 스크립트를 확인하세요.\n\n${job.script}`);
          await mkdir(scripts, { recursive: true, mode: 0o700 });
          await writeFile(scriptPath, job.script, { flag: 'wx', mode: 0o700 });
          jobs.push({ id: job.id, time: job.time, intervalMinutes: job.intervalMinutes, timezone: job.timezone, enabled: args.enabled ?? true });
          try { await saveJobs(jobs); } catch (error) { await rm(scriptPath, { force: true }); throw error; }
          return { content: [{ type: 'text', text: `Created ${job.id}: ${job.time ?? `${job.intervalMinutes} minute interval`} (${job.timezone})` }], details: undefined };
        }

        if (index < 0) throw new Error('Schedule not found.');
        if (args.action === 'delete') {
          await confirm(ctx, '예약 작업 삭제', `${args.id} 예약과 스크립트를 삭제할까요?`);
          jobs.splice(index, 1);
          await saveJobs(jobs);
          await rm(scriptPath, { force: true });
          return { content: [{ type: 'text', text: `Deleted ${args.id}` }], details: undefined };
        }

        const current = jobs[index];
        const script = args.script ?? await readFile(scriptPath, 'utf8');
        const job = validateJob({
          id: args.id, time: args.intervalMinutes !== undefined ? undefined : args.time ?? current.time,
          intervalMinutes: args.time !== undefined ? undefined : args.intervalMinutes ?? current.intervalMinutes,
          timezone: args.timezone ?? current.timezone, script,
        });
        await confirm(ctx, '예약 작업 수정', `${job.id} · ${job.time ? `매일 ${job.time}` : `${job.intervalMinutes}분마다`} (${job.timezone}) · ${args.enabled ?? current.enabled ? '활성화' : '중지'}\n${args.script ? `현재 사용자 권한으로 실행될 스크립트를 확인하세요.\n\n${job.script}` : '스크립트 내용은 변경되지 않습니다.'}`);
        const oldScript = await readFile(scriptPath, 'utf8');
        const tempScript = `${scriptPath}.${process.pid}.tmp`;
        await writeFile(tempScript, job.script, { mode: 0o700 });
        await rename(tempScript, scriptPath);
        jobs[index] = { ...current, time: job.time, intervalMinutes: job.intervalMinutes, timezone: job.timezone, enabled: args.enabled ?? current.enabled };
        try { await saveJobs(jobs); } catch (error) {
          const rollback = `${tempScript}.rollback`;
          await writeFile(rollback, oldScript, { mode: 0o700 });
          await rename(rollback, scriptPath);
          throw error;
        }
        return { content: [{ type: 'text', text: `Updated ${job.id}` }], details: undefined };
        });
      });
    },
  });
}
