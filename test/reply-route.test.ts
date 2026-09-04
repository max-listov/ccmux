import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatChatInjection } from '../src/chat/format.ts';
import { cliPrincipal } from '../src/chat/identity.ts';
import { replyRouteFor, replyRouteToSender } from '../src/chat/replyRoute.ts';
import { makeChatMessage, makeMachine, makePeer } from './helpers.ts';

// The reply hint is PRESCRIPTIVE — the managed prompt tells the agent to use the pinned command
// verbatim — so a wrong verdict does not look untidy, it silently sends the answer to the wrong
// place. Incident 2026-08-25: a server with `remoteTransport.peers: [<hub>]` and a live agent was told "no route
// back to <hub> from here" and answered the human, while `ccmux msg <hub>:<session>` from that same
// box delivered instantly the same minute. The verdict was read off the ssh map alone; the remote transport — the
// transport that exists precisely for peers ssh cannot address — was never consulted.

let dir: string;
let socket: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccmux-reply-route-'));
  socket = join(dir, 'agent.sock');
  writeFileSync(socket, ''); // only its EXISTENCE is read — never opened, never probed
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const wireMachine = (over: Record<string, unknown> = {}) =>
  makeMachine({ rcPrefix: 'host-a', remoteTransport: { peers: ['host-b'], socket }, ...over });

test('a remote peer with a live local agent is replyable — no ssh map required', () => {
  expect(replyRouteFor(wireMachine(), 'host-b', 'api')).toEqual({ replyable: true });
});

test('a remote peer whose local agent is down gets an honest fallback that NAMES the cause', () => {
  const dead = join(dir, 'not-here.sock');
  const route = replyRouteFor(
    makeMachine({ rcPrefix: 'host-a', remoteTransport: { peers: ['host-b'], socket: dead } }),
    'host-b',
    'api',
  );
  expect(route.replyable).toBe(false);
  if (!route.replyable) {
    expect(route.reason).toContain('remote adapter is not running here');
    expect(route.reason).toContain(dead); // the exact thing to look at, not a verdict to believe
  }
});

test('the remote transport wins where both transports are configured — so does its verdict', () => {
  // `runPeer` sends a call for a remote peer over the remote transport even when an ssh alias exists. A hint that
  // answered from the alias would promise a path the delivery would not take.
  const dead = join(dir, 'not-here.sock');
  const m = makeMachine({
    rcPrefix: 'host-a',
    fleet: { 'host-b': 'alias-b' },
    remoteTransport: { peers: ['host-b'], socket: dead },
  });
  expect(replyRouteFor(m, 'host-b', 'api').replyable).toBe(false);
});

test('an ssh peer stays replyable, and so does this machine itself', () => {
  const m = makeMachine({ rcPrefix: 'host-a', fleet: { 'host-b': 'alias-b' } });
  expect(replyRouteFor(m, 'host-b', 'api')).toEqual({ replyable: true });
  expect(replyRouteFor(m, 'host-a', 'worker')).toEqual({ replyable: true });
});

test("a genuinely unknown machine is refused with the resolver's own reason", () => {
  const route = replyRouteFor(
    makeMachine({ rcPrefix: 'host-a', fleet: { 'host-c': 'alias-c' } }),
    'host-b',
    'api',
  );
  expect(route.replyable).toBe(false);
  if (!route.replyable) expect(route.reason).toContain("unknown machine 'host-b'");
});

test('a cli sender gets no routing verdict at all — there is no agent behind it to answer', () => {
  expect(replyRouteToSender(wireMachine(), cliPrincipal('host-b'))).toBeUndefined();
});

test('end to end: a remotely reachable sender is answered on the remote transport, not through the owner', () => {
  const msg = makeChatMessage({
    from: makePeer({ machine: 'host-b', session: 'api' }),
    to: makePeer({ machine: 'host-a', session: 'worker' }),
  });
  const m = wireMachine();
  const out = formatChatInjection(msg, { cli: 'ccmux', reply: replyRouteToSender(m, msg.from) });
  expect(out).toContain('reply: ccmux msg host-b:api --to-agent claude --to-thread');
  expect(out).not.toContain('msg owner');
});
