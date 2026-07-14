import { basename } from "node:path";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import type { MachineConfig } from "../types.ts";
import { useFleet } from "./hooks/useFleet.ts";
import { useSpinner } from "./hooks/useSpinner.ts";
import { useTranscript } from "./hooks/useTranscript.ts";
import { useDiscover } from "./hooks/useDiscover.ts";
import { buildItems } from "./fleet.ts";
import { InlineView } from "./views/InlineView.tsx";
import { FullscreenView } from "./views/FullscreenView.tsx";
import { stopSession, restartSession, removeSessionFully, sendMessage, adoptExternal, forkAdoptExternal, takeoverExternal } from "./actions.ts";
import { describeWriter, type Writer } from "../agent/claude/writers.ts";
import { log } from "../util/log.ts";
import { mouseDebugOn, logMouse, describeSgr } from "./mouseProbe.ts";

export type Intent = { type: "quit" } | { type: "attach"; name: string } | { type: "new"; name: string; dir: string };

type Mode = "list" | "new" | "confirm" | "compose" | "adopt";
type Focus = "list" | "transcript";

const DEFAULT_LIST_WIDTH = 72;
const MIN_LIST_WIDTH = 44;

// Fullscreen card geometry (must match FullscreenView's framed SessionCard layout) so a
// mouse Y can be mapped to a card index. header(1) + pane top-border(1) → first card at
// terminal row 3; each framed card is 6 rows; the external separator adds 1 row.
const CARD_TOP = 3; // header bar (1) + pane top border (1) → first card body at row 3
const CARD_H = 8; // stride: 7-row card + 1-row gap
const CARD_BODY = 7; // clickable rows (the gap is dead space)
/** How many whole cards fit in the (clipped) list pane. N cards take N·CARD_BODY + (N−1)
 *  gaps = N·CARD_H − 1 rows (the last card has no trailing gap), so +1 before dividing. */
function visibleCardCount(termRows: number): number {
  const interior = Math.max(1, termRows - 4); // minus header(1) footer(1) + pane top/bottom border(2)
  return Math.max(1, Math.floor((interior + 1) / CARD_H));
}
/** Map a terminal Y to a GLOBAL card index, accounting for the scroll window + the one-row
 *  external separator. Mirrors FullscreenView's windowed layout exactly. */
function cardIndexAtY(y: number, winStart: number, visible: number, count: number, externalStart: number): number | null {
  let rowY = CARD_TOP;
  for (let k = 0; k < visible; k++) {
    const gi = winStart + k;
    if (gi >= count) break;
    if (gi === externalStart && externalStart < count) rowY += 1; // separator row above the first external card
    if (y >= rowY && y < rowY + CARD_BODY) return gi;
    rowY += CARD_H;
  }
  return null;
}

export function App({ m, initialFullscreen, onIntent }: { m: MachineConfig; initialFullscreen: boolean; onIntent: (i: Intent) => void }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { stdin } = useStdin();
  // names whose tmux pane to capture each poll (visible cards + selection); filled below once the
  // window is known. A ref so the poll reads the latest without re-subscribing on every scroll.
  const liveNamesRef = useRef<Set<string> | undefined>(undefined);
  const { rows, reload } = useFleet(m, liveNamesRef);
  // Selection follows the SESSION (uuid), not a list position: the list re-sorts live by
  // last activity, so an index would silently slide onto a different card mid-navigation.
  const [selKey, setSelKey] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(initialFullscreen);
  const [focus, setFocus] = useState<Focus>("list");
  const [listWidth, setListWidth] = useState(DEFAULT_LIST_WIDTH);
  const [mode, setMode] = useState<Mode>("list");
  const [draft, setDraft] = useState("");
  const [composeDraft, setComposeDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [offset, setOffset] = useState(0);
  // listScroll = index of the top visible card in the fullscreen list window. Single source of
  // truth for vertical scrolling: the mouse wheel moves IT (without changing the selection), and
  // arrow-key navigation auto-reveals the cursor by nudging it (see revealCursor / moveCursor).
  const [listScroll, setListScroll] = useState(0);
  // live writers blocking a cold adopt — set when `a` hits a session someone is driving;
  // the adopt-confirm bar then offers fork (safe copy) or takeover (kill writers).
  const [adoptWriters, setAdoptWriters] = useState<Writer[]>([]);
  const adoptTarget = useRef<{ dir: string; uuid: string } | null>(null);

  const discovered = useDiscover(m, mode === "list");
  const { items, externalStart } = buildItems(rows, discovered);
  // animate the spinner only when something is actually working — otherwise the whole tree would
  // re-render 5×/s for nothing (idle fleet = static frame, zero churn). See useSpinner.
  const anyActive = items.some((it) => it.status.active);
  const spin = useSpinner(anyActive);
  const count = items.length;
  // Resolve the selected uuid to wherever the activity sort put it this render; if the
  // session is gone (deleted / adopted away) fall back to the same list position.
  const lastCurRef = useRef(0);
  const foundIdx = selKey === null ? -1 : items.findIndex((it) => it.row.session.uuid === selKey);
  const cur = foundIdx >= 0 ? foundIdx : Math.min(lastCurRef.current, Math.max(0, count - 1));
  lastCurRef.current = cur;
  const selItem = items[cur];
  const selected = selItem?.row;
  const isExternal = selItem?.external ?? false;
  const messages = useTranscript(m, fullscreen && selected ? selected.session : null, fullscreen);
  const defaultName = `cc-${basename(process.cwd())}`;

  // ── list scroll window: only the cards that fit in the clipped pane render; winStart is the
  //    clamped listScroll. maxScrollTop is the furthest the window can scroll down.
  const visibleCards = visibleCardCount(stdout?.rows ?? 28);
  const maxScrollTop = Math.max(0, count - visibleCards);
  const winStart = Math.min(Math.max(0, listScroll), maxScrollTop);

  // Tell the fleet poll which panes to capture: the selection + the on-screen managed cards
  // (fullscreen = the scroll window, inline = all). Off-screen running sessions reuse their cached
  // scan — fewer tmux forks per tick. Recomputed every render so scrolling refreshes what's shown.
  const liveNames = new Set<string>();
  if (selected && !isExternal) liveNames.add(selected.session.name);
  for (const it of fullscreen ? items.slice(winStart, winStart + visibleCards) : items) {
    if (!it.external) liveNames.add(it.row.session.name);
  }
  liveNamesRef.current = liveNames;

  // Scroll the window the minimum needed to bring card `idx` into view (used after arrow nav so
  // the selection is never hidden — "доскролл чтобы в экране был").
  const revealCursor = (idx: number): void => {
    setListScroll((s) => {
      const top = Math.min(Math.max(0, s), maxScrollTop);
      if (idx < top) return idx;
      if (idx >= top + visibleCards) return idx - visibleCards + 1;
      return top;
    });
  };

  // Select by INDEX → store the card's uuid. Reads itemsRef (not the closure) so the
  // long-lived mouse listener can call it without going stale.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const selectAt = (idx: number): void => {
    const it = itemsRef.current[idx];
    if (it) setSelKey(it.row.session.uuid);
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
  const scroll = (delta: number): void => setOffset((o) => Math.min(Math.max(0, o + delta), maxScroll));

  // Mirror volatile values into refs so the long-lived mouse listener never goes stale
  // and a live drag (listWidth changing every motion) doesn't re-attach mid-gesture.
  const listWidthRef = useRef(listWidth);
  listWidthRef.current = listWidth;
  const countRef = useRef(count);
  countRef.current = count;
  const maxScrollRef = useRef(maxScroll);
  maxScrollRef.current = maxScroll;
  const draggingRef = useRef(false);
  const externalStartRef = useRef(externalStart);
  externalStartRef.current = externalStart;

  // Mirror window values into refs so the long-lived mouse listener reads fresh data.
  const winStartRef = useRef(winStart);
  winStartRef.current = winStart;
  const visibleRef = useRef(visibleCards);
  visibleRef.current = visibleCards;
  const maxScrollTopRef = useRef(maxScrollTop);
  maxScrollTopRef.current = maxScrollTop;
  const [hoverHandle, setHoverHandle] = useState(false);
  const [hoverPane, setHoverPane] = useState<Focus | null>(null);
  const [hoverCard, setHoverCard] = useState<number | null>(null);

  // Alt-screen is App's concern (driven by the fullscreen toggle), so `f` switches
  // cleanly and exit/attach always restores the terminal.
  useEffect(() => {
    if (!fullscreen) return;
    stdout?.write("\x1b[?1049h\x1b[H");
    revealCursor(cur); // entering fullscreen → make sure the selected card is in the window
    return () => {
      stdout?.write("\x1b[?1049l");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen, stdout]);

  // When the activity re-sort MOVES the selected card (cur changed without navigation),
  // follow it — the selection must never sit outside the scroll window.
  useEffect(() => {
    revealCursor(cur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur]);

  // ── mouse: wheel scrolls the pane under the cursor (zone by x, independent of focus);
  //    the divider is a hover/drag handle for live resize. ?1003h (any-motion) gives
  //    hover+drag — events are processed IN MEMORY ONLY (never logged → no disk flood).
  //    Refs keep the listener stable so a drag never re-attaches mid-gesture.
  useEffect(() => {
    if (!fullscreen) return;
    stdout?.write("\x1b[?1003h\x1b[?1006h");
    const onData = (d: Buffer): void => {
      const s = d.toString();
      if (!s.includes("\x1b[<")) return;
      if (mouseDebugOn) logMouse("STDIN", describeSgr(s));
      const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
      for (let mm = re.exec(s); mm !== null; mm = re.exec(s)) {
        const btn = Number(mm[1]);
        const x = Number(mm[2]);
        const y = Number(mm[3]);
        const release = mm[4] === "m";
        const lw = listWidthRef.current;
        const nearHandle = Math.abs(x - (lw + 1)) <= 1;
        const zone: Focus = x <= lw ? "list" : "transcript";
        if (btn === 64 || btn === 65) {
          const up = btn === 64;
          if (x <= lw) {
            // wheel over the list → SCROLL the window (selection unchanged), like any list pane
            setListScroll((s) => Math.max(0, Math.min(s + (up ? -1 : 1), maxScrollTopRef.current)));
          } else {
            setOffset((o) => Math.min(Math.max(0, o + (up ? 1 : -1)), maxScrollRef.current));
          }
          continue;
        }
        if (btn === 0 && !release) {
          // press: on the divider → start a resize drag; on a list card → select it; else focus the pane
          if (nearHandle) { draggingRef.current = true; setHoverHandle(true); }
          else if (zone === "list") {
            const idx = cardIndexAtY(y, winStartRef.current, visibleRef.current, countRef.current, externalStartRef.current);
            if (idx !== null) { selectAt(idx); setOffset(0); }
            setFocus("list");
          } else setFocus(zone);
          continue;
        }
        if (release) { draggingRef.current = false; setHoverHandle(nearHandle); continue; }
        if ((btn & 32) !== 0) { // motion: drag-resize · else hover-highlight (handle + pane + card)
          if (draggingRef.current) {
            const cols = stdout?.columns ?? 100;
            setListWidth(Math.max(MIN_LIST_WIDTH, Math.min(cols - 30, x - 1)));
          } else {
            setHoverHandle(nearHandle);
            setHoverPane(zone);
            setHoverCard(zone === "list" ? cardIndexAtY(y, winStartRef.current, visibleRef.current, countRef.current, externalStartRef.current) : null);
          }
        }
      }
    };
    stdin?.on("data", onData);
    return () => {
      stdin?.off("data", onData);
      stdout?.write("\x1b[?1003l\x1b[?1006l");
    };
  }, [fullscreen, stdout, stdin]);

  useInput((input, key) => {
    if (input.includes("[<")) return; // mouse SGR — handled by the wheel effect above
    if (mode === "new") {
      if (key.return) onIntent({ type: "new", name: draft.trim() || defaultName, dir: process.cwd() });
      else if (key.escape) { setMode("list"); setDraft(""); }
      else if (key.backspace || key.delete) setDraft((d) => d.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setDraft((d) => d + input);
      return;
    }
    if (mode === "confirm") {
      // confirm delete: y / Enter / the same delete key again (d/D) → remove; n / Esc → cancel
      if (selected && (input === "y" || input === "d" || input === "D" || key.return)) {
        log.info({ msg: "delete confirmed", name: selected.session.name });
        void removeSessionFully(m, selected.session.name).then(reload);
        setMode("list");
      } else if (key.escape || input === "n") {
        log.info({ msg: "delete cancelled" });
        setMode("list");
      }
      return;
    }
    if (mode === "adopt") {
      // a cold adopt was blocked by live writers — choose: f fork (safe) · t takeover · esc
      const target = adoptTarget.current;
      if (target && input === "f") {
        log.info({ msg: "adopt → fork", uuid: target.uuid });
        void forkAdoptExternal(m, target.uuid).then(reload);
        setMode("list");
      } else if (target && input === "t" && !adoptWriters.some((w) => w.kind === "self")) {
        log.info({ msg: "adopt → takeover", uuid: target.uuid });
        void takeoverExternal(m, target.dir, target.uuid).then(reload);
        setMode("list");
      } else if (key.escape || input === "n" || input === "q") {
        log.info({ msg: "adopt cancelled" });
        setMode("list");
      }
      return;
    }
    if (mode === "compose") {
      if (key.return) {
        const body = composeDraft.trim();
        if (body && selected && !isExternal) {
          setComposeDraft("");
          setSending(true);
          void sendMessage(m, selected.session.name, body);
          setTimeout(() => setSending(false), 1500);
        }
      } else if (key.escape) { setMode("list"); setComposeDraft(""); }
      else if (key.backspace || key.delete) setComposeDraft((d) => d.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setComposeDraft((d) => d + input);
      return;
    }

    // ── list mode ──
    // focus switch (fullscreen only): ← list pane · → transcript pane
    if (fullscreen && key.rightArrow) { setFocus("transcript"); return; }
    if (fullscreen && key.leftArrow) { setFocus("list"); return; }
    // up/down: context-sensitive — move session (list focus) or scroll transcript (transcript focus)
    const inTranscript = fullscreen && focus === "transcript";
    if (key.upArrow) { inTranscript ? scroll(1) : moveCursor(-1); return; }
    if (key.downArrow) { inTranscript ? scroll(-1) : moveCursor(1); return; }
    if (fullscreen && key.pageUp) { scroll(5); return; }
    if (fullscreen && key.pageDown) { scroll(-5); return; }
    // resize panes (fullscreen): [ narrower list · ] wider list
    if (fullscreen && input === "[") { setListWidth((w) => Math.max(MIN_LIST_WIDTH, w - 4)); return; }
    if (fullscreen && input === "]") { setListWidth((w) => w + 4); return; }

    // attach only managed sessions; external are read-only (peek transcript only)
    if (key.return && selected && !isExternal) { onIntent({ type: "attach", name: selected.session.name }); return; }
    if (input === "q") { exit(); return; }
    if (input === "f") { setFullscreen((v) => !v); return; }
    // compose a chat message (fullscreen, managed session only — external is read-only)
    if (fullscreen && input === "i" && selected && !isExternal) { setMode("compose"); setComposeDraft(""); setFocus("transcript"); return; }
    if (input === "n") { setMode("new"); setDraft(""); return; }
    // adopt an EXTERNAL session into ccmux. Cold adopt only when nobody is driving the uuid;
    // a live writer would mean a SECOND resume = forked conversation, so the blocked case
    // opens the explicit fork/takeover choice instead.
    if (input === "a" && isExternal && selItem?.ext) {
      const { dir, uuid } = selItem.ext;
      log.info({ msg: "action adopt", uuid });
      void adoptExternal(m, dir, uuid).then((r) => {
        if (r.ok) { reload(); return; }
        if (r.writers) {
          adoptTarget.current = { dir, uuid };
          setAdoptWriters(r.writers);
          setMode("adopt");
        }
      });
      return;
    }
    if (input === "s" && selected && !isExternal) { log.info({ msg: "action stop", name: selected.session.name }); void stopSession(m, selected.session.name).then(reload); return; }
    if (input === "r" && selected && !isExternal) { log.info({ msg: "action restart", name: selected.session.name }); void restartSession(m, selected.session.name).then(reload); return; }
    // delete: accept lowercase d too (footer shows "D"); opens the confirm step
    if ((input === "D" || input === "d") && selected && !isExternal) { log.info({ msg: "action delete → confirm", name: selected.session.name }); setMode("confirm"); }
  });

  const view = fullscreen ? (
    <FullscreenView items={items} externalStart={externalStart} cursor={cur} winStart={winStart} visibleCards={visibleCards} spin={spin} rcPrefix={m.rcPrefix} messages={messages} transcriptOffset={offset} focus={focus} listWidth={listWidth} handleActive={hoverHandle} hoverPane={hoverPane} hoverCard={hoverCard} composing={mode === "compose"} composeDraft={composeDraft} sending={sending} canCompose={!!selected && !isExternal} />
  ) : (
    <InlineView items={items} externalStart={externalStart} cursor={cur} spin={spin} rcPrefix={m.rcPrefix} />
  );

  return (
    <Box flexDirection="column">
      {view}
      {mode === "new" ? (
        <Box paddingX={2}>
          <Text>new session in </Text>
          <Text dimColor>{process.cwd()}</Text>
          <Text> → </Text>
          <Text color="cyan">{draft || defaultName}</Text>
          <Text>▏</Text>
        </Box>
      ) : null}
      {mode === "confirm" && selected ? (
        <Box paddingX={2}>
          <Text color="red" bold>delete {selected.session.name}? </Text>
          <Text dimColor>(history kept)  </Text>
          <Text color="red">y / d</Text>
          <Text dimColor> delete · </Text>
          <Text>n / esc</Text>
          <Text dimColor> cancel</Text>
        </Box>
      ) : null}
      {mode === "adopt" ? (
        <Box paddingX={2} flexDirection="column">
          <Text>
            <Text color="yellow" bold>session is LIVE</Text>
            <Text dimColor> — driven by {adoptWriters.map(describeWriter).join(", ")}. a second resume would fork it.</Text>
          </Text>
          <Text>
            <Text color="green" bold>f</Text>
            <Text dimColor> fork (safe copy, original untouched) · </Text>
            {adoptWriters.some((w) => w.kind === "self") ? (
              <Text dimColor>takeover unavailable (it would kill THIS session) · </Text>
            ) : (
              <>
                <Text color="red" bold>t</Text>
                <Text dimColor> takeover (kill writer, adopt original) · </Text>
              </>
            )}
            <Text>esc</Text>
            <Text dimColor> cancel</Text>
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
