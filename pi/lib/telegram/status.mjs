import net from 'node:net';

// Query the local polling owner without loading credentials.
// S8_TELEGRAM_OWNER_PORT는 테스트가 실제 게이트웨이와 격리되도록 재정의할 수 있는 포트다.
export async function telegramOwner({ port = Number(process.env.S8_TELEGRAM_OWNER_PORT) || 39485 } = {}) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000, () => finish(null));
    socket.on('connect', () => socket.write('status'));
    socket.on('data', chunk => { data += chunk; if (data.length > 4096) finish(null); });
    socket.on('end', () => {
      try { const value = JSON.parse(data); finish(typeof value.session === 'string' ? value.session : null); }
      catch { finish(null); }
    });
    socket.on('error', () => finish(null));
  });
}
