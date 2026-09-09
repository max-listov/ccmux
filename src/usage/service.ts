import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { AppError } from 'stitchkit';
import { subagentFile, subagentsDir } from '../agent/claude/subagent.ts';
import { providerFor } from '../agent/index.ts';
import { codexAppThreadId, isCodexAppToken } from '../chat/identity.ts';
import { findSession, loadSessions } from '../config/sessions.ts';
import { routeFor } from '../fleet/address.ts';
import type { MachineConfig } from '../types.ts';
import { log } from '../util/log.ts';
import { aggregateUsage, nextPage, pageOffset, queryKey } from './aggregate.ts';
import { readExternalUsage } from './external.ts';
import { readUsageFile, unavailableUsage } from './file.ts';
import { liveUsagePath } from './paths.ts';
import { partialUsage } from './quality.ts';
import { finishUsageIndex, requestUsageIndex } from './queue.ts';
import {
  USAGE_MAX_BYTES,
  type UsageQuery,
  type UsageSummary,
  UsageSummarySchema,
} from './schema.ts';
import { UsageStore } from './store.ts';

export async function readSessionUsage(
  m: MachineConfig,
  address: string,
  query: UsageQuery,
  advance = false,
  signal?: AbortSignal,
): Promise<UsageSummary> {
  signal?.throwIfAborted();
  const route = routeFor(address, m);
  if (route.kind !== 'local')
    throw new AppError('INVALID_TARGET', 'Usage control requires an exact local address', 400);
  const exact = `${m.rcPrefix}:${route.session}`;
  try {
    const result = UsageSummarySchema.parse(
      await readLocalUsage(m, route.session, exact, query, advance, signal),
    );
    result.timezone = query.timezone;
    const token = route.session.split('#')[0] ?? route.session;
    if (isCodexAppToken(token)) result.identity.nativeSessionId = codexAppThreadId(token);
    else {
      const session = findSession(loadSessions(m), token);
      if (session)
        result.identity = {
          sessionId: session.uuid,
          nativeSessionId: route.session.split('#')[1] ?? session.nativeSession?.id ?? session.uuid,
        };
    }
    if (Buffer.byteLength(JSON.stringify(result)) > USAGE_MAX_BYTES - 4096)
      throw new Error('Usage response byte budget exceeded');
    if (result.state === 'building') requestUsageIndex(m.stateDir, exact);
    else finishUsageIndex(m.stateDir, exact);
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    log.warn({ msg: 'session usage unavailable', err: String(error) });
    const result = unavailableUsage(exact, 'unknown', 'unreadable', 'accounting-unavailable');
    result.state = 'failed';
    result.timezone = query.timezone;
    return result;
  }
}

async function readLocalUsage(
  m: MachineConfig,
  token: string,
  exact: string,
  query: UsageQuery,
  advance: boolean,
  signal?: AbortSignal,
): Promise<UsageSummary> {
  const child = token.match(/^(.+)#([0-9a-f]{1,64})$/);
  const name = child?.[1] ?? token;
  if (isCodexAppToken(name)) {
    if (child) return unavailableUsage(exact, 'codex', 'unsupported', 'child-history-unsupported');
    const result = await readExternalUsage(
      m,
      codexAppThreadId(name),
      exact,
      query,
      advance,
      signal,
    );
    return result;
  }
  const session = findSession(loadSessions(m), name);
  if (!session) return unavailableUsage(exact, 'unknown', 'missing', 'session-missing');
  if (child && session.agent !== 'claude')
    return unavailableUsage(exact, session.agent, 'unsupported', 'child-history-unsupported');
  const path = providerFor(session).historyFile(session, m);
  if (path) {
    if (child?.[2]) {
      const childPath = session.agent === 'claude' ? subagentFile(path, child[2]) : null;
      if (!childPath)
        return unavailableUsage(exact, session.agent, 'unsupported', 'child-history-unsupported');
      const summary = readUsageFile(exact, childPath, session.agent, query, advance);
      return summary;
    }
    const summary = readUsageFile(exact, path, session.agent, query, advance);
    if (session.agent === 'claude' && existsSync(subagentsDir(path))) {
      const children = readdirSync(subagentsDir(path)).filter((f) =>
        /^agent-[0-9a-f]{1,64}\.jsonl$/.test(f),
      );
      summary.delegated = {
        coverage: 'partial',
        addresses: children.slice(0, 100).map((f) => `${exact}#${f.slice(6, -6)}`),
      };
      for (const address of summary.delegated.addresses) requestUsageIndex(m.stateDir, address);
    }
    const live = liveUsagePath(m, session.uuid);
    if (session.agent === 'claude' && existsSync(live)) {
      const store = new UsageStore(live);
      try {
        const aggregate = aggregateUsage(store, { ...query, cursor: query.pipelineCursor });
        for (const row of [aggregate.self, aggregate.unattributed, ...aggregate.buckets])
          partialUsage(row);
        summary.reportedPipeline = {
          scope: 'query-pipeline-inclusive',
          sourceEventRange: aggregate.sourceEventRange,
          usage: aggregate.self,
          state: aggregate.building ? 'building' : 'ready',
          reset: aggregate.reset,
          unattributed: aggregate.unattributed,
          buckets: aggregate.buckets,
          nextCursor: aggregate.nextCursor,
        };
      } finally {
        store.close();
      }
    }
    return summary;
  }
  const database = liveUsagePath(m, session.uuid);
  const summary = unavailableUsage(
    exact,
    session.agent,
    'unsupported',
    'historical-backfill-unsupported',
  );
  summary.history = 'observed-live';
  summary.timezone = query.timezone;
  if (!existsSync(database)) return summary;
  const store = new UsageStore(database);
  try {
    const { ambiguous: _ambiguous, building, ...aggregate } = aggregateUsage(store, query);
    for (const row of [aggregate.self, aggregate.unattributed, ...aggregate.buckets])
      partialUsage(row);
    return { ...summary, ...aggregate, state: building ? 'building' : summary.state };
  } finally {
    store.close();
  }
}

export async function listSessionUsage(
  m: MachineConfig,
  query: UsageQuery,
  cursor: string | null,
  limit: number,
  external: string[] = [],
  signal?: AbortSignal,
) {
  const sessions = loadSessions(m);
  const nativeIds = new Set(sessions.filter((s) => s.agent === 'codex').map((s) => s.uuid));
  const addresses = [
    ...new Set([
      ...sessions.map((s) => `${m.rcPrefix}:${s.name}`),
      ...external.filter((id) => !nativeIds.has(id)).map((id) => `${m.rcPrefix}:app/${id}`),
    ]),
  ].sort();
  const revision = createHash('sha256').update(JSON.stringify(addresses)).digest('hex');
  const key = queryKey(query, m.rcPrefix);
  const offset = pageOffset(cursor, key, revision);
  const start = offset ?? 0;
  const selected = addresses.slice(start, start + limit);
  const data: UsageSummary[] = [];
  let bytes = 4096;
  for (const address of selected) {
    const row = await readSessionUsage(m, address, query, false, signal);
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes + size > USAGE_MAX_BYTES) break;
    data.push(row);
    bytes += size;
  }
  return {
    machine: m.rcPrefix,
    data,
    reset: offset === null,
    nextCursor:
      start + data.length < addresses.length ? nextPage(start + data.length, key, revision) : null,
  };
}
