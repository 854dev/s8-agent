import { telegramOwner } from '../lib/telegram/status.mjs';
console.log(await telegramOwner() ?? '연결 없음');
