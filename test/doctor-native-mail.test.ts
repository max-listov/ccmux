import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveCursors } from '../src/chat/cursors.ts';
import { STALLED_HOLD_MS } from '../src/chat/holdReason.ts';
import { managedPeer, managedPeerKey } from '../src/chat/identity.ts';
import { blockingInbound, mailHold } from '../src/chat/inboundHold.ts';
import { appendMessage } from '../src/chat/ledger.ts';
import { ChatCursorsSchema } from '../src/chat/messageSchema.ts';
import { stalledMail } from '../src/commands/doctorChecks.ts';
import { STATUS_DIR } from '../src/config/paths.ts';
import { writeSessionsUnlocked } from '../src/session/registry.ts';
import { clearChatHold, writeChatHold } from '../src/session/status.ts';
import { makeChatMessage, makeMachine, makeSession } from './helpers.ts';

test('doctor follows a native pickup after cursor advance and inbox read, until it settles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-doctor-native-'));
  const m = makeMachine({ stateDir: root });
  const s = makeSession({
    name: `doctor-native-${crypto.randomUUID()}`,
    agent: 'codex',
    runtime: 'app-server',
    chatEnabled: true,
  });
  const peer = managedPeer(m.rcPrefix, s);
  const key = managedPeerKey(peer);
  const msg = makeChatMessage({ id: crypto.randomUUID(), to: peer });
  const cursors = ChatCursorsSchema.parse({});
  const holdPath = join(STATUS_DIR, `${s.name}.chathold.json`);
  try {
    appendMessage(m, msg);
    await writeSessionsUnlocked(m, [s]);
    cursors.delivered[key] = 1;
    cursors.read[key] = 1;
    cursors.pickups[key] = {
      messageId: msg.id,
      ledgerIndex: 0,
      injectedAt: new Date().toISOString(),
      conditional: false,
      native: { phase: 'intent', turnId: null },
    };
    await saveCursors(m, cursors);
    await writeChatHold(s.name, msg.id, 'native composer unavailable');
    expect(blockingInbound(m, s, Date.now()).map((row) => row.id)).toEqual([msg.id]);
    expect(mailHold(m, s, blockingInbound(m, s, Date.now()), Date.now())).toContain(
      'native composer unavailable',
    );
    const hold = JSON.parse(readFileSync(holdPath, 'utf8'));
    // Freshly held mail is not stalled. Age only the first-hold timestamp, leaving the sample fresh.
    expect(stalledMail(m)).toEqual([]);
    writeFileSync(
      holdPath,
      JSON.stringify({ ...hold, since: Date.now() - STALLED_HOLD_MS - 1000 }),
    );
    expect(stalledMail(m)).toEqual([
      { session: s.name, reason: expect.stringContaining('native composer unavailable') },
    ]);
    delete cursors.pickups[key];
    await saveCursors(m, cursors);
    expect(stalledMail(m)).toEqual([]);
    expect(blockingInbound(m, s, Date.now())).toEqual([]);
  } finally {
    clearChatHold(s.name);
    rmSync(root, { recursive: true, force: true });
  }
});
