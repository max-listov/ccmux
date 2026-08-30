import { loadMachineConfig } from '../src/config/machine.ts';
import { inspectCodexThreadLock } from '../src/external/codexLocks.ts';
import { ExternalContentTargetSchema } from '../src/external/contentSchema.ts';
import { check, nativeImageProbe, report, sha } from './native-image-steering-fixture.ts';

const cli = process.argv[2];
const threadId = process.argv[3];
if (!cli || !threadId)
  throw new Error('Pass built CLI and an existing live external Codex identity');
const host = loadMachineConfig();
const target = ExternalContentTargetSchema.parse({
  provider: 'codex',
  machine: host.rcPrefix,
  threadId,
});
const before = inspectCodexThreadLock(host, threadId);
check(
  before.evidence === 'observed' && before.holders.length === 1,
  'Exact live writer is required',
);
const p = await nativeImageProbe({
  cli,
  configure: async (_root, machine) => {
    machine.externalInventory = true;
    machine.rcPrefix = host.rcPrefix;
  },
});
try {
  const capabilities = await p.service.externalCapabilities({ target });
  const page = await p.service.externalHistory({ target, limit: 16 });
  check(
    page.outcome === 'available' && page.entries.length > 0,
    'Existing external history is unavailable',
  );
  check(JSON.stringify(page.target) === JSON.stringify(target), 'External identity changed');
  check(
    Object.values(capabilities.control).every((op) => !op.supported),
    'Read granted writer authority',
  );
  const after = inspectCodexThreadLock(host, threadId);
  check(
    after.evidence === 'observed' &&
      JSON.stringify(after.holders) === JSON.stringify(before.holders),
    'External writer changed',
  );
  report('external-content-live-pass', {
    identityDigest: sha(JSON.stringify(target)),
    writerUnchanged: true,
    entries: page.entries.length,
    responseBytes: Buffer.byteLength(JSON.stringify(page)),
    revision: page.revision,
    olderCursor: page.nextCursor !== null,
    truncated: page.truncated,
    controlUnsupported: true,
  });
} finally {
  await p.cleanup();
}
