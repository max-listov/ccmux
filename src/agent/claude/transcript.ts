import type { TranscriptKind, TranscriptMessage, TranscriptRole } from "../../types.ts";
import { DEFAULT_TEXT_LIMIT, asText, clip, flattenContent, num, rec, str } from "../normalize.ts";
import { resultSummary } from "../toolSummary.ts";

// Claude Code transcript parser. Entry shape (one per JSONL line):
//   { type:"assistant"|"user"|…, message:{ role, content:[…], usage }, uuid, timestamp, … }
// content items are inline: { type:"text"|"thinking"|"tool_use" } and tool_result (user side).

/** content is an array of items, a bare string (→ single text item), or absent. */
function contentItems(entry: Record<string, unknown>): unknown[] {
  const content = rec(entry.message)?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

function kindFor(item: Record<string, unknown>): TranscriptKind {
  switch (str(item.type) ?? "") {
    case "text": return "message";
    case "tool_use": return "tool_call";
    case "tool_result": return "tool_result";
    case "thinking": return "thinking";
    case "": return "unknown";
    default: return "event";
  }
}

function roleFor(entry: Record<string, unknown>, item: Record<string, unknown>): TranscriptRole {
  if (str(item.type) === "tool_result") return "tool";
  const role = str(rec(entry.message)?.role) ?? str(entry.type);
  if (role === "user" || role === "assistant" || role === "system") return role;
  return "unknown";
}

function textFor(item: Record<string, unknown>): string {
  switch (str(item.type) ?? "") {
    case "text":
      return str(item.text) ?? "";
    case "tool_use": {
      const input = rec(item.input);
      const q0 = Array.isArray(input?.questions) ? rec(input.questions[0]) : null;
      return (
        str(input?.description) ??
        str(input?.command) ??
        str(input?.file_path) ??
        str(input?.pattern) ??
        str(input?.query) ??
        str(input?.url) ??
        str(input?.prompt) ??
        str(q0?.question) ??
        flattenContent(input) ??
        str(item.name) ??
        ""
      );
    }
    case "tool_result":
      return asText(item.content) ?? "";
    case "thinking":
      return str(item.thinking) ?? "";
    case "image":
      return "[image]";
    default:
      return asText(item) ?? "";
  }
}

// Raw bits a tool_result carries, kept aside by call-id so the fold can summarize it against
// its originating tool_call's input (full content, before any display clip).
interface RawResult {
  content: string;
  isError: boolean;
}

export function parse(lines: string[], startLine: number, textLimit: number = DEFAULT_TEXT_LIMIT, endLine?: number): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  const callInput = new Map<string, Record<string, unknown> | null>(); // call-id → tool_use input
  const callName = new Map<string, string>(); // call-id → tool name
  const results = new Map<string, RawResult>(); // call-id → raw tool_result
  const end = endLine !== undefined ? Math.min(lines.length, endLine) : lines.length;
  for (let i = Math.max(0, startLine - 1); i < end; i++) {
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
    if (!entry) continue;
    const entryUuid = str(entry.uuid) ?? String(seq);
    const createdAt = str(entry.timestamp);
    contentItems(entry).forEach((itemRaw, key) => {
      const item = rec(itemRaw);
      if (!item) return;
      const kind = kindFor(item);
      const text0 = textFor(item);
      const text = text0 === "" ? null : clip(text0, textLimit);
      const callId = str(item.id) ?? str(item.tool_use_id);
      const rawInput = rec(item.input);
      if (kind === "tool_call" && callId) {
        callInput.set(callId, rawInput);
        callName.set(callId, str(item.name) ?? "tool");
      }
      if (kind === "tool_result" && callId) {
        results.set(callId, { content: asText(item.content) ?? "", isError: item.is_error === true });
      }
      if (!(kind === "tool_call" || (text !== null && text !== ""))) return;
      out.push({
        id: `${entryUuid}:${key}`,
        seq,
        createdAt,
        role: roleFor(entry, item),
        kind,
        text,
        title: kind === "tool_call" ? (str(item.name) ?? "tool") : kind === "tool_result" ? "tool result" : null,
        toolName: kind === "tool_call" ? str(item.name) : null,
        toolCallId: callId,
        status: item.is_error === true ? "error" : null,
        rawType: str(item.type) ?? str(entry.type),
        done: false,
        result: null,
        // Full tool input (the actual command/args) for the expanded card; result output is
        // filled in by foldResults once its tool_result arrives.
        input: kind === "tool_call" && rawInput ? clip(JSON.stringify(rawInput, null, 2), textLimit) : null,
        resultText: null,
      });
    });
  }
  return foldResults(out, callInput, callName, results, textLimit);
}

/** Merge each tool_result into the tool_call it answers: set `done`/`status`/`result` on the
 *  call and DROP the now-redundant standalone result. A result whose call isn't in this window
 *  is left as-is (rare; keeps the data). The card UI then renders one request→outcome block. */
function foldResults(
  msgs: TranscriptMessage[],
  callInput: Map<string, Record<string, unknown> | null>,
  callName: Map<string, string>,
  results: Map<string, RawResult>,
  textLimit: number,
): TranscriptMessage[] {
  const folded = new Set<string>(); // call-ids whose result got absorbed
  for (const m of msgs) {
    if (m.kind !== "tool_call" || !m.toolCallId) continue;
    const r = results.get(m.toolCallId);
    if (!r) continue; // still running → stays pending (done:false)
    m.done = true;
    m.status = r.isError ? "error" : null;
    m.result = resultSummary(callName.get(m.toolCallId) ?? m.toolName ?? "tool", callInput.get(m.toolCallId) ?? null, r.content, r.isError);
    m.resultText = clip(r.content, textLimit); // full output for the expanded card
    folded.add(m.toolCallId);
  }
  return msgs.filter((m) => !(m.kind === "tool_result" && m.toolCallId !== null && folded.has(m.toolCallId)));
}

/** Context tokens used — the most recent assistant message's usage (input + cache). */
export function usedTokens(lines: string[]): number | null {
  const floor = Math.max(0, lines.length - 400);
  for (let i = lines.length - 1; i >= floor; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const entry = rec(JSON.parse(line));
      const msg = rec(entry?.message);
      if (msg?.role !== "assistant") continue;
      const u = rec(msg.usage);
      if (u) return num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    } catch {
      // skip malformed line
    }
  }
  return null;
}
