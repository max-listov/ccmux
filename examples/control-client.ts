import { createControlClient } from 'ccmux/control-client';

/** Mutating example: call only after choosing a real local workspace and stable request UUID. */
export async function createAndWatch(workspace: string, requestId: string, signal: AbortSignal) {
  const client = createControlClient();
  try {
    const created = await client.create({ requestId, name: 'worker', workspace, flags: [] });
    const baseline = await client.native({ target: created.target, cursor: null });
    const stream = await client.watchNative.withOptions(
      {
        target: created.target,
        cursor: { generation: baseline.generation, sequence: baseline.sequence },
      },
      { signal },
    );
    return { client, created, baseline, stream };
  } catch (error) {
    await client.close();
    throw error;
  }
}
