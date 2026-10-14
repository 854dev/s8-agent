import path from 'node:path';

export const scheduleRoot = agentRoot => path.join(agentRoot, '.s8-runtime', 'scheduler');
export const validId = id => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(id);

export function validateJob({ id, time, intervalMinutes, timezone, script, enabled = true }) {
  if (!validId(id)) throw new Error('id must use lowercase letters, numbers, _ or - (max 40)');
  if (intervalMinutes !== undefined) {
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 60 || 60 % intervalMinutes !== 0 || time !== undefined) throw new Error('intervalMinutes must divide 60, and cannot be combined with time');
  } else if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('time must be HH:mm in 24-hour format');
  if (typeof timezone !== 'string' || !timezone || timezone.length > 80) throw new Error('timezone is required');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); }
  catch { throw new Error('timezone must be a valid IANA time zone'); }
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
  if (typeof script !== 'string' || !script.trim() || Buffer.byteLength(script) > 8_000) throw new Error('script is required and must be at most 8 KB');
  return { id, time, intervalMinutes, timezone, script, enabled };
}

export function dueDate(job, date) {
  if (job.intervalMinutes !== undefined) {
    const slot = Math.floor(date.getTime() / (job.intervalMinutes * 60_000));
    return { date: `interval:${slot}`, time: date.getUTCMinutes() % job.intervalMinutes === 0 ? 'due' : 'not-due' };
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: job.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

export function isDue(job, date, lastRunDate) {
  const current = dueDate(job, date);
  return job.enabled && current.time === (job.intervalMinutes !== undefined ? 'due' : job.time) && current.date !== lastRunDate;
}
