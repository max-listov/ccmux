import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
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

/** Compile-time proof that the classifier is asked about the union's own discriminant. */
export const classifyMessage = (message: Pick<SDKMessage, 'type'>): Classification =>
  classifySdkMessage(message.type);
