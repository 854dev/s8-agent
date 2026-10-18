import os from 'node:os';
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

export async function loadModelRuntime({ authPath, provider = 'openai-codex', modelId } = {}) {
  const runtime = await ModelRuntime.create({ authPath: authPath ?? path.join(os.homedir(), '.pi/agent/auth.json'), modelsPath: null, allowModelNetwork: false });
  const available = await runtime.getAvailable(provider);
  const preferred = modelId ? runtime.getModel(provider, modelId) : available.find(model => model.id === 'gpt-6-sol') ?? available.find(model => model.id === 'gpt-5.4') ?? available[0];
  if (!preferred || !available.some(model => model.id === preferred.id)) throw new Error('No authenticated model available for the selected provider');
  return { runtime, model: preferred };
}
