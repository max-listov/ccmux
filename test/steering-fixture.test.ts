import { expect } from 'bun:test';
import { OwnedCodexProjection } from '../src/agent/codex/ownedProjection.ts';
import type { CodexAppRpc } from '../src/agent/codex/rpc.ts';
import type { ManagedRuntimeRead } from '../src/runtime/schema.ts';
import { SteeringInputSchema } from '../src/steering/schema.ts';
import {
  readNativeSteering,
  type SteeringDependencies,
  steerNativeTurn,
} from '../src/steering/service.ts';
import { readSteeringJournal } from '../src/steering/store.ts';
import { attachmentFixture } from './attachments-fixture.test.ts';
import frames from './fixtures/codex-pane/v0.147.0.json';

export async function steeringFixture() {
  const f = await attachmentFixture();
  const projection = new OwnedCodexProjection(f.machine, f.session, process.pid);
  const expectedTurnId = crypto.randomUUID();
  projection.event({
    method: 'turn/started',
    params: { threadId: f.session.uuid, turn: { id: expectedTurnId, status: 'inProgress' } },
  });
  let state: ManagedRuntimeRead = {
    protocol: 1,
    status: 'live',
    reason: null,
    snapshot: projection.snapshot(),
  };
  const input = SteeringInputSchema.parse({
    target: f.target,
    registrationGeneration: f.session.registrationGeneration,
    generation: projection.snapshot().generation,
    expectedTurnId,
    operationId: crypto.randomUUID(),
    body: 'Focus on the first test.',
  });
  const calls: string[] = [],
    submissions: unknown[] = [];
  let nativeStatus: unknown = { type: 'active', activeFlags: [] },
    pane = frames.working;
  let recentlyTyped = false,
    receipts: unknown[] = [];
  let onSteer: (params: unknown) => Promise<unknown> = async () => ({
    turnId: input.expectedTurnId,
  });
  const rpc: CodexAppRpc = {
    close() {
      calls.push('close');
    },
    async request(method, params) {
      calls.push(method);
      if (method === 'thread/read') return { thread: { id: f.session.uuid, status: nativeStatus } };
      if (method === 'thread/turns/list') return { data: receipts };
      if (method === 'turn/steer') {
        expect(readSteeringJournal(f.machine, f.session).operations.at(-1)?.phase).toBe('intent');
        submissions.push(params);
        return onSteer(params);
      }
      throw new Error('unexpected native operation');
    },
  };
  const deps: SteeringDependencies = {
    connect: async () => {
      calls.push('connect');
      return rpc;
    },
    readStatus: () => state,
    typing: async () => recentlyTyped,
    gate: async (_m, _s, enabled) => {
      calls.push(enabled ? 'ungate' : 'gate');
      return true;
    },
    capture: async () => pane,
    images: async () => undefined,
  };
  const selector = {
    target: input.target,
    registrationGeneration: input.registrationGeneration,
    operationId: input.operationId,
  };
  return {
    ...f,
    input,
    deps,
    calls,
    submissions,
    projection,
    selector,
    setState(value: ManagedRuntimeRead) {
      state = value;
    },
    setPane(value: string) {
      pane = value;
    },
    setStatus(value: unknown) {
      nativeStatus = value;
    },
    setTyping(value: boolean) {
      recentlyTyped = value;
    },
    setSteer(value: (params: unknown) => Promise<unknown>) {
      onSteer = value;
    },
    receipts(value: unknown[]) {
      receipts = value;
    },
    run: () => steerNativeTurn(f.machine, f.principal, input, f.signal, deps),
    read: () => readNativeSteering(f.machine, f.principal, selector, f.signal, deps),
  };
}
