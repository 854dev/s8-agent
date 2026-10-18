import { open } from 'node:fs/promises';
import { constants } from 'node:fs';

const fail = (status, code) => Object.assign(new Error(code), { status, code });

/** Cursor is a byte position after a complete line. Legacy offset remains a nonempty-line index. */
export async function readEventPage(file, { offset = 0, cursor, follow = false } = {}) {
  if (![offset, ...(cursor === undefined ? [] : [cursor])].every(value => Number.isSafeInteger(value) && value >= 0)) throw fail(400, 'INVALID_CURSOR');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw fail(400, 'INVALID_CURSOR');
    let position = cursor ?? 0, readPosition = position, index = 0, pageBytes = 0;
    if (position > stat.size) throw fail(409, 'LOG_CHANGED');
    if (position) {
      const previous = Buffer.alloc(1);
      await handle.read(previous, 0, 1, position - 1);
      if (previous[0] !== 10) throw fail(400, 'INVALID_CURSOR');
    }
    const events = [], buffer = Buffer.alloc(65536);
    let pending = Buffer.alloc(0);
    const page = more => ({ events, nextOffset: more || follow ? offset + events.length : null, nextCursor: more || follow ? position : null });
    while (readPosition < stat.size) {
      // ponytail: legacy line offsets scan from the start; byte cursors avoid this 64MB scan ceiling.
      if (cursor === undefined && readPosition >= 64000000) throw fail(413, 'LOG_CURSOR_REQUIRED');
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - readPosition), readPosition);
      if (!bytesRead) throw fail(409, 'LOG_CHANGED');
      readPosition += bytesRead;
      // ponytail: buffer complete JSON lines up to 2MB; larger events need producer-side splitting.
      pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
      let end;
      while ((end = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, end);
        if (line.length > 2000000) throw fail(413, 'LOG_LINE_TOO_LARGE');
        if (line.length && (cursor !== undefined || index >= offset) && events.length && pageBytes + line.length > 1000000) return page(true);
        pending = pending.subarray(end + 1);
        position += end + 1;
        if (!line.length) continue;
        if (cursor === undefined && index++ < offset) continue;
        try { events.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))); }
        catch { throw fail(502, 'LOG_CORRUPT'); }
        pageBytes += line.length;
        if (events.length === 30) return page(position < stat.size);
      }
      if (pending.length > 2000000) throw fail(413, 'LOG_LINE_TOO_LARGE');
    }
    // A writer may still be appending this last line. Do not parse or advance past it.
    return page(pending.length > 0);
  } finally { await handle.close(); }
}
