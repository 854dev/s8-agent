import net from 'node:net';

// Query the local polling owner without loading credentials.
export async function telegramOwner({ port = 39485 } = {}) {
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
