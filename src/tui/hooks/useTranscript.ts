import { useEffect, useState } from "react";
import { tailTranscript, lastActivityMs } from "../../agent/index.ts";
import type { MachineConfig, Session, TranscriptMessage } from "../../types.ts";

/** Live transcript of the selected session (fullscreen pane). Re-reads on an interval
 *  and when the selection changes; disabled (empty) when the pane isn't shown.
 *
 *  Re-parse is GATED on the transcript file's mtime — an idle session's jsonl doesn't change,
 *  so we skip re-reading/re-parsing 300 messages and the full re-render every 1.5s (that poll
 *  was the source of the periodic jank on big transcripts). Selection change resets the gate
 *  (the effect re-runs), so switching sessions always loads fresh. */
export function useTranscript(m: MachineConfig, session: Session | null, enabled: boolean): TranscriptMessage[] {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const name = session?.name;
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
    const id = setInterval(load, 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [m, name, enabled, session]);
  return messages;
}
