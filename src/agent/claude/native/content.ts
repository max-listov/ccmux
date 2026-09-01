import type { ContentKind } from '../../../content/schema.ts';

/**
 * Which of this project's content kinds a runtime message belongs to, if any.
 *
 * The runtime's message union has dozens of members and grows with every release. A classifier with
 * a silent default would therefore be a hole that widens over time: a member added upstream lands in
 * the default, produces nothing, and the first sign is a conversation missing part of itself with no
 * error anywhere. So every member this project has considered is listed with a verdict — mapped, or
 * deliberately not content and why — and anything else is `unhandled`, which a caller is expected to
 * record rather than discard.
 */

export type Classification =
  | { kind: ContentKind }
  | { skip: 'transport' | 'diagnostic' | 'lifecycle' }
  | { unhandled: string };

/**
 * Members that carry no conversation content.
 *
 * `transport` is protocol plumbing the operator never reads. `diagnostic` is real information about
 * the run that belongs in the journal rather than the transcript. `lifecycle` changes session state
 * without adding to the conversation.
 */
const SKIP: Readonly<Record<string, 'transport' | 'diagnostic' | 'lifecycle'>> = {
  control_request: 'transport',
  control_response: 'transport',
  control_cancel_request: 'transport',
  control_request_progress: 'transport',
  system: 'lifecycle',
  session_state_changed: 'lifecycle',
  worker_shutting_down: 'lifecycle',
  conversation_reset: 'lifecycle',
  commands_changed: 'lifecycle',
  background_tasks_changed: 'lifecycle',
  auth_status: 'diagnostic',
  api_retry: 'diagnostic',
  rate_limit_event: 'diagnostic',
  hook_started: 'diagnostic',
  hook_progress: 'diagnostic',
  hook_response: 'diagnostic',
  plugin_install: 'diagnostic',
  files_persisted: 'diagnostic',
  informational: 'diagnostic',
  notification: 'diagnostic',
  prompt_suggestion: 'diagnostic',
  memory_recall: 'diagnostic',
  mirror_error: 'diagnostic',
  elicitation_complete: 'diagnostic',
  // The runtime's own estimate of thinking spend. Deliberately NOT usage: it is documented as an
  // estimate, and this project's usage fields carry provider-reported counts. Publishing it beside
  // them would make one field mean two different things depending on which runtime filled it in.
  thinking_tokens: 'diagnostic',
};

export function classifySdkMessage(type: string): Classification {
  switch (type) {
    // Complete assistant output. Tool calls arrive inside it as blocks; a caller separates them,
    // because one message can carry both prose and a call.
    case 'assistant':
      return { kind: 'assistant' };
    // Incremental output, available only when partial messages are requested. Without it a turn is
    // silent until it finishes, which is the difference between watching and waiting.
    case 'stream_event':
      return { kind: 'assistant' };
    // Tool RESULTS arrive with the user role — there is no separate result member. A classifier that
    // reads this as operator input would attribute the runtime's own tool output to the person.
    case 'user':
      return { kind: 'tool' };
    case 'tool_progress':
    case 'tool_use_summary':
      return { kind: 'tool' };
    case 'task_started':
    case 'task_updated':
    case 'task_progress':
    case 'task_notification':
      // Subagent work. It lands in the main transcript because this project's tool observations
      // carry no parent or agent identity, so nesting cannot be represented — a real loss, recorded
      // here rather than discovered later as a flattened conversation.
      return { kind: 'tool' };
    case 'permission_denied':
      return { kind: 'request' };
    case 'local_command_output':
      return { kind: 'tool' };
    case 'result':
      return { kind: 'terminal' };
    case 'model_refusal_fallback':
    case 'model_refusal_no_fallback':
      return { kind: 'terminal' };
    case 'compact_boundary':
      // No kind exists for it. It matters anyway: usage after a compaction is not comparable with
      // usage before, and a reader without the boundary sees an unexplained drop.
      return { unhandled: 'compact_boundary' };
    default: {
      const skip = SKIP[type];
      return skip === undefined ? { unhandled: type } : { skip };
    }
  }
}

/** True when the runtime says the turn ended badly, rather than merely that it ended. */
export function isFailureResult(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const record = message as { type?: unknown; is_error?: unknown; subtype?: unknown };
  if (record.type !== 'result') return record.type === 'model_refusal_no_fallback';
  return (
    record.is_error === true || (typeof record.subtype === 'string' && record.subtype !== 'success')
  );
}

export interface ToolBlock {
  callId: string;
  name: string | null;
  lifecycle: 'running' | 'completed';
  failed: boolean;
  detail: string | null;
}

/**
 * Tool activity, from the two shapes that carry it.
 *
 * A tool CALL rides inside the finished assistant message as a `tool_use` block, and its RESULT
 * comes back with the user role as a `tool_result` block — there is no separate result message.
 * Reading only text blocks dropped both, so a conversation showed prose with unexplained gaps where
 * the agent had spent most of its time.
 */
export function toolBlocks(message: unknown): ToolBlock[] {
  if (typeof message !== 'object' || message === null) return [];
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const out: ToolBlock[] = [];
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue;
    const block = raw as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      tool_use_id?: unknown;
      is_error?: unknown;
      input?: unknown;
    };
    if (block.type === 'tool_use' && typeof block.id === 'string')
      out.push({
        callId: block.id,
        name: typeof block.name === 'string' ? block.name.slice(0, 128) : null,
        lifecycle: 'running',
        failed: false,
        detail: typeof block.name === 'string' ? summarise(block.name, block.input) : null,
      });
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string')
      out.push({
        callId: block.tool_use_id,
        name: null,
        lifecycle: 'completed',
        failed: block.is_error === true,
        detail: null,
      });
  }
  return out;
}

/**
 * The text carried by one incremental stream event, if it carries any.
 *
 * Only `text_delta`. The stream also carries block starts and stops, message envelopes and pings;
 * treating any of them as content would append empty strings between every real fragment, and
 * treating a thinking delta as assistant text would put reasoning into the transcript as speech.
 */
export function deltaText(event: unknown): string | null {
  if (typeof event !== 'object' || event === null) return null;
  const record = event as { type?: unknown; delta?: unknown };
  if (record.type !== 'content_block_delta') return null;
  const delta = record.delta as { type?: unknown; text?: unknown } | undefined;
  if (delta?.type !== 'text_delta' || typeof delta.text !== 'string') return null;
  return delta.text.length > 0 ? delta.text : null;
}

/** A short, honest description of what the tool would do, for the operator deciding about it. */
export function summarise(toolName: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return toolName;
  const record = input as Record<string, unknown>;
  const detail = ['command', 'file_path', 'path', 'url', 'pattern'].reduce<string | null>(
    (found, key) => found ?? (typeof record[key] === 'string' ? (record[key] as string) : null),
    null,
  );
  return detail === null ? toolName : `${toolName}: ${detail.slice(0, 400)}`;
}
