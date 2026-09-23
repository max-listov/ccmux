import { basename } from 'node:path';
import { Box, useApp, useInput, useStdout } from 'ink';
import { useEffect, useRef, useState } from 'react';
import type { AgentKind, MachineConfig } from '../types.ts';
import { log } from '../util/log.ts';
import {
  adoptExternal,
  forkAdoptExternal,
  removeSessionFully,
  restartAllSessions,
  restartSession,
  sendMessage,
  stopSession,
  takeoverExternal,
} from './actions.ts';
import type { DiscoveredSession } from './discover.ts';
import { discoverActive } from './discover.ts';
import type { FleetLoad } from './fleet.ts';
import { buildItems, resolveFleetItem } from './fleet.ts';
import { useDiscover } from './hooks/useDiscover.ts';
import { useFleet } from './hooks/useFleet.ts';
import { type Focus, useMouse } from './hooks/useMouse.ts';
import { useSpinner } from './hooks/useSpinner.ts';
import { useTranscript } from './hooks/useTranscript.ts';
import {
  INLINE_CHROME_ROWS,
  inlineFit,
  inlineMaxStart,
  inlineReveal,
  visibleCardCount,
} from './listWindow.ts';
import { FullscreenView } from './views/FullscreenView.tsx';
import { InlineView } from './views/InlineView.tsx';
import { type Mode, ModePrompt } from './views/ModePrompt.tsx';

export type Intent =
  | { type: 'quit' }
  | { type: 'attach'; name: string }
  | { type: 'new'; name: string; dir: string; agent: AgentKind };

const DEFAULT_LIST_WIDTH = 72;
const MIN_LIST_WIDTH = 44;

export function App({
  m,
  initialFullscreen,
  onIntent,
}: {
  m: MachineConfig;
  initialFullscreen: boolean;
  onIntent: (i: Intent) => void;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  // names whose tmux pane to capture each poll (visible cards + selection); filled below once the
  // window is known. A ref so the poll reads the latest without re-subscribing on every scroll.
  const liveNamesRef = useRef<Set<string> | undefined>(undefined);
  const { rows, loaded, reload } = useFleet(m, liveNamesRef);
  // Selection follows the SESSION (uuid), not a list position: the list re-sorts live by
  // last activity, so an index would silently slide onto a different card mid-navigation.
  const [selKey, setSelKey] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(initialFullscreen);
  const [focus, setFocus] = useState<Focus>('list');
  const [listWidth, setListWidth] = useState(DEFAULT_LIST_WIDTH);
  const [mode, setMode] = useState<Mode>('list');
  const [draft, setDraft] = useState('');
  const [newAgent, setNewAgent] = useState<AgentKind>('claude');
  const [composeDraft, setComposeDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [offset, setOffset] = useState(0);
  // listScroll = index of the top visible card in the fullscreen list window. Single source of
  // truth for vertical scrolling: the mouse wheel moves IT (without changing the selection), and
  // arrow-key navigation auto-reveals the cursor by nudging it (see revealCursor / moveCursor).
  const [listScroll, setListScroll] = useState(0);
  // Display snapshot only. Every ownership action re-resolves the route from fresh discovery.
  const [adoptSnapshot, setAdoptSnapshot] = useState<DiscoveredSession | null>(null);
  const [ownershipError, setOwnershipError] = useState<string | null>(null);
  const adoptTarget = useRef<string | null>(null);

  // The view opens on the managed fleet — what a person came here to steer. The local inventory
  // is a second, much longer list (stopped threads from months back), so it is something you ASK
  // for with `x`; `m.externalInventory` stays what it always was, the access policy for reading
  // external content, not a preference about the first frame.
  const [externalOn, setExternalOn] = useState(false);
  // Gated on `loaded`: the managed fleet is what the view is FOR, and discovery blocks the thread
  // for as long as the box's accumulated history takes to scan. Sessions paint first, always.
  const { list: discovered, scanning } = useDiscover(m, mode === 'list' && externalOn && loaded);
  const { items, externalStart } = buildItems(rows, discovered, m.rcPrefix);
  // animate the spinner only when something is actually working — otherwise the whole tree would
  // re-render 5×/s for nothing (idle fleet = static frame, zero churn). See useSpinner.
  // Loading and scanning ARE work, so the spinner animates for them too — the invariant is
  // "tick only when something is happening", not "tick only when a session is busy".
  const anyActive = items.some((it) => it.status.active);
  const spin = useSpinner(anyActive || !loaded || scanning);
  const count = items.length;
  // Resolve the selected route identity to wherever the activity sort put it this render; if the
  // session is gone (deleted / adopted away) fall back to the same list position.
  const lastCurRef = useRef(0);
  const foundIdx = selKey === null ? -1 : items.findIndex((it) => it.key === selKey);
  const cur = foundIdx >= 0 ? foundIdx : Math.min(lastCurRef.current, Math.max(0, count - 1));
  lastCurRef.current = cur;
  const selItem = items[cur];
  const selected = selItem?.row;
  const isExternal = selItem?.external ?? false;
  const messages = useTranscript(m, fullscreen && selected ? selected.session : null, fullscreen);
  const defaultName = `cc-${basename(process.cwd())}`;

  // ── list scroll window: only the cards that FIT render, in both views — a frame taller than
  //    the terminal is one the terminal scrolls, and then every poll repaint throws the reader
  //    back to the bottom. Fullscreen divides by a fixed card stride; inline counts item heights
  //    (an external card is one row taller). winStart is the clamped listScroll either way.
  const termRows = stdout?.rows ?? 28;
  // Modes draw their own prompt under the list; leave it room instead of pushing a card off-screen.
  const promptRows = mode === 'list' ? 0 : mode === 'adopt' ? 3 : 1;
  const inlineRows = Math.max(3, termRows - INLINE_CHROME_ROWS - promptRows);
  const maxScrollTop = fullscreen
    ? Math.max(0, count - visibleCardCount(termRows))
    : inlineMaxStart(items, inlineRows, externalStart);
  const winStart = Math.min(Math.max(0, listScroll), maxScrollTop);
  const visibleCards = fullscreen
    ? visibleCardCount(termRows)
    : inlineFit(items, winStart, inlineRows, externalStart);

  // Tell the fleet poll which panes to capture: the selection + the on-screen managed cards.
  // Off-screen running sessions reuse their cached scan — fewer tmux forks per tick. Recomputed
  // every render so scrolling refreshes what's shown.
  const liveNames = new Set<string>();
  if (selected && !isExternal) liveNames.add(selected.session.name);
  for (const it of items.slice(winStart, winStart + visibleCards)) {
    if (!it.external) liveNames.add(it.row.session.name);
  }
  liveNamesRef.current = liveNames;

  // Scroll the window the minimum needed to bring card `idx` into view (used after arrow nav so
  // the selection is never hidden — "доскролл чтобы в экране был").
  const revealCursor = (idx: number): void => {
    setListScroll((s) => {
      if (!fullscreen) return inlineReveal(items, s, idx, inlineRows, externalStart);
      const top = Math.min(Math.max(0, s), maxScrollTop);
      if (idx < top) return idx;
      if (idx >= top + visibleCards) return idx - visibleCards + 1;
      return top;
    });
  };

  // Select by INDEX → store the card's route identity.
  const selectAt = (idx: number): void => {
    const it = items[idx];
    if (it) setSelKey(it.key);
  };

  /** Re-scan local inventory and resolve the stable key immediately before an external mutation. */
  const resolveFreshExternal = (key: string | null): typeof selItem | null => {
    if (key === null) return null;
    const freshItems = buildItems(rows, discoverActive(m), m.rcPrefix).items;
    const item = resolveFleetItem(freshItems, key);
    return item?.external && item.ext ? item : null;
  };

  const moveCursor = (delta: number): void => {
    if (count === 0) return;
    const next = (((cur + delta) % count) + count) % count;
    selectAt(next);
    revealCursor(next);
    setOffset(0); // new session → reset transcript scroll
  };
  // offset = how many messages scrolled back from the latest (TranscriptPane takes whole
  // messages that fit from the bottom up). Max useful offset = the first message at the bottom.
  const maxScroll = Math.max(0, messages.length - 1);
  const scroll = (delta: number): void =>
    setOffset((o) => Math.min(Math.max(0, o + delta), maxScroll));

  // Alt-screen is App's concern (driven by the fullscreen toggle), so `f` switches
  // cleanly and exit/attach always restores the terminal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a fullscreen transition may reset the terminal; cursor movement must not re-enter alt-screen.
  useEffect(() => {
    if (!fullscreen) return;
    stdout?.write('\x1b[?1049h\x1b[H');
    revealCursor(cur); // entering fullscreen → make sure the selected card is in the window
    return () => {
      stdout?.write('\x1b[?1049l');
    };
  }, [fullscreen, stdout]);

  // When the activity re-sort MOVES the selected card (cur changed without navigation), or the
  // terminal is resized under it, follow it — the selection must never sit outside the window.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reveal on selection and viewport changes, not on every render or manual scroll.
  useEffect(() => {
    revealCursor(cur);
  }, [cur, termRows]);

  const { hoverHandle, hoverPane, hoverCard } = useMouse(
    fullscreen,
    {
      listWidth,
      minListWidth: MIN_LIST_WIDTH,
      winStart,
      visibleCards,
      count,
      externalStart,
      maxScrollTop,
      maxScroll,
    },
    { setListScroll, setOffset, setFocus, setListWidth, selectAt },
  );

  useInput((input, key) => {
    if (input.includes('[<')) return; // mouse SGR — handled by the wheel effect above
    if (mode === 'new') {
      if (key.return)
        onIntent({
          type: 'new',
          name: draft.trim() || defaultName,
          dir: process.cwd(),
          agent: newAgent,
        });
      else if (key.tab) setNewAgent((agent) => (agent === 'claude' ? 'codex' : 'claude'));
      else if (key.escape) {
        setMode('list');
        setDraft('');
      } else if (key.backspace || key.delete) setDraft((d) => d.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setDraft((d) => d + input);
      return;
    }
    if (mode === 'confirm') {
      // confirm delete: y / Enter / the same delete key again (d/D) → remove; n / Esc → cancel
      if (selected && (input === 'y' || input === 'd' || input === 'D' || key.return)) {
        log.info({ msg: 'delete confirmed', name: selected.session.name });
        void removeSessionFully(m, selected.session.name).then(reload);
        setMode('list');
      } else if (key.escape || input === 'n') {
        log.info({ msg: 'delete cancelled' });
        setMode('list');
      }
      return;
    }
    if (mode === 'confirm-restart-all') {
      // confirm fleet sweep: y / Enter / R again → restart every session; n / Esc → cancel
      if (input === 'y' || input === 'R' || key.return) {
        log.info({ msg: 'restart all confirmed' });
        restartAllSessions();
        setMode('list');
      } else if (key.escape || input === 'n') {
        log.info({ msg: 'restart all cancelled' });
        setMode('list');
      }
      return;
    }
    if (mode === 'adopt') {
      // a cold adopt was blocked by live writers — choose: f fork (safe) · t takeover · esc
      const target = resolveFreshExternal(adoptTarget.current);
      const ext = target?.ext;
      if (target && ext?.capabilities.fork && input === 'f') {
        log.info({ msg: 'adopt → fork', uuid: ext.threadId });
        setOwnershipError(null);
        void forkAdoptExternal(m, ext).then((result) => {
          if (result.ok) {
            reload();
            setMode('list');
            return;
          }
          setOwnershipError(result.error);
          setAdoptSnapshot(resolveFreshExternal(target.key)?.ext ?? ext);
        });
      } else if (target && ext?.capabilities.terminateAndAdopt && input === 't') {
        log.info({ msg: 'adopt → takeover', uuid: ext.threadId });
        setOwnershipError(null);
        void takeoverExternal(m, ext).then((result) => {
          if (result.ok) {
            reload();
            setMode('list');
            return;
          }
          setOwnershipError(result.error);
          setAdoptSnapshot(resolveFreshExternal(target.key)?.ext ?? ext);
        });
      } else if (key.escape || input === 'n' || input === 'q') {
        log.info({ msg: 'adopt cancelled' });
        setOwnershipError(null);
        setMode('list');
      }
      return;
    }
    if (mode === 'compose') {
      if (key.return) {
        const body = composeDraft.trim();
        if (body && selected && !isExternal) {
          setComposeDraft('');
          setSending(true);
          void sendMessage(m, selected.session.name, body);
          setTimeout(() => setSending(false), 1500);
        }
      } else if (key.escape) {
        setMode('list');
        setComposeDraft('');
      } else if (key.backspace || key.delete) setComposeDraft((d) => d.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setComposeDraft((d) => d + input);
      return;
    }

    // ── list mode ──
    // focus switch (fullscreen only): ← list pane · → transcript pane
    if (fullscreen && key.rightArrow) {
      setFocus('transcript');
      return;
    }
    if (fullscreen && key.leftArrow) {
      setFocus('list');
      return;
    }
    // up/down: context-sensitive — move session (list focus) or scroll transcript (transcript focus)
    const inTranscript = fullscreen && focus === 'transcript';
    if (key.upArrow) {
      inTranscript ? scroll(1) : moveCursor(-1);
      return;
    }
    if (key.downArrow) {
      inTranscript ? scroll(-1) : moveCursor(1);
      return;
    }
    if (fullscreen && key.pageUp) {
      scroll(5);
      return;
    }
    if (fullscreen && key.pageDown) {
      scroll(-5);
      return;
    }
    // resize panes (fullscreen): [ narrower list · ] wider list
    if (fullscreen && input === '[') {
      setListWidth((w) => Math.max(MIN_LIST_WIDTH, w - 4));
      return;
    }
    if (fullscreen && input === ']') {
      setListWidth((w) => w + 4);
      return;
    }

    // attach only managed sessions; external are read-only (peek transcript only)
    if (key.return && selected && !isExternal) {
      onIntent({ type: 'attach', name: selected.session.name });
      return;
    }
    if (input === 'q') {
      exit();
      return;
    }
    if (input === 'f') {
      setFullscreen((v) => !v);
      return;
    }
    // Turning the inventory off drops the external rows immediately; the selection is keyed by
    // route identity, so a cursor parked on one falls back to the same position among managed.
    if (input === 'x') {
      setExternalOn((v) => !v);
      return;
    }
    // compose a chat message (fullscreen, managed session only — external is read-only)
    if (fullscreen && input === 'i' && selected && !isExternal) {
      setMode('compose');
      setComposeDraft('');
      setFocus('transcript');
      return;
    }
    if (input === 'n') {
      setMode('new');
      setDraft('');
      setNewAgent('claude');
      return;
    }
    // adopt an EXTERNAL session into ccmux. Cold adopt only when nobody is driving the uuid;
    // a live writer would mean a SECOND resume = forked conversation, so the blocked case
    // opens the explicit fork/takeover choice instead.
    if (input === 'a' && isExternal) {
      const target = resolveFreshExternal(selKey);
      const ext = target?.ext;
      if (!target || !ext) return;
      if (!ext.capabilities.attemptAdopt) {
        if (
          ext.capabilities.fork ||
          ext.capabilities.terminateAndAdopt ||
          ext.capabilities.releaseAtSource
        ) {
          adoptTarget.current = target.key;
          setAdoptSnapshot(ext);
          setOwnershipError(null);
          setMode('adopt');
        }
        return;
      }
      log.info({ msg: 'action adopt', uuid: ext.threadId });
      setOwnershipError(null);
      void adoptExternal(m, ext).then((r) => {
        if (r.ok) {
          reload();
          return;
        }
        if (r.writers) {
          adoptTarget.current = target.key;
          setAdoptSnapshot(resolveFreshExternal(target.key)?.ext ?? ext);
          setOwnershipError(r.error);
          setMode('adopt');
        } else if (
          ext.capabilities.fork ||
          ext.capabilities.terminateAndAdopt ||
          ext.capabilities.releaseAtSource
        ) {
          adoptTarget.current = target.key;
          setAdoptSnapshot(ext);
          setOwnershipError(r.error);
          setMode('adopt');
        }
      });
      return;
    }
    if (input === 's' && selected && !isExternal) {
      log.info({ msg: 'action stop', name: selected.session.name });
      void stopSession(m, selected.session.name).then(reload);
      return;
    }
    if (input === 'r' && selected && !isExternal) {
      log.info({ msg: 'action restart', name: selected.session.name });
      void restartSession(m, selected.session.name).then(reload);
      return;
    }
    // R = restart the WHOLE fleet — always behind a confirm (one keystroke bouncing every session
    // must never be unguarded). Managed sessions only; the sweep itself skips archived ones.
    if (input === 'R' && externalStart > 0) {
      log.info({ msg: 'action restart all → confirm', count: externalStart });
      setMode('confirm-restart-all');
      return;
    }
    // delete: accept lowercase d too (footer shows "D"); opens the confirm step
    if ((input === 'D' || input === 'd') && selected && !isExternal) {
      log.info({ msg: 'action delete → confirm', name: selected.session.name });
      setMode('confirm');
    }
  });

  const load: FleetLoad = { loaded, externalOn, externalScanning: scanning };
  const view = fullscreen ? (
    <FullscreenView
      items={items}
      externalStart={externalStart}
      cursor={cur}
      winStart={winStart}
      visibleCards={visibleCards}
      spin={spin}
      rcPrefix={m.rcPrefix}
      messages={messages}
      transcriptOffset={offset}
      focus={focus}
      listWidth={listWidth}
      handleActive={hoverHandle}
      hoverPane={hoverPane}
      hoverCard={hoverCard}
      composing={mode === 'compose'}
      composeDraft={composeDraft}
      sending={sending}
      canCompose={!!selected && !isExternal}
      load={load}
    />
  ) : (
    <InlineView
      items={items}
      externalStart={externalStart}
      cursor={cur}
      winStart={winStart}
      visibleCards={visibleCards}
      spin={spin}
      rcPrefix={m.rcPrefix}
      load={load}
    />
  );

  return (
    <Box flexDirection="column">
      {view}
      <ModePrompt
        mode={mode}
        draft={draft || defaultName}
        agent={newAgent}
        selectedName={selected?.session.name ?? null}
        managedCount={externalStart}
        adopt={adoptSnapshot}
        ownershipError={ownershipError}
      />
    </Box>
  );
}
