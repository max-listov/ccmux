import { expect, test } from 'bun:test';
import { codexSelectionEvent } from '../src/agent/codex/selectionEvidence.ts';
import { NativeSelectionEvidenceSchema } from '../src/runtime/selectionSchema.ts';

const settings = {
  method: 'thread/settings/updated',
  params: {
    threadId: 'native-thread',
    threadSettings: {
      model: 'model-next',
      modelProvider: 'provider-a',
      effort: 'low',
      collaborationMode: {
        mode: 'plan',
        settings: { developer_instructions: 'private fixture instructions' },
      },
      cwd: '/private/fixture/workspace',
      config: { secret: 'fixture-secret-value' },
    },
  },
};

test('native settings, not desired defaults, provide effective model/mode/effort evidence', () => {
  const evidence = codexSelectionEvent(settings, 'native-thread', null);
  if (evidence === null) throw new Error('Native settings evidence missing');
  expect(evidence).toEqual({
    model: { provider: 'provider-a', model: 'model-next' },
    options: {
      runtime: 'codex',
      model: { provider: 'provider-a', model: 'model-next' },
      mode: 'plan',
      effort: 'low',
    },
    source: 'settings',
    turnId: null,
  });
  expect(NativeSelectionEvidenceSchema.parse(evidence)).toEqual(evidence);
  expect(JSON.stringify(evidence)).not.toContain('private');
  expect(JSON.stringify(evidence)).not.toContain('secret');
});

test('null native effort stays absent rather than becoming an invented default', () => {
  const event = {
    ...settings,
    params: {
      ...settings.params,
      threadSettings: { ...settings.params.threadSettings, effort: null },
    },
  };
  expect(codexSelectionEvent(event, 'native-thread', null)?.options).not.toHaveProperty('effort');
});

test('foreign native thread settings do not update the managed identity', () => {
  expect(codexSelectionEvent(settings, 'other-thread', null)).toBeNull();
});

test('native reroute changes observed model without claiming effective mode or copying internal reason', () => {
  const previous = codexSelectionEvent(settings, 'native-thread', null);
  const event = {
    method: 'model/rerouted',
    params: {
      threadId: 'native-thread',
      turnId: 'turn-a',
      fromModel: 'model-next',
      toModel: 'model-routed',
      reason: 'private fixture provider detail',
    },
  };
  expect(codexSelectionEvent(event, 'native-thread', previous)).toEqual({
    model: { provider: 'provider-a', model: 'model-routed' },
    options: null,
    source: 'reroute',
    turnId: 'turn-a',
  });
  expect(codexSelectionEvent(event, 'other-thread', previous)).toBeNull();
  expect(codexSelectionEvent(event, 'native-thread', null)).toBeNull();
});

test('unknown native mode does not masquerade as an admitted selection', () => {
  const event = {
    ...settings,
    params: {
      ...settings.params,
      threadSettings: {
        ...settings.params.threadSettings,
        collaborationMode: { mode: 'unknown' },
      },
    },
  };
  expect(() => codexSelectionEvent(event, 'native-thread', null)).toThrow();
  expect(
    codexSelectionEvent({ method: 'thread/started', params: {} }, 'native-thread', null),
  ).toBeNull();
});
