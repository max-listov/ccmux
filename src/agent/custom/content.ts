import type { AgentMessage, AgentRuntimeEvent } from 'stitchkit/agent-runtime';
import type { ContentBuffer } from '../../content/buffer.ts';
import { customToolObservation } from './toolObservation.ts';

export function customMessageContent(content: ContentBuffer, message: AgentMessage): void {
  if (!message.runId) return;
  if (message.role === 'assistant') {
    for (const [partType, kind, suffix] of [
      ['text', 'assistant', 'assistant'],
      ['reasoning', 'reasoning-summary', 'reasoning'],
    ] as const) {
      const text = message.parts
        .flatMap((p) =>
          (p.type === 'text' || p.type === 'reasoning') && p.type === partType ? [p.text] : [],
        )
        .join('');
      if (text || partType === 'text')
        content.text(
          kind,
          message.runId,
          `${message.runId}:${suffix}`,
          text,
          'replace',
          message.status !== 'streaming',
        );
    }
  }
  for (const part of message.parts)
    if (part.type === 'tool-result')
      content.tool(
        message.runId,
        part.callId,
        customToolObservation(
          part.toolName,
          part.callId,
          part.outcome === 'success'
            ? 'succeeded'
            : part.outcome === 'interrupted'
              ? 'interrupted'
              : 'failed',
          part.output,
        ),
      );
}

export function customToolEvent(
  content: ContentBuffer,
  event: Extract<AgentRuntimeEvent, { type: 'tool-status' }>,
): void {
  content.tool(
    event.runId,
    event.callId,
    customToolObservation(
      event.toolName,
      event.callId,
      event.status === 'started'
        ? 'unknown'
        : event.status === 'failed'
          ? 'failed'
          : event.status === 'interrupted'
            ? 'interrupted'
            : 'succeeded',
      event.output,
    ),
  );
}
