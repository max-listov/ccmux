import { once } from "node:events";
import { createCli } from "stitchkit/cli";
import { createControlClient, createControlProxy } from "../control/client.ts";
import { VERSION } from "../util/version.ts";

export async function cmdControl(args: string[]): Promise<number> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  process.stdout.on("error", abort);
  try {
    const options = {
      ...(process.env.CCMUX_SESSION ? { session: process.env.CCMUX_SESSION } : {}),
      ...(process.env.CCMUX_CHAT_CREDENTIAL ? { credential: process.env.CCMUX_CHAT_CREDENTIAL } : {}),
    };
    if ((args[0] === "watch" || args[0] === "watch-external") && args.length === 1) {
      const client = createControlClient(options);
      try {
        const stream = args[0] === "watch-external"
          ? await client.watchExternal.withOptions({ signal: controller.signal })
          : await client.watch.withOptions({ signal: controller.signal });
        for await (const snapshot of stream) {
          if (!process.stdout.write(`${JSON.stringify(snapshot)}\n`)) await once(process.stdout, "drain", { signal: controller.signal });
        }
      } finally { await client.close(); }
      return 0;
    }
    let code = 0;
    const proxy = createControlProxy(options);
    try {
      await createCli({ name: "ccmux control", version: VERSION, argv: args,
        services: [proxy], signal: controller.signal,
        stdin: async () => null, exit: (value) => { code = value; } });
    } finally { await proxy.close(); }
    return code;
  } catch (error) {
    if (controller.signal.aborted) return 0;
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    process.stdout.off("error", abort);
  }
}
