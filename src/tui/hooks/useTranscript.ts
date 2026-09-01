import { existsSync, type FSWatcher, watch } from 'node:fs';
import { useEffect, useState } from 'react';
import { lastActivityMs, tailTranscript, transcriptPath } from '../../agent/index.ts';
import type { MachineConfig, Session, TranscriptMessage } from '../../types.ts';

/** Slower than the old poll on purpose: the watch carries the latency, this only carries the misses. */
const BACKSTOP_MS = 4_000;

/** Live transcript of the selected session (fullscreen pane); disabled (empty) when not shown.
 *
 *  Driven by the FILE, not by a clock. What a reader waits for is "the agent answered", and that is
 *  a write to the jsonl — on an interval alone the wait was up to a poll long for no reason but the
 *  interval. The timer stays as a backstop, slower: `fs.watch` misses events on some filesystems
 *  and over network mounts, and a transcript that quietly stops updating is worse than a late one.
 *
 *  Re-parse is GATED on the transcript file's mtime — an idle session's jsonl doesn't change, so an
 *  event or a tick that changes nothing costs no re-read, no re-parse and no re-render, which is
 *  what keeps the idle-CPU invariant. Selection change resets the gate (the effect re-runs), so
 *  switching sessions always loads fresh. */
export function useTranscript(
  m: MachineConfig,
  session: Session | null,
  enabled: boolean,
): TranscriptMessage[] {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  useEffect(() => {
    if (!enabled || !session) {
      setMessages([]);
      return;
    }
    let alive = true;
    let lastMtime = -1;
    const load = (): void => {
      const mtime = lastActivityMs(session, m) ?? 0;
      if (mtime === lastMtime) return; // file unchanged → nothing to re-parse or re-render
      lastMtime = mtime;
      const msgs = tailTranscript(session, m, 300);
      if (alive) setMessages(msgs);
    };
    load();
    // A watch is an optimisation, never the only path: a filesystem that cannot watch, or a file
    // that does not exist yet, must still end up read by the backstop below.
    let watcher: FSWatcher | null = null;
    try {
      const path = transcriptPath(session, m);
      if (path !== null && existsSync(path)) watcher = watch(path, () => load());
    } catch {
      watcher = null;
    }
    const id = setInterval(load, BACKSTOP_MS);
    return () => {
      alive = false;
      watcher?.close();
      clearInterval(id);
    };
  }, [m, enabled, session]);
  return messages;
}
