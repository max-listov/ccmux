import type { TranscriptMessage, TranscriptRole } from "../../types.ts";
import { DEFAULT_TEXT_LIMIT, asText, clip, num, rec, str } from "../normalize.ts";
import { resultSummary } from "../toolSummary.ts";

// Codex transcript parser. Rollout JSONL (OpenAI Responses items). Entry shape:
//   { type:"response_item"|"event_msg"|"session_meta"|…, payload:{…}, timestamp }
// Real turns live in response_item.payload.type:
//   message (content[] of input_text/output_text), function_call (top-level, args is a
//   JSON string), function_call_output, reasoning (encrypted → no plaintext).
// Token usage lives in a SEPARATE event_msg of type "token_count".

function mapRole(role: string | null): TranscriptRole {
  if (role === "user" || role === "assistant" || role === "system") return role;
  if (role === "developer") return "system"; // Codex's system-prompt channel
  return "unknown";
}

/** function_call args is a JSON string — pull the human-meaningful field, else raw. */
function toolText(payload: Record<string, unknown>): string {
  const argsRaw = str(payload.arguments);
  if (argsRaw) {
    try {
      const a = rec(JSON.parse(argsRaw));
      const picked =
        str(a?.cmd) ?? str(a?.command) ?? str(a?.description) ?? str(a?.file_path) ?? str(a?.query);
      if (picked) return picked;
    } catch {
      // fall through to raw args
    }
    return argsRaw;
  }
  return str(payload.name) ?? "";
}

interface Pushed {
  role: TranscriptRole;
  kind: TranscriptMessage["kind"];
  text: string | null;
  title: string | null;
  toolName: string | null;
  toolCallId: string | null;
  status: "error" | null;
  rawType: string | null;
}

/** One response_item payload → 0..N messages (message → per content item; else single). */
function fromPayload(payload: Record<string, unknown>, textLimit: number): Pushed[] {
  const ptype = str(payload.type) ?? "";
  const cut = (s: string): string | null => (s === "" ? null : clip(s, textLimit));
  switch (ptype) {
    case "message": {
      const role = mapRole(str(payload.role));
      const content = Array.isArray(payload.content) ? payload.content : [];
      return content.flatMap((itemRaw): Pushed[] => {
        const item = rec(itemRaw);
        const text = cut(str(item?.text) ?? "");
        if (text === null) return [];
        return [{ role, kind: "message", text, title: null, toolName: null, toolCallId: null, status: null, rawType: str(item?.type) }];
      });
    }
    case "function_call":
    case "local_shell_call":
    case "web_search_call": {
      const name = str(payload.name) ?? (ptype === "web_search_call" ? "web_search" : "tool");
      return [{
        role: "assistant",
        kind: "tool_call",
        text: cut(ptype === "web_search_call" ? (str(payload.query) ?? name) : toolText(payload)),
        title: name,
        toolName: name,
        toolCallId: str(payload.call_id) ?? str(payload.id),
        status: null,
        rawType: ptype,
      }];
    }
    case "function_call_output":
    case "local_shell_call_output": {
      const out = rec(payload.output);
      const text = cut(asText(out?.content ?? payload.output) ?? "");
      return [{
        role: "tool",
        kind: "tool_result",
        text,
        title: "tool result",
        toolName: null,
        toolCallId: str(payload.call_id),
        status: out?.success === false ? "error" : null,
        rawType: ptype,
      }];
    }
    case "reasoning":
      // Codex ships reasoning encrypted (no plaintext summary) — surface a marker.
      return [{ role: "assistant", kind: "thinking", text: "[reasoning]", title: null, toolName: null, toolCallId: null, status: null, rawType: ptype }];
    default:
      return [];
  }
}

export function parse(lines: string[], startLine: number, textLimit: number = DEFAULT_TEXT_LIMIT): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  const callArgs = new Map<string, Record<string, unknown> | null>();
  const callName = new Map<string, string>();
  const results = new Map<string, RawResult>();
  for (let i = Math.max(0, startLine - 1); i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || raw.trim() === "") continue;
    const seq = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const entry = rec(parsed);
    if (!entry || str(entry.type) !== "response_item") continue;
    const payload = rec(entry.payload);
    if (!payload) continue;
    const createdAt = str(entry.timestamp);
    // Stash raw call args + outputs by call-id so the fold can summarize each result.
    const ptype = str(payload.type) ?? "";
    const callId = str(payload.call_id) ?? str(payload.id);
    if ((ptype === "function_call" || ptype === "local_shell_call" || ptype === "web_search_call") && callId) {
      callName.set(callId, str(payload.name) ?? "tool");
      callArgs.set(callId, parseArgs(payload));
    }
    if ((ptype === "function_call_output" || ptype === "local_shell_call_output") && callId) {
      const o = rec(payload.output);
      results.set(callId, { content: asText(o?.content ?? payload.output) ?? "", isError: o?.success === false });
    }
    fromPayload(payload, textLimit).forEach((p, key) => {
      const args =
        p.kind === "tool_call" && p.toolCallId ? (callArgs.get(p.toolCallId) ?? null) : null;
      out.push({
        id: `${p.toolCallId ?? String(seq)}:${key}`,
        seq,
        createdAt,
        role: p.role,
        kind: p.kind,
        text: p.text,
        title: p.title,
        toolName: p.toolName,
        toolCallId: p.toolCallId,
        status: p.status,
        rawType: p.rawType,
        done: false,
        result: null,
        // Full tool input for the expanded card; result output filled in by foldResults.
        input: args ? clip(JSON.stringify(args, null, 2), textLimit) : null,
        resultText: null,
      });
    });
  }
  return foldResults(out, callArgs, callName, results, textLimit);
}

interface RawResult {
  content: string;
  isError: boolean;
}

/** function_call.arguments is a JSON string — parse it to a record for the result summarizer. */
function parseArgs(payload: Record<string, unknown>): Record<string, unknown> | null {
  const argsRaw = str(payload.arguments);
  if (!argsRaw) return null;
  try {
    return rec(JSON.parse(argsRaw));
  } catch {
    return null;
  }
}

/** Same fold as the Claude adapter: merge each result into its call, drop the standalone result. */
function foldResults(
  msgs: TranscriptMessage[],
  callArgs: Map<string, Record<string, unknown> | null>,
  callName: Map<string, string>,
  results: Map<string, RawResult>,
  textLimit: number,
): TranscriptMessage[] {
  const folded = new Set<string>();
  for (const m of msgs) {
    if (m.kind !== "tool_call" || !m.toolCallId) continue;
    const r = results.get(m.toolCallId);
    if (!r) continue;
    m.done = true;
    m.status = r.isError ? "error" : null;
    m.result = resultSummary(callName.get(m.toolCallId) ?? m.toolName ?? "tool", callArgs.get(m.toolCallId) ?? null, r.content, r.isError);
    m.resultText = clip(r.content, textLimit); // full output for the expanded card
    folded.add(m.toolCallId);
  }
  return msgs.filter((m) => !(m.kind === "tool_result" && m.toolCallId !== null && folded.has(m.toolCallId)));
}

/** Context tokens used — the most recent token_count event's prompt size. */
export function usedTokens(lines: string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const entry = rec(JSON.parse(line));
      if (str(entry?.type) !== "event_msg") continue;
      const payload = rec(entry?.payload);
      if (str(payload?.type) !== "token_count") continue;
      const info = rec(payload?.info);
      const usage = rec(info?.last_token_usage) ?? rec(info?.total_token_usage);
      const n = num(usage?.input_tokens);
      return n > 0 ? n : null;
    } catch {
      // skip malformed line
    }
  }
  return null;
}
