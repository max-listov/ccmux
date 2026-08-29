#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { parseNDJSON } from "stitchkit";
import { loadMachineConfig } from "../src/config/machine.ts";
import { createControlClient } from "../src/control/client.ts";
import { controlSocket } from "../src/control/path.ts";
import {
  CCMUX_CONTROL_SERVICE_PREFIX,
  ControlServiceOperationSchema,
  createCcmuxControlServiceClient,
} from "../src/control/serviceDescriptor.ts";
import {
  createCcmuxNativeStreamProfile,
  ControlNativeStreamFrameSchema,
  type ControlNativeStreamRequest,
} from "../src/control/nativeStreamContract.ts";
import type { ManagedPeer } from "../src/types.ts";

const workspace = Bun.argv[2];
if (!workspace?.startsWith("/"))
  throw new Error("usage: bun scripts/control-service-acceptance.ts <absolute-workspace> [ccmux-bin]");
const resolvedExecutable = Bun.argv[3] ?? Bun.which("ccmux");
if (!resolvedExecutable) throw new Error("installed ccmux executable was not found");
const executable = resolvedExecutable;

const machine = loadMachineConfig();
const socket = controlSocket(machine);
const local = createControlClient({ socket });
const remote = createCcmuxControlServiceClient(async (url, init) => {
  const route = new URL(String(url));
  const operation = ControlServiceOperationSchema.parse(
    route.pathname.slice(CCMUX_CONTROL_SERVICE_PREFIX.length + 1),
  );
  return fetch("http://ccmux.local/ccmux-control/v1/invoke", {
    unix: socket,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      v: 1,
      id: crypto.randomUUID(),
      caller: machine.rcPrefix,
      service: "ccmux.control",
      revision: "1",
      operation,
      payload: typeof init?.body === "string" ? init.body : "{}",
    }),
  });
});

const hash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16);

async function oneStreamFrame(request: ControlNativeStreamRequest) {
  const profile = createCcmuxNativeStreamProfile(executable);
  const command = profile.bin.endsWith(".ts")
    ? [process.execPath, "--no-env-file", profile.bin, ...profile.argv]
    : [profile.bin, ...profile.argv];
  const child = Bun.spawn(command, {
    stdin: new TextEncoder().encode(JSON.stringify(request)),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...profile.env.set },
  });
  const frames = parseNDJSON<unknown>(new Response(child.stdout), {
    maxLineBytes: 2 * 1024 * 1024,
  })[Symbol.asyncIterator]();
  try {
    const next = await Promise.race([
      frames.next(),
      Bun.sleep(10_000).then(() => {
        throw new Error("native stream frame deadline exceeded");
      }),
    ]);
    if (next.done) throw new Error(`native stream ended before a frame: ${await new Response(child.stderr).text()}`);
    return ControlNativeStreamFrameSchema.parse(next.value);
  } finally {
    child.kill("SIGTERM");
    const code = await child.exited;
    // The packaged executable drains SIGTERM to exit 0. A source .ts profile
    // has one extra Bun launcher, which reports the same deliberate signal as 1.
    if (code !== 0 && !(profile.bin.endsWith(".ts") && code === 1))
      throw new Error(`native stream cancellation exited ${code}`);
  }
}

let target: ManagedPeer | null = null;
let archived = false;
try {
  const requestId = crypto.randomUUID();
  const name = `service-probe-${crypto.randomUUID().slice(0, 8)}`;
  // Keep the real acceptance lane independent from account-level model-switch
  // notices: this is still the ordinary no-recipe create path.
  const flags = ["-m", "gpt-5.6-luna"];
  const created = await remote.create({ requestId, name, workspace, flags });
  target = created.target;
  const retried = await remote.create({ requestId, name, workspace, flags });
  const localRetry = await local.create({ requestId, name, workspace, flags });
  if (
    created.duplicate ||
    !retried.duplicate ||
    !localRetry.duplicate ||
    JSON.stringify(created.target) !== JSON.stringify(retried.target) ||
    JSON.stringify(created.target) !== JSON.stringify(localRetry.target)
  )
    throw new Error("create receipt did not reconcile one managed identity");

  const preparedDeadline = Date.now() + 15_000;
  let localRow: Awaited<ReturnType<typeof local.get>> | null = null;
  let serviceRow: Awaited<ReturnType<typeof remote.get>> | null = null;
  while ((localRow === null || serviceRow === null) && Date.now() < preparedDeadline) {
    try {
      [localRow, serviceRow] = await Promise.all([
        local.get({ target }),
        remote.get({ target }),
      ]);
    } catch {
      await Bun.sleep(250);
    }
  }
  if (localRow === null || serviceRow === null)
    throw new Error("created session did not enter the prepared observation");
  if (JSON.stringify(localRow) !== JSON.stringify(serviceRow))
    throw new Error("local and declared-service reads diverged");

  const messageId = crypto.randomUUID();
  const accepted = await remote.message({
    target,
    messageId,
    body: "Reply exactly with CCMUX_SERVICE_READY and nothing else.",
    defer: false,
    task: "service-acceptance",
  });
  if (!accepted.accepted || accepted.duplicate) throw new Error("message was not accepted once");

  const deadline = Date.now() + 120_000;
  let waitOutcome = "timeout";
  let native = await remote.native({ target, cursor: null });
  let responseSeen = native.items.some(
    (item) => item.kind === "assistant" && item.text?.includes("CCMUX_SERVICE_READY"),
  );
  while (!responseSeen && Date.now() < deadline) {
    const waited = await remote.wait({ target, timeoutMs: 25_000 });
    waitOutcome = waited.outcome;
    native = await remote.native({ target, cursor: null });
    responseSeen = native.items.some(
      (item) => item.kind === "assistant" && item.text?.includes("CCMUX_SERVICE_READY"),
    );
  }
  if (!responseSeen) throw new Error("managed session did not produce the exact acceptance reply");

  const initial = await oneStreamFrame({ target, cursor: null });
  const initialData = JSON.parse(initial.data);
  const resumed = await oneStreamFrame({ target, cursor: initial.cursor });
  const resumedData = JSON.parse(resumed.data);
  if (initialData.reset !== "initial" || resumedData.reset !== null || resumedData.items.length !== 0)
    throw new Error("native stream resume did not preserve cursor semantics");

  const archive = await remote.archive({ target });
  archived = archive.archived;
  const snapshot = await local.list();
  console.log(
    JSON.stringify({
      ok: true,
      version: snapshot.version,
      targetHash: hash(`${target.machine}:${target.session}:${target.threadId}`),
      create: { firstDuplicate: created.duplicate, retryDuplicate: retried.duplicate, writerIdentityStable: true },
      serviceReadMatchesLocal: true,
      messageAccepted: accepted.accepted,
      waitOutcome,
      responseSeen,
      native: {
        generationHash: hash(native.generation),
        sequence: native.sequence,
        pending: native.pending.length,
      },
      stream: {
        initialReset: initialData.reset,
        resumedReset: resumedData.reset,
        resumedItems: resumedData.items.length,
        cursorStable: initial.cursor === resumed.cursor,
      },
      archived,
    }),
  );
} finally {
  if (target !== null && !archived) await remote.archive({ target }).catch(() => {});
  await local.close();
}
