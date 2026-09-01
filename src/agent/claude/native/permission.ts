import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

/**
 * Turning a tool permission request into an answerable one, and an answer back into a result.
 *
 * This is the whole reason the native mode is worth having. In the interactive mode a permission
 * request is a drawn menu that nothing in the control plane can answer — `policyAnswers` refuses to
 * guess at a menu it cannot read, so the session strands with "a choice we don't recognise" while
 * every other signal reports it idle. Here the same request arrives as data and the answer goes back
 * as data.
 */

export type ApprovalKind = 'command' | 'file' | 'tool';
export type Decision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

/** What the runtime asks about, from the tool it wants to run. */
export function approvalKind(toolName: string): ApprovalKind {
  // Grouped by what a person is actually deciding, which is not the same as the tool's name.
  if (toolName === 'Bash' || toolName === 'BashOutput' || toolName === 'KillShell')
    return 'command';
  if (['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'].includes(toolName)) return 'file';
  // Network fetches, subagent tasks and MCP tools are neither a command nor a file. Without this
  // they had nowhere to land and would arrive as a request the projection could not classify.
  return 'tool';
}

export type { PermissionResult };

/**
 * A standing permission, in the form the runtime actually stores.
 *
 * `session` as the destination is the point: the operator said "for this session", and writing it
 * anywhere more durable would answer a different question than the one asked — a decision about one
 * conversation must not become a decision about every future one.
 */
export function sessionRule(toolName: string): PermissionUpdate {
  return {
    type: 'addRules',
    rules: [{ toolName }],
    behavior: 'allow',
    destination: 'session',
  };
}

/**
 * A decision, expressed the way the SDK requires.
 *
 * `deny` carries a REQUIRED message: a refusal with no reason reaches the model as a bare failure
 * and it will usually try the same tool again. `cancel` denies and interrupts, because cancelling is
 * a statement about the turn rather than about this one tool.
 */
export function permissionResult(
  decision: Decision,
  input: { toolName: string; updatedInput?: Record<string, unknown>; scoped?: boolean },
): PermissionResult {
  if (decision === 'accept')
    return {
      behavior: 'allow',
      ...(input.updatedInput === undefined ? {} : { updatedInput: input.updatedInput }),
    };
  if (decision === 'acceptForSession')
    return { behavior: 'allow', updatedPermissions: [sessionRule(input.toolName)] };
  if (decision === 'decline')
    return { behavior: 'deny', message: `The operator declined ${input.toolName}.` };
  return {
    behavior: 'deny',
    message: `The operator cancelled the turn at ${input.toolName}.`,
    interrupt: true,
  };
}

/**
 * Answers to a multiple-choice ask, keyed the way the runtime looks them up.
 *
 * By the FULL QUESTION TEXT, not by position. The runtime matches answers to questions by their
 * text, so an index-keyed answer silently attaches to the wrong question when the order differs —
 * a mistake that reads as the model ignoring the operator rather than as a mapping bug.
 */
export function questionAnswers(
  questions: readonly { question: string }[],
  answers: readonly string[],
): { questions: readonly { question: string }[]; answers: Record<string, string> } {
  if (answers.length !== questions.length)
    throw new Error('Every question must be answered exactly once');
  const keyed: Record<string, string> = {};
  for (const [index, item] of questions.entries()) {
    const answer = answers[index];
    if (answer === undefined) throw new Error('Every question must be answered exactly once');
    if (item.question in keyed)
      // Two identical question texts cannot be told apart by the lookup the runtime performs, so
      // answering them would attach one answer to both.
      throw new Error('Questions must be distinguishable by their text');
    keyed[item.question] = answer;
  }
  return { questions, answers: keyed };
}

/**
 * Which blocking dialog kinds this host can actually render. Empty, and that is the honest answer.
 *
 * Declaring a kind is a promise to render it: the runtime sends that kind only to clients that
 * declared it, and a declared-but-unrendered dialog parks until a deadline. The runtime supports
 * exactly this case — absence is read as "cannot display" and the flow degrades to its no-dialog
 * behaviour instead of blocking on a dialog nobody will answer.
 *
 * The other half of the rule, for when a kind IS declared: a kind this host did not declare must be
 * left unanswered rather than settled, because `cancelled` is a real settlement meaning the operator
 * dismissed it — an answer nobody gave.
 */
export const SUPPORTED_DIALOG_KINDS = [] as const;

export function answersDialog(kind: string): boolean {
  return (SUPPORTED_DIALOG_KINDS as readonly string[]).includes(kind);
}

/** True when this host declares any dialog kind at all; declaring none is a supported state. */
export const declaresDialogs = (): boolean => SUPPORTED_DIALOG_KINDS.length > 0;
