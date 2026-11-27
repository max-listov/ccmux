#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import compiler from 'typescript/package.json' with { type: 'json' };
import manifest from '../package.json' with { type: 'json' };
import { VERSION } from '../src/util/version.ts';
import { serveClientCandidate } from './client-consumer-registry.ts';
import { CLIENT_NAME, inspectClientArchive, NPM_REGISTRY } from './control-client-archive.ts';
import { packageClient } from './package-client.ts';

const directory = mkdtempSync('/tmp/stitchmux-packed-client-');
const packageDir = join(directory, 'package');
const consumer = join(directory, 'consumer');

async function run(command: string, args: string[]): Promise<void> {
  const child = Bun.spawn([command, ...args], {
    cwd: consumer,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(directory, 'cache') },
  });
  const code = await child.exited;
  if (code !== 0)
    throw new Error(`Installed consumer: ${command} ${args.join(' ')} exited ${code}`);
}

let candidate: ReturnType<typeof serveClientCandidate> | undefined;
try {
  const args = Bun.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--from-npm'))
    throw new Error('Usage: verify-client.ts [--from-npm]');
  if (!args.length) {
    const path =
      process.env.STITCHMUX_PACKED_CLIENT_ARTIFACT ?? (await packageClient(packageDir)).artifact;
    candidate = serveClientCandidate(await inspectClientArchive(resolve(path), VERSION));
  }
  mkdirSync(consumer, { recursive: true });
  await Bun.write(
    join(consumer, '.npmrc'),
    `registry=${NPM_REGISTRY}/\n@stitchmux:registry=${candidate?.url.origin ?? NPM_REGISTRY}/\n`,
  );
  await Bun.write(
    join(consumer, 'package.json'),
    `${JSON.stringify({
      name: 'stitchmux-packed-client-gate',
      private: true,
      type: 'module',
      dependencies: {
        [CLIENT_NAME]: VERSION,
        stitchkit: manifest.devDependencies.stitchkit,
        zod: manifest.dependencies.zod,
        '@stitchwire/client': manifest.dependencies['@stitchwire/client'],
      },
      devDependencies: { typescript: compiler.version },
    })}\n`,
  );
  await Bun.write(
    join(consumer, 'check.ts'),
    `import { controlContract, createControlClient, createExternalStatusEncoder, createInjectedControlClient, currentExternalStatus, ExternalStatusSnapshotSchema, FleetAnswerSchema, LogPayloadSchema, type OperationEffect, refusals, type UsageSummary } from '@stitchmux/client';
import { MonitoringSnapshotReadSchema, readMonitoringStatus } from '@stitchmux/client/monitoring';
import packageManifest from '@stitchmux/client/package.json' with { type: 'json' };
// One client: both transports and the refusal catalog come from the same entry point.
if (refusals.errors.NOT_FOUND === undefined) throw new Error('refusal catalog missing');
// The monitoring reader tolerates a snapshot row from a newer release.
const later = MonitoringSnapshotReadSchema.safeParse({ v: 1, rows: [{ state: 'from-the-future', agent: 'next' }] });
if (typeof readMonitoringStatus !== 'function') throw new Error('monitoring reader missing');
void later;
const offline = ExternalStatusSnapshotSchema.parse({
  protocol: 1, version: '1.0.0', machine: 'consumer', generation: '33333333-3333-4333-8333-333333333333', sequence: 0,
  source: 'codex-app-server', status: 'unavailable', reason: 'endpoint-absent', observedAt: null,
  expiresAt: null, truncated: false, omitted: 0, sessions: []
});
if (currentExternalStatus(offline).reason !== 'endpoint-absent' || createExternalStatusEncoder()(offline).frame !== 'snapshot')
  throw new Error('resident status contract failed');
if (FleetAnswerSchema.safeParse({}).success || LogPayloadSchema.safeParse({rows: 'invalid'}).success)
  throw new Error('resident schema accepted an invalid payload');
const resident = createControlClient({socket: '/unused-consumer-test.sock'});
const readStatus: () => Promise<typeof offline> = resident['external.list'];
if (typeof readStatus !== 'function') throw new Error('typed resident operation missing');
// A lifecycle operation declares its refusals: the published types narrow a refusal of session.sleep
// to the codes it declares, not to the whole catalog and not to any string.
type SleepRefusalCode = NonNullable<ReturnType<typeof resident['session.sleep']['refusal']>>['code'];
const declaredSleepRefusal: SleepRefusalCode = 'NOT_IDLE';
// @ts-expect-error A catalog code session.sleep does not declare must be rejected by the published types.
const wakeOnlyRefusal: SleepRefusalCode = 'WAKE_CAPACITY';
// @ts-expect-error A code outside the catalog must be rejected by the published types.
const unknownRefusal: SleepRefusalCode = 'NOT_A_REFUSAL';
if (resident['session.sleep'].refusal(new Error('not a refusal')) !== undefined)
  throw new Error('refusal() read a plain error as a refusal');
await resident.close();
const aggregate: UsageSummary['self'] = {
  values:{inputTokens:10,outputTokens:5,cacheReadTokens:null,cacheCreationTokens:null,reasoningTokens:null,totalTokens:null},
  measured:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheCreationTokens:0,reasoningTokens:0,totalTokens:0},
  fieldCoverage:{inputTokens:'full',outputTokens:'full',cacheReadTokens:'unknown',cacheCreationTokens:'unknown',reasoningTokens:'unknown',totalTokens:'unknown'},
  observations:1,coverage:'full',costs:[]
};
const summary: UsageSummary = {address:'host-a:agent-a',runtime:'claude',identity:{sessionId:null,nativeSessionId:null},additivity:'session-only',
  source:'readable',state:'ready',reason:null,revision:'1',observedAt:null,sourceEventRange:{first:null,last:null},indexedBytes:100,sourceBytes:100,
  malformedRecords:0,history:'native-history',self:aggregate,unattributed:aggregate,
  delegated:{coverage:'unknown',addresses:[]},reportedPipeline:null,buckets:[],timezone:'UTC',nextCursor:null,reset:false};
const client = createInjectedControlClient(async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname === '/control/usage') return Response.json(summary);
  if (url.pathname !== '/control/directories') throw new Error('canonical route lost');
  const body = JSON.parse(String(init?.body));
  return Response.json({path:body.path,parent:null,entries:[],nextCursor:null});
});
if (!controlContract.endpoints['directory.list']) throw new Error('canonical contract missing');
const result = await client['directory.list']({path:'/tmp'});
if (result.path !== '/tmp' || result.entries.length !== 0) throw new Error('typed client failed');
let retryProbeCalls = 0;
const failingClient = createInjectedControlClient(async () => {
  retryProbeCalls += 1;
  throw new Error('simulated wire timeout');
}, 5_000);
let failed = false;
try { await failingClient['directory.list']({}); } catch { failed = true; }
if (!failed || retryProbeCalls !== 1) throw new Error(\`injected client retried: \${retryProbeCalls}\`);
if (!controlContract.endpoints['usage.read'] || !controlContract.endpoints['usage.list']) throw new Error('usage contract missing');
const usage = await client['usage.read']({address:'host-a:agent-a'});
if (usage.self.values.inputTokens !== 10 || usage.self.values.outputTokens !== 5) throw new Error('typed usage lost');
// Each operation's effect travels with the contract the package exports.
const stop: OperationEffect = controlContract.endpoints['session.stop'].effect;
if (stop !== 'write' || controlContract.endpoints['fleet.list'].effect !== 'read') throw new Error('operation effects lost');
// @ts-expect-error An unknown operation effect must be rejected by the published types.
const invalidEffect: OperationEffect = 'not-a-control-effect';
if (packageManifest.version !== ${JSON.stringify(VERSION)}) throw new Error('package version not readable');
`,
  );
  await run('bun', ['install', '--ignore-scripts']);
  if (candidate && candidate.downloads() === 0)
    throw new Error('Client archive was not downloaded');
  for (const [resolution, module] of [
    ['Bundler', 'ESNext'],
    ['NodeNext', 'NodeNext'],
  ] as const) {
    await run(join(consumer, 'node_modules/.bin/tsc'), [
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      'false',
      '--moduleResolution',
      resolution,
      '--module',
      module,
      '--target',
      'es2022',
      '--resolveJsonModule',
      'check.ts',
    ]);
  }
  await run('bun', ['check.ts']);
  await Bun.write(
    join(consumer, 'wire.ts'),
    `
import assert from 'node:assert/strict';
import { controlContract } from '@stitchmux/client';
import { serviceDescriptorFromContract } from '@stitchwire/client';
import { SERVICE_MAX_RESPONSE_BYTES } from '@stitchwire/client/contracts';
import { version } from '@stitchmux/client/package.json';
const endpoints = Object.entries(controlContract.endpoints);
const settings = {
  service: 'stitchmux.control', revision: version, maxInflight: 8,
  responseBytes: Object.fromEntries(endpoints.map(([id]) => [id, SERVICE_MAX_RESPONSE_BYTES])),
};
const descriptor = serviceDescriptorFromContract(controlContract, settings);
assert.deepEqual(
  Object.fromEntries(descriptor.operations.map(op => [op.id, op.effect])),
  Object.fromEntries(endpoints.map(([id, op]) => [id, op.effect])),
);
const invalid = {
  ...controlContract,
  endpoints: {
    ...controlContract.endpoints,
    'session.wake': {...controlContract.endpoints['session.wake'], timeout: 60000},
  },
};
assert.throws(
  () => serviceDescriptorFromContract(invalid, settings),
  error => error.issues?.some(issue => issue.path.at(-1) === 'timeoutMs'),
);
`,
  );
  await run('bun', ['wire.ts']);
  // The published code carries the version, not the source's package manifest.
  for (const file of new Bun.Glob('node_modules/@stitchmux/client/dist/*.js').scanSync(consumer)) {
    const body = await Bun.file(join(consumer, file)).text();
    if (body.includes('devDependencies') || body.includes('"scripts"'))
      throw new Error(`${file} embeds the source package manifest`);
    // A library never works out how the command line re-executes itself (`src/util/env.ts`).
    if (body.includes('resolveSelfArgv'))
      throw new Error(`${file} embeds the command line's self re-exec`);
  }
  // One build of both entries: a module both import is emitted once, in a shared chunk. Two builds
  // would put the version module, which both entries import, in each of them.
  const versionCopies = [
    ...new Bun.Glob('node_modules/@stitchmux/client/dist/*.js').scanSync(consumer),
  ]
    .map(
      (file) =>
        readFileSync(join(consumer, file), 'utf8').split(JSON.stringify(VERSION)).length - 1,
    )
    .reduce((sum, count) => sum + count, 0);
  if (versionCopies !== 1)
    throw new Error(`the module both entries import is emitted ${versionCopies} times, not once`);
  const copies = [...new Bun.Glob('**/node_modules/stitchkit/package.json').scanSync(consumer)];
  if (copies.length !== 1)
    throw new Error(
      `consumer holds ${copies.length} physical stitchkit copies: ${copies.join(', ')}`,
    );
  console.log(
    JSON.stringify({
      package: CLIENT_NAME,
      version: VERSION,
      registry: candidate ? 'candidate' : NPM_REGISTRY,
      typechecks: ['Bundler', 'NodeNext'],
      status: 'ok',
    }),
  );
} finally {
  if (candidate) await candidate.close();
  rmSync(directory, { recursive: true, force: true });
}
