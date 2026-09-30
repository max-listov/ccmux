import { lstatSync } from 'node:fs';
import { subagentsDir } from '../agent/claude/subagent.ts';
import { providerFor } from '../agent/index.ts';
import { transcriptIndexPath } from '../agent/transcript/transcriptIndex.ts';
import { withExternalTranscript } from '../external/transcript.ts';
import type { MachineConfig, Session } from '../types.ts';
import { liveUsagePath } from './paths.ts';
import type { UsageSummary } from './schema.ts';

function stamp(path: string, source = true): string | null {
  try {
    const stat = lstatSync(path);
    return JSON.stringify([
      path,
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeMs,
      ...(source ? [stat.ctimeMs] : []),
      stat.mode,
      stat.uid,
    ]);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'missing';
    return null;
  }
}

function databaseStamp(path: string): (string | null)[] {
  return [stamp(path, false), stamp(`${path}-wal`, false), stamp(`${path}-shm`, false)];
}

function snapshot(machine: MachineConfig, session: Session) {
  const path = providerFor(session).historyFile(session, machine);
  if (!path) return null;
  const source = [
    JSON.stringify([machine, session]),
    stamp(path),
    ...(session.agent === 'claude' ? [stamp(subagentsDir(path))] : []),
    ...databaseStamp(liveUsagePath(machine, session.uuid)),
  ];
  const index = databaseStamp(transcriptIndexPath(path));
  if ([...source, ...index].some((value) => value === null)) return null;
  return { source: JSON.stringify(source), index: JSON.stringify(index) };
}

/** Skip only successfully prepared, unchanged sources. Queries always bypass this gate. */
export class UsagePreparation {
  private readonly prepared = new Map<string, { source: string; index: string }>();

  retain(addresses: string[]) {
    const present = new Set(addresses);
    for (const address of this.prepared.keys())
      if (!present.has(address)) this.prepared.delete(address);
  }

  inspect(machine: MachineConfig, session: Session, address: string) {
    return this.work(address, () => snapshot(machine, session));
  }

  async inspectExternal(
    machine: MachineConfig,
    threadId: string,
    address: string,
    signal: AbortSignal,
    inventory: Session[],
  ) {
    // Run the canonical root, permission, identity and managed-ownership checks on every pass.
    // Only SQLite preparation is skipped; a remembered path never authorizes an external read.
    const result = await withExternalTranscript(
      machine,
      { provider: 'codex', threadId },
      (path) =>
        this.work(address, () => {
          const source = [JSON.stringify([machine, threadId]), stamp(path)];
          const index = databaseStamp(transcriptIndexPath(path));
          if ([...source, ...index].some((value) => value === null)) return null;
          return { source: JSON.stringify(source), index: JSON.stringify(index) };
        }),
      signal,
      inventory,
    );
    if (result.source === 'readable') return result.value;
    this.prepared.delete(address);
    return null;
  }

  private work(address: string, read: () => { source: string; index: string } | null) {
    const next = read();
    const prior = this.prepared.get(address);
    return {
      needed: !next || !prior || next.source !== prior.source || next.index !== prior.index,
      complete: (result: UsageSummary) => {
        // Index writes are expected. Source changes during preparation require a new pass.
        const after = read();
        const caughtUpPartial =
          result.state === 'building' &&
          result.reason === 'index-pending' &&
          result.source === 'readable' &&
          result.indexedBytes === result.sourceBytes;
        if (
          (result.state === 'ready' || caughtUpPartial) &&
          result.reportedPipeline?.state !== 'building' &&
          next &&
          after &&
          next.source === after.source
        )
          this.prepared.set(address, after);
        else this.prepared.delete(address);
      },
    };
  }
}
