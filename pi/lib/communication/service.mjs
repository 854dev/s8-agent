// Message relay only. Agent sessions own their client connections.
import { startCommunicationServer } from './server.mjs';
import { listenLocal, localRequest } from './local.mjs';

export async function runCommunicator(root, config, { log = () => {} } = {}) {
  const server = await startCommunicationServer(config, { onMessage: input => localRequest(root, 'pi:manager', input), onEvent: log });
  let closeLocal;
  try {
    closeLocal = await listenLocal(root, 'communicator', async input => {
      if (input.action === 'peers') return { state: 'accepted', peers: server.peers() };
      if (input.action !== 'send') return { state: 'rejected' };
      return server.request(input.workerId, input.type, input.payload, input.context);
    });
  } catch (error) { await server.close(); throw error; }
  return async () => { await closeLocal(); await server.close(); };
}
