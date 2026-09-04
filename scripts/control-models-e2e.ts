#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMachineConfig } from '../src/config/machine.ts';
import { loadSessions } from '../src/config/sessions.ts';
import { createControlClient } from '../src/control/client.ts';
import { controlSocket } from '../src/control/path.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import { createControlServer } from '../src/control/server.ts';
import { MonitoringPublisher } from '../src/monitoring/publish.ts';

/** Real native catalog with an empty registry: no placeholder conversation or machine socket. */
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), 'ccmux-models-probe-'));
const m = { ...loadMachineConfig(), stateDir: join(root, 'state'), rcPrefix: 'probe' };
const monitoring = new MonitoringPublisher();
const publisher = new ControlPublisher(m);
let client: ReturnType<typeof createControlClient> | undefined;
let owned: ReturnType<typeof createControlServer> | undefined;
try {
  monitoring.begin(m);
  publisher.publish(m, await monitoring.publish(m));
  owned = createControlServer(m, publisher);
  client = createControlClient({ socket: controlSocket(m) });
  check(loadSessions(m).length === 0, 'Registry is not empty before discovery');
  const first = await client['model.list']({ runtime: 'codex', limit: 2 });
  check(
    first.target === undefined && first.source.kind === 'host' && first.source.runtime === 'codex',
    'Host catalog invented a target',
  );
  check(first.data.length === 2, `Expected a two-model first page, got ${first.data.length}`);
  check(
    typeof first.nextCursor === 'string' && first.nextCursor.length > 0,
    'Provider page did not continue',
  );
  const second = await client['model.list']({
    runtime: 'codex',
    cursor: first.nextCursor,
    limit: 2,
  });
  check(
    JSON.stringify(second.source) === JSON.stringify(first.source),
    'Runtime source changed between pages',
  );
  check(second.data.length === 2, 'Second page was empty');
  check(
    new Set([...first.data, ...second.data].map((model) => model.id)).size === 4,
    'Pagination repeated a model',
  );

  const full = await client['model.list']({});
  check(full.source.runtime === 'codex', 'Default runtime identity is absent');
  check(full.nextCursor === null, 'Full page still reported a continuation cursor');
  check(full.data.length >= 4, 'Full catalog smaller than its own pagination');
  const defaults = full.data.filter((model) => model.isDefault);
  check(defaults.length === 1, `Expected exactly one default model, got ${defaults.length}`);
  const safeKeys = [
    'id',
    'model',
    'displayName',
    'description',
    'hidden',
    'isDefault',
    'inputModalities',
    'serviceTiers',
    'supportedReasoningEfforts',
    'defaultReasoningEffort',
  ];
  check(
    full.data.every((model) => Object.keys(model).every((key) => safeKeys.includes(key))),
    'Unsafe provider fields crossed the boundary',
  );
  const hidden = await client['model.list']({ includeHidden: true });
  check(loadSessions(m).length === 0, 'Discovery created a managed conversation');
  check(hidden.data.length >= full.data.length, 'includeHidden returned fewer models');
  const wire = JSON.stringify(hidden);
  check(
    !wire.includes(root) && !wire.includes(homedir()) && !wire.includes('auth.json'),
    'Response leaked machine configuration',
  );

  console.log(
    JSON.stringify(
      {
        probe: 'control-models-e2e',
        connected: true,
        runtime: first.source.runtime,
        provider: first.source.provider,
        emptyRegistry: true,
        visibleModels: full.data.length,
        hiddenModels: hidden.data.length - full.data.length,
        defaultModel: defaults[0]?.id ?? null,
        paginatedRoundTrip: true,
        boundedSafeFieldsOnly: true,
        noMachineConfigurationInResponse: true,
      },
      null,
      2,
    ),
  );
} finally {
  await client?.close();
  await owned?.server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 100 });
  await owned?.observability.close();
  publisher.close();
  rmSync(root, { recursive: true, force: true });
}
