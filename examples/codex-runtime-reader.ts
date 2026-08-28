import { readCodexRuntime, codexRuntimeUpdates, type CodexRuntimeCursor } from "../src/codex-runtime-reader.ts";

const [session, threadId] = process.argv.slice(2);
if (session === undefined || threadId === undefined) throw new Error("usage: bun examples/codex-runtime-reader.ts <managed-name> <thread-uuid>");
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());
let cursor: CodexRuntimeCursor | undefined;
while (!stop.signal.aborted) {
  const result = await readCodexRuntime({ session, threadId, signal: stop.signal, timeoutMs: 250 });
  const delta = codexRuntimeUpdates(result, cursor);
  cursor = delta.cursor ?? undefined;
  console.log(JSON.stringify(delta));
  if (!stop.signal.aborted) await Bun.sleep(500);
}
