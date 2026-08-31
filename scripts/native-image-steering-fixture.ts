import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { encode } from 'jpeg-js';
import { PNG } from 'pngjs';
import { parseNDJSON } from 'stitchkit';
import { ATTACHMENT_LIMITS, type AttachmentReference } from '../src/attachments/reference.ts';
import { managedPeer } from '../src/chat/identity.ts';
import { loadMachineConfig } from '../src/config/machine.ts';
import { MachineConfigSchema } from '../src/config/schema.ts';
import { loadSessions } from '../src/config/sessions.ts';
import { ControlNativeStreamFrameSchema } from '../src/control/nativeStreamContract.ts';
import { controlSocket } from '../src/control/path.ts';
import type { ControlModel } from '../src/control/schema.ts';
import {
  CCMUX_CONTROL_SERVICE_INGRESS_PATH,
  CCMUX_CONTROL_SERVICE_PREFIX,
  CCMUX_CONTROL_SERVICE_REVISION,
  ControlServiceOperationSchema,
  createCcmuxControlServiceClient,
} from '../src/control/serviceDescriptor.ts';
import { readManagedRuntimeStatus } from '../src/runtime/status.ts';
import { killSession, listSessionNames } from '../src/tmux/tmux.ts';
import type { ManagedPeer } from '../src/types.ts';
import { atomicWrite } from '../src/util/atomic.ts';

export function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
let evidencePath: string | null = null;
export const report = (phase: string, evidence: unknown) => {
  const line = JSON.stringify({ phase, evidence });
  console.log(line);
  if (evidencePath !== null) appendFileSync(evidencePath, `${line}\n`, { mode: 0o600 });
};
export async function until(label: string, read: () => Promise<boolean>, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await read())) {
    check(Date.now() < deadline, `Deadline: ${label}`);
    await Bun.sleep(200);
  }
}
export async function refusal(call: () => Promise<unknown>, expected: string) {
  try {
    await call();
  } catch (error) {
    check(
      typeof error === 'object' && error !== null && 'code' in error && error.code === expected,
      `Expected ${expected}`,
    );
    return;
  }
  throw new Error(`Expected refusal ${expected}`);
}

/** Unlabelled colored geometry makes the expected answer depend on actual decoded pixels. */
export function geometryImage(format: 'png' | 'jpeg') {
  const image = new PNG({ width: 768, height: 384 });
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const left =
        format === 'png'
          ? (x - 192) ** 2 + (y - 192) ** 2 < 110 ** 2
          : y > 70 && y < 304 && Math.abs(x - 192) < (y - 70) / 1.15;
      const right =
        format === 'png'
          ? Math.abs(x - 576) < 110 && Math.abs(y - 192) < 110
          : (x - 576) ** 2 + (y - 192) ** 2 < 110 ** 2;
      const color = left
        ? format === 'png'
          ? [235, 20, 20]
          : [0, 180, 40]
        : right
          ? format === 'png'
            ? [20, 60, 240]
            : [245, 210, 0]
          : [255, 255, 255];
      const offset = (y * image.width + x) * 4;
      image.data[offset] = color[0] ?? 255;
      image.data[offset + 1] = color[1] ?? 255;
      image.data[offset + 2] = color[2] ?? 255;
      image.data[offset + 3] = 255;
    }
  return Buffer.from(format === 'png' ? PNG.sync.write(image) : encode(image, 95).data);
}
export function nearLimitImage(): Buffer {
  const image = new PNG({ width: 1540, height: 1540 });
  let seed = 71;
  for (let index = 0; index < image.data.length; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    image.data[index] = index % 4 === 3 ? 255 : seed >>> 24;
  }
  const bytes = Buffer.from(PNG.sync.write(image));
  check(
    bytes.length > 7 * 1024 * 1024 && bytes.length <= ATTACHMENT_LIMITS.imageBytes,
    'Near-limit fixture size invalid',
  );
  return bytes;
}

export async function nativeImageProbe(
  options: {
    cli?: string;
    makeClient?: typeof createCcmuxControlServiceClient;
    configure?: (root: string, machine: ReturnType<typeof loadMachineConfig>) => Promise<void>;
  } = {},
) {
  const root = realpathSync(mkdtempSync('/tmp/ccmux-image-steering-'));
  chmodSync(root, 0o700);
  evidencePath = join(root, 'evidence.ndjson');
  const config = join(root, 'machine.json'),
    cli = resolve(options.cli ?? 'src/cli.ts');
  const machine = MachineConfigSchema.parse({
    ...loadMachineConfig(),
    stateDir: join(root, 'state'),
    rcPrefix: 'probe',
    tmuxSocket: `ccmux-image-${crypto.randomUUID().slice(0, 8)}`,
    fleet: {},
    wire: { peers: [] },
    telegram: undefined,
    externalInventory: false,
    remoteControl: false,
    autoUpdate: false,
    extraFlags: [],
    chatEnabled: true,
    sessionEvents: true,
    codexCorrelationTimeoutMs: 45_000,
    launchRecipes: {
      native: {
        revision: '1',
        flags: ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'],
        environment: [],
        capabilities: ['input-requests'],
        collaborationMode: 'plan',
      },
    },
    applicationPolicies: {},
  });
  for (const runtime of ['codex', 'opencode']) mkdirSync(join(root, runtime));
  await atomicWrite(
    join(root, 'opencode', 'opencode.json'),
    JSON.stringify({ permission: { bash: 'ask' } }),
    0o600,
  );
  await options.configure?.(root, machine);
  await atomicWrite(config, JSON.stringify(machine), 0o600);
  const env: Record<string, string | undefined> = {
    ...process.env,
    CCMUX_CONFIG: config,
    CCMUX_STATE_DIR: machine.stateDir,
    CCMUX_CACHE_DIR: join(root, 'cache'),
    CCMUX_DATA_DIR: join(root, 'data'),
  };
  for (const key of [
    'CCMUX_SESSION',
    'CCMUX_CHAT_CREDENTIAL',
    'CODEX_THREAD_ID',
    'CODEX_APP_TOOLS_PIPE_PATH',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  ])
    delete env[key];
  const spawn = () =>
    Bun.spawn([process.execPath, '--no-env-file', cli, 'daemon'], {
      env,
      stdin: 'ignore',
      stdout: Bun.file(join(root, 'daemon.log')),
      stderr: Bun.file(join(root, 'daemon-error.log')),
    });
  let daemon = spawn();
  const client = (caller: string) =>
    (options.makeClient ?? createCcmuxControlServiceClient)(async (url, init) => {
      const operation = ControlServiceOperationSchema.parse(
        new URL(String(url)).pathname.slice(CCMUX_CONTROL_SERVICE_PREFIX.length + 1),
      );
      return fetch(`http://ccmux.local${CCMUX_CONTROL_SERVICE_INGRESS_PATH}`, {
        unix: controlSocket(machine),
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(init?.signal ? { signal: init.signal } : {}),
        body: JSON.stringify({
          v: 1,
          id: crypto.randomUUID(),
          caller,
          service: 'ccmux.control',
          revision: CCMUX_CONTROL_SERVICE_REVISION,
          operation,
          payload: typeof init?.body === 'string' ? init.body : '{}',
        }),
      });
    });
  const service = client('probe-client');
  const ready = () =>
    until(
      'isolated service',
      async () => {
        try {
          await service.runtimes({});
          return true;
        } catch {
          return false;
        }
      },
      20_000,
    );
  await ready();
  check(loadSessions(machine).length === 0, 'Isolated registry is not empty');
  return {
    root,
    cli,
    env,
    machine,
    service,
    client,
    async restartDaemon() {
      const pid = daemon.pid;
      daemon.kill('SIGTERM');
      const code = await daemon.exited;
      daemon = spawn();
      await ready();
      return { pid, code };
    },
    async cleanup() {
      const sessions = loadSessions(machine),
        pids = new Set([daemon.pid]);
      for (const session of sessions) {
        const snapshot = readManagedRuntimeStatus(machine, session).snapshot;
        if (snapshot) {
          pids.add(snapshot.pid);
          if (snapshot.providerPid !== undefined) pids.add(snapshot.providerPid);
        }
      }
      let archiveFailures = 0;
      try {
        for (const session of sessions) {
          try {
            await service.archive({ target: managedPeer(machine.rcPrefix, session) });
          } catch {
            archiveFailures++;
          }
        }
      } finally {
        daemon.kill('SIGTERM');
        await daemon.exited;
        for (const name of await listSessionNames(machine)) await killSession(machine, name);
      }
      await until(
        'all isolated processes exited',
        async () =>
          [...pids].every((pid) => {
            try {
              process.kill(pid, 0);
              return false;
            } catch {
              return true;
            }
          }),
        15_000,
      );
      check(
        (await listSessionNames(machine)).size === 0,
        'Isolated tmux sessions survived cleanup',
      );
      report('cleanup', {
        archived: sessions.length - archiveFailures,
        archiveFailures,
        trackedProcesses: pids.size,
        allExited: true,
      });
    },
  };
}
export type NativeImageProbe = Awaited<ReturnType<typeof nativeImageProbe>>;

export async function uploadImage(
  p: NativeImageProbe,
  target: ManagedPeer,
  bytes: Buffer,
  mediaType: 'image/png' | 'image/jpeg',
) {
  const selector = { target, uploadId: crypto.randomUUID() };
  const request = { ...selector, mediaType, totalBytes: bytes.length, digest: sha(bytes) };
  await p.service.attachmentBegin(request);
  await p.service.attachmentBegin(request);
  for (let offset = 0; offset < bytes.length; offset += ATTACHMENT_LIMITS.chunkBytes)
    await p.service.attachmentChunk({
      ...selector,
      offset,
      data: bytes.subarray(offset, offset + ATTACHMENT_LIMITS.chunkBytes).toString('base64'),
    });
  const reference = await p.service.attachmentFinalize(selector);
  check(
    (await p.service.attachmentFinalize(selector)).digest === reference.digest,
    'Finalize identity changed',
  );
  await previewImage(p, target, reference, bytes);
  return reference;
}
export async function previewImage(
  p: NativeImageProbe,
  target: ManagedPeer,
  reference: AttachmentReference,
  expected: Buffer,
) {
  const chunks: Buffer[] = [];
  let offset = 0;
  do {
    const chunk = await p.service.attachmentRead({ target, reference, offset });
    chunks.push(Buffer.from(chunk.data, 'base64'));
    offset = chunk.nextOffset;
    if (chunk.complete) break;
  } while (offset < reference.bytes);
  check(Buffer.concat(chunks).equals(expected), 'Preview bytes changed');
}
export async function modelCatalog(
  p: NativeImageProbe,
  runtime: 'codex' | 'opencode',
  target?: ManagedPeer,
) {
  const rows: ControlModel[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 64; page++) {
    const result = await p.service.models({ runtime, ...(target ? { target } : {}), cursor });
    rows.push(...result.data);
    cursor = result.nextCursor;
    if (cursor === null) return rows;
  }
  throw new Error('Native catalog exceeds acceptance bound');
}
export async function streamFrame(p: NativeImageProbe, target: ManagedPeer) {
  const child = Bun.spawn([process.execPath, '--no-env-file', p.cli, 'control-native-stream'], {
    env: p.env,
    stdin: Buffer.from(JSON.stringify({ target, cursor: null })),
    stdout: 'pipe',
    stderr: Bun.file(join(p.root, 'stream-error.log')),
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    for await (const raw of parseNDJSON<unknown>(new Response(child.stdout), {
      maxLineBytes: 600 * 1024,
    }))
      return ControlNativeStreamFrameSchema.parse(raw);
    throw new Error('Native stream did not produce a frame');
  } finally {
    clearTimeout(timer);
    child.kill('SIGTERM');
    await child.exited;
  }
}
