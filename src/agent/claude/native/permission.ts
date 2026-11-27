import { type InteractionReply, JsonRpcRecordSchema } from 'stitchkit/agent-executor';
import type { NativeSnapshot } from '../../../runtime/projectionSchema.ts';

/**
 * Turning a tool permission request from `stitchkit/agent-executor/claude-sdk` into CCMux's
 * answerable pending-request snapshot and mapping operator decisions back to `InteractionReply`.
 */

export type ApprovalKind = 'command' | 'file' | 'tool';
export type Decision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

/** What the runtime asks about, from the tool it wants to run. */
export function approvalKind(toolName: string): ApprovalKind {
  if (toolName === 'Bash' || toolName === 'BashOutput' || toolName === 'KillShell')
    return 'command';
  if (['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'].includes(toolName)) return 'file';
  return 'tool';
}

const SUMMARY_KEYS = ['command', 'file_path', 'path', 'url', 'pattern'] as const;

/** A short, honest description of what the tool would do, for the operator deciding about it. */
export function summarise(toolName: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return toolName;
  const entries = new Map<string, unknown>(Object.entries(input));
  const detail = SUMMARY_KEYS.reduce<string | null>((found, key) => {
    if (found !== null) return found;
    const value = entries.get(key);
    return typeof value === 'string' ? value : null;
  }, null);
  return detail === null ? toolName : `${toolName}: ${detail.slice(0, 400)}`;
}

/** Translate an operator decision into a Stitchkit `InteractionReply['reply']`. */
export function toInteractionReply(
  decision: Decision,
  input: { toolName: string; updatedInput?: Record<string, unknown> },
): InteractionReply['reply'] {
  const updatedInput =
    input.updatedInput === undefined ? undefined : JsonRpcRecordSchema.parse(input.updatedInput);
  if (decision === 'accept') {
    return {
      kind: 'approve',
      scope: 'once',
      ...(updatedInput === undefined ? {} : { updatedInput }),
    };
  }
  if (decision === 'acceptForSession') {
    return {
      kind: 'approve',
      scope: 'session',
      ...(updatedInput === undefined ? {} : { updatedInput }),
    };
  }
  if (decision === 'decline') {
    return {
      kind: 'deny',
      message: `The operator declined ${input.toolName}.`,
    };
  }
  return {
    kind: 'deny',
    message: `The operator cancelled the turn at ${input.toolName}.`,
    interrupt: true,
  };
}

/**
 * Answers to a multiple-choice ask, keyed by full question text (never by position).
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
    if (item.question in keyed) throw new Error('Questions must be distinguishable by their text');
    keyed[item.question] = answer;
  }
  return { questions, answers: keyed };
}

/** Blocking dialog kinds this host renders. Empty means no dialog kind is declared. */
export const SUPPORTED_DIALOG_KINDS = [] as const;

export function answersDialog(kind: string): boolean {
  return SUPPORTED_DIALOG_KINDS.some((supported) => supported === kind);
}

/** True when this host declares any dialog kind at all; declaring none is a supported state. */
export const declaresDialogs = (): boolean => SUPPORTED_DIALOG_KINDS.length > 0;

/** The request a person answers, carrying the arguments. */
export function approvalRequest(
  requestId: string,
  toolName: string,
  input: unknown,
  turnId: string,
): NativeSnapshot['pendingRequests'][number] {
  return {
    requestId,
    rpcId: requestId,
    kind: 'approval',
    approvalKind: approvalKind(toolName),
    turnId,
    itemId: requestId,
    reason: summarise(toolName, input),
    scope: null,
    decisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    questions: [],
    requestedAt: new Date().toISOString(),
  };
}

/** A pending approval request held by `stitchkit/agent-executor/claude-sdk`. */
export interface PendingApproval {
  request: NativeSnapshot['pendingRequests'][number];
  toolName: string;
}
