import { visible } from '../../apps/telegram-gateway/gateway.mjs';
import { telegramConfigFromEnv } from './telegram-config.mjs';

export const sendTelegram = async (text, env = process.env, fetchImpl = fetch, settings = telegramConfigFromEnv(env)) => {
  if (!env.TELEGRAM_BOT_TOKEN || !settings.scheduleChatId) return false;
  const allowed = new Set([...settings.allowedUserIds, ...settings.allowedGroupIds]);
  if (!allowed.has(settings.scheduleChatId)) throw new Error('Scheduled Telegram target must be in an allowed user or group list.');
  const safe = Array.from(visible(text));
  for (let offset = 0; offset < safe.length; offset += 3500) {
    // ponytail: a lost response can cause a duplicate notification; a durable outbox is needed for crash recovery.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: settings.scheduleChatId, text: safe.slice(offset, offset + 3500).join('') }),
          signal: AbortSignal.timeout(15_000),
        });
        const body = await response.json();
        if (!response.ok || !body.ok) {
          const status = Number.isInteger(body.error_code) ? body.error_code : response.status;
          throw Object.assign(new Error(`Telegram send failed (HTTP ${status})`), { status, retryAfterMs: Math.min(5000, Math.max(0, Number(body.parameters?.retry_after) || 0) * 1000) });
        }
        break;
      } catch (error) {
        if (attempt === 2 || (error.status && error.status !== 429 && error.status < 500)) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.max(300 * (attempt + 1), error.retryAfterMs ?? 0)));
      }
    }
  }
  return true;
};

