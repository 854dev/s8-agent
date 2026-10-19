export const protocolVersion = 1;
export const maxBodyBytes = 16 * 1024 * 1024;
export const maxArtifactBytes = 64 * 1024 * 1024;
export const defaultPollMs = 20_000;
export const resultArtifacts = new Set(['worker-result.json', 'worker-failure.json', 'task.patch', 'changes.patch', 'developer.events.jsonl']);

export const workerStateIsFresh = state => state?.connected === true && Number.isFinite(Date.parse(state.lastSeenAt)) && Date.now() - Date.parse(state.lastSeenAt) < 15000;
