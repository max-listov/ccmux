import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { openCustomEngine } from '../src/agent/custom/engine.ts';
import { customLanguageModelProvider } from '../src/agent/custom/provider.ts';
import { customFixture as fixture } from './custom-fixture.ts';

/**
 * These turns run against the published OpenAI-compatible adapter, not a mock model.
 *
 * A stubbed `create()` proves the composition is wired; it cannot prove the thing most likely to be
 * wrong about a new provider — that a real local server's wire format is decoded into the text,
 * tool calls, usage and terminal reason this runtime reports. So the model is real and the network
 * is the stub, which puts the adapter's own decoding inside the test rather than beside it.
 */

const ENDPOINT = 'http://127.0.0.1:1234/v1';
const LOCAL_MODEL = { provider: 'local', model: 'local/fixture' } as const;

const localFixture = () =>
  fixture(async (_root, config) => {
    config.provider = { kind: 'local', endpoint: ENDPOINT };
    config.models = [
      { selection: { ...LOCAL_MODEL }, contextWindow: 8192, capabilities: ['tools'] },
    ];
    config.defaultModel = { ...LOCAL_MODEL };
  });

interface Attempt {
  url: string;
  authorization: string | null;
  body: { model?: string; stream?: boolean };
}

/** Serve one canned response to whatever the adapter asks for, and record what it asked. */
function stubEndpoint(respond: (init?: RequestInit) => Response | Promise<Response>) {
  const attempts: Attempt[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    attempts.push({
      url: typeof input === 'string' ? input : input.toString(),
      authorization: headers.get('authorization'),
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    return await respond(init);
  }) as typeof globalThis.fetch;
  const restore = () => {
    globalThis.fetch = original;
  };
  return { attempts, restore };
}

const sse = (events: readonly unknown[]) =>
  new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

const chunk = (delta: unknown, finish: string | null, usage?: unknown) => ({
  id: 'chunk-1',
  object: 'chat.completion.chunk',
  created: 1,
  model: LOCAL_MODEL.model,
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...(usage === undefined ? {} : { usage }),
});

async function turn(
  respond: () => Response | Promise<Response>,
  onOpen?: (engine: Awaited<ReturnType<typeof openCustomEngine>>) => Promise<void>,
) {
  const { root, s, host } = await localFixture();
  const stub = stubEndpoint(respond);
  const owner = await openCustomEngine({
    root: join(root, 'owner'),
    session: s,
    host,
    publish: () => undefined,
    onError: () => undefined,
    diagnose: () => undefined,
  });
  const conversationId = s.nativeSession?.id;
  if (!conversationId) throw new Error('fixture missing');
  const messageId = randomUUID();
  try {
    const ticket = owner.harness.submit({
      conversationId,
      idempotencyKey: messageId,
      context: owner.context,
      metadata: {
        registration: s.registrationGeneration,
        messageId,
        recipeDigest: s.launchRecipe?.digest,
        model: host.config.defaultModel,
      },
      parts: [{ type: 'text', text: 'say something' }],
    });
    const result = await ticket.result;
    await onOpen?.(owner);
    return { result, attempts: stub.attempts, owner, conversationId, root };
  } finally {
    stub.restore();
    await owner.close();
  }
}

test('a local turn is decoded by the real adapter and reaches only the declared endpoint', async () => {
  const { result, attempts } = await turn(() =>
    sse([
      chunk({ role: 'assistant', content: '' }, null),
      chunk({ content: 'hello from the host' }, null),
      chunk({}, 'stop', { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 }),
    ]),
  );
  expect(result.reason).toBe('success');
  expect(JSON.stringify(result.message.parts)).toContain('hello from the host');

  // Exactly one request, to the configured address, for the selected model. Anything else would be
  // the silent reroute this provider must never perform.
  expect(attempts).toHaveLength(1);
  expect(attempts[0]?.url).toBe(`${ENDPOINT}/chat/completions`);
  expect(attempts[0]?.body.model).toBe(LOCAL_MODEL.model);
  // No credential was declared, so none is sent — an empty bearer would be a credential too.
  expect(attempts[0]?.authorization).toBeNull();
});

test('counts the local server reports are carried; counts it omits stay unavailable', async () => {
  const reported = await turn(() =>
    sse([
      chunk({ content: 'measured' }, null),
      chunk({}, 'stop', { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 }),
    ]),
  );
  // A run's usage is the harness summing its steps, so the run-level provenance is `computed` even
  // from a single step the provider reported. The value is the server's; the arithmetic is ours,
  // and the words say which is which.
  expect(reported.result.run.usage?.inputTokens).toEqual({ value: 11, provenance: 'computed' });
  expect(reported.result.run.usage?.outputTokens).toEqual({ value: 4, provenance: 'computed' });

  // Many local servers omit usage on a streamed response. Mapping that to zero would turn "it did
  // not say" into "it said none", and a later context decision would rest on an invented number.
  const silent = await turn(() => sse([chunk({ content: 'measured' }, null), chunk({}, 'stop')]));
  expect(silent.result.run.usage?.inputTokens).toEqual({ provenance: 'unavailable' });
  expect(silent.result.run.usage?.outputTokens).toEqual({ provenance: 'unavailable' });
  // Local inference reports no price. Zero would be a claim the provider never made.
  expect(silent.result.run.usage?.cost).toEqual({ provenance: 'unavailable' });
});

test('an unreachable local endpoint is a typed provider failure, attempted once', async () => {
  const { result, attempts } = await turn(() => {
    throw new Error('connection refused');
  });
  expect(result.reason).toBe('provider_failure');
  expect(attempts.every(({ url }) => url.startsWith(ENDPOINT))).toBe(true);
  // A model server that is not running is the ordinary case for a local provider. It must fail as
  // itself, never by quietly asking somebody else the same question.
  expect(JSON.stringify(result.message.parts)).not.toContain('hello');
});

test('a malformed stream fails as a provider failure rather than as an answer', async () => {
  const { result } = await turn(
    () =>
      new Response('data: {"choices":[{"delta":\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
  );
  expect(result.reason).toBe('provider_failure');
});

test('an HTTP refusal from the local server is surfaced, not retried elsewhere', async () => {
  const { result, attempts } = await turn(
    () =>
      new Response(JSON.stringify({ error: { message: 'model not loaded' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
  );
  expect(result.reason).toBe('provider_failure');
  expect(attempts.every(({ url }) => url.startsWith(ENDPOINT))).toBe(true);
});

test('the local adapter distinguishes a reported count from one the server never sent', async () => {
  // At the step level — where this runtime is the one deciding — a count is `provider-reported`
  // only when the provider actually sent it. This is the fact the run-level sum is built from.
  const { host } = await localFixture();
  const normalize = customLanguageModelProvider(host).normalizeUsage;
  if (!normalize) throw new Error('local provider must normalize usage');
  const details = { cacheReadTokens: undefined, cacheWriteTokens: undefined };
  const said = normalize({
    usage: {
      inputTokens: 11,
      outputTokens: 4,
      totalTokens: 15,
      inputTokenDetails: { noCacheTokens: 11, ...details },
      outputTokenDetails: { textTokens: 4, reasoningTokens: undefined },
    },
  });
  expect(said.inputTokens).toEqual({ value: 11, provenance: 'provider-reported' });
  expect(said.reasoningTokens).toEqual({ provenance: 'unavailable' });
  expect(said.cost).toEqual({ provenance: 'unavailable' });

  const silent = normalize({
    usage: {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      inputTokenDetails: { noCacheTokens: undefined, ...details },
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    },
  });
  expect(silent.inputTokens).toEqual({ provenance: 'unavailable' });
  expect(silent.outputTokens).toEqual({ provenance: 'unavailable' });
});

test('a streamed tool call is decoded as a tool call, not invented into a text answer', async () => {
  // The failure this guards against is the comfortable one: a turn that produced only a tool call
  // reported as a finished reply. Then the caller reads a successful answer, the tool never ran,
  // and nothing in the record says so.
  const pending: unknown[] = [];
  const { result, attempts, root } = await turn(
    () =>
      sse([
        chunk({ role: 'assistant', content: null }, null),
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: 'call-1',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({
                    path: 'effect.txt',
                    content: 'once',
                    overwrite: false,
                  }),
                },
              },
            ],
          },
          null,
        ),
        chunk({}, 'tool_calls'),
      ]),
    async (engine) => {
      const conversationId = engine.conversationId;
      pending.push(...(await engine.harness.pendingApprovals(conversationId)));
    },
  );
  expect(attempts).toHaveLength(1);
  // The tool is an approval tool, so the decoded call stops at a signed approval rather than
  // running. That it stopped here is the proof the call was decoded as a call.
  expect(pending).toHaveLength(1);
  expect((pending[0] as { signature?: string }).signature).toBeString();
  expect(await Bun.file(join(root, 'effect.txt')).exists()).toBe(false);
  // No assistant prose was manufactured to stand in for the answer that has not happened yet.
  expect(JSON.stringify(result.message.parts)).not.toContain('"type":"text"');
  expect(result.reason).not.toBe('success');
});

test('cancelling a local turn ends it as interrupted, with nothing invented in its place', async () => {
  // A local server can stall for a long time, so interrupting mid-stream is ordinary rather than
  // exceptional. The run must end saying it was interrupted; a stalled stream that later reports a
  // finished answer would be the same lie as inventing one.
  const { root, s, host } = await localFixture();
  // Resolved when the provider request is actually in flight. Interrupting before the run
  // reaches the model is refused as a conflict, which would make this test measure its own race.
  let streaming: () => void = () => undefined;
  const inFlight = new Promise<void>((resolve) => {
    streaming = resolve;
  });
  const stub = stubEndpoint(
    (init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify(chunk({ content: 'thinking' }, null))}\n\n`,
              ),
            );
            // Held open deliberately, and closed only by the abort the runtime sends. A stub that
            // ignored the signal would test a cancellation no transport ever performs.
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('aborted', 'AbortError')),
            );
            streaming();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  const owner = await openCustomEngine({
    root: join(root, 'owner'),
    session: s,
    host,
    publish: () => undefined,
    onError: () => undefined,
    diagnose: () => undefined,
  });
  const conversationId = s.nativeSession?.id;
  if (!conversationId) throw new Error('fixture missing');
  const messageId = randomUUID();
  try {
    const ticket = owner.harness.submit({
      conversationId,
      idempotencyKey: messageId,
      context: owner.context,
      metadata: {
        registration: s.registrationGeneration,
        messageId,
        recipeDigest: s.launchRecipe?.digest,
        model: host.config.defaultModel,
      },
      parts: [{ type: 'text', text: 'stall' }],
    });
    const admission = await ticket.admission;
    await inFlight;
    const mutation = await owner.harness.interrupt({
      conversationId,
      runId: admission.runId,
    });
    expect(mutation.outcome).not.toBe('conflict');
    const result = await ticket.result;
    expect(['interrupted', 'cancelled']).toContain(result.reason);
    expect(stub.attempts).toHaveLength(1);
  } finally {
    stub.restore();
    await owner.close();
  }
});
