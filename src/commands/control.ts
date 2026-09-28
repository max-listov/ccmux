import { createControlClient, createControlProxy } from '../control/transport/client.ts';
import { createExternalStatusEncoder } from '../external/residentFrames.ts';
import { writeOut } from '../util/stdout.ts';
import { VERSION } from '../util/version.ts';

export async function cmdControl(args: string[]): Promise<number> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  process.stdout.on('error', abort);
  try {
    const options = {
      ...(process.env.CCMUX_SESSION ? { session: process.env.CCMUX_SESSION } : {}),
      ...(process.env.CCMUX_CHAT_CREDENTIAL
        ? { credential: process.env.CCMUX_CHAT_CREDENTIAL }
        : {}),
    };
    if (args[0] === 'watch' && args.length === 1) {
      const client = createControlClient(options);
      try {
        const stream = await client.watch.withOptions({ signal: controller.signal });
        for await (const snapshot of stream) {
          // A reader that left ends the watch instead of leaving it to feed a closed pipe.
          if (!(await writeOut(`${JSON.stringify(snapshot)}\n`))) break;
        }
      } finally {
        await client.close();
      }
      return 0;
    }
    if (args[0] === 'watch-external' && args.length === 1) {
      const client = createControlClient(options);
      try {
        const stream = await client.watchExternal.withOptions({ signal: controller.signal });
        // Frames, not snapshots: the whole snapshot first and on every change, a renewal of its
        // times in between (`external/residentFrames.ts`).
        const encode = createExternalStatusEncoder();
        for await (const snapshot of stream) {
          if (!(await writeOut(`${JSON.stringify(encode(snapshot))}\n`))) break;
        }
      } finally {
        await client.close();
      }
      return 0;
    }
    let code = 0;
    const proxy = createControlProxy(options);
    try {
      // Loaded here rather than at module load: every verb in this binary shares one module graph,
      // and a CLI framework nobody in that invocation calls is startup work for `list` and `send`
      // alike. It arrived as a fix — loading it used to switch this process's stdout to a stream
      // that dropped large answers past 64 KiB — and the owner has since fixed that at the root, so
      // what remains is the ordinary reason to keep a lazy import lazy.
      const { createCli } = await import('stitchkit/cli');
      await createCli({
        name: 'ccmux control',
        version: VERSION,
        argv: args,
        services: [proxy],
        signal: controller.signal,
        stdin: async () => null,
        exit: (value) => {
          code = value;
        },
      });
    } finally {
      await proxy.close();
    }
    return code;
  } catch (error) {
    if (controller.signal.aborted) return 0;
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
    process.stdout.off('error', abort);
  }
}
