import { z } from 'zod';
import type { CodexAppRpc } from '../agent/codex/rpc.ts';

const ReceiptPage = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1),
        status: z.enum(['inProgress', 'completed', 'interrupted', 'failed']),
        items: z.array(z.object({ type: z.string(), clientId: z.string().nullable().optional() })),
      }),
    )
    .max(32),
});

/** A positive match proves acceptance. A bounded negative result never authorizes resubmission. */
export async function findOwnedCodexReceipt(rpc: CodexAppRpc, threadId: string, messageId: string) {
  const page = ReceiptPage.parse(
    await rpc.request('thread/turns/list', {
      threadId,
      limit: 32,
      sortDirection: 'desc',
      itemsView: 'summary',
    }),
  );
  return (
    page.data.find((turn) =>
      turn.items.some((item) => item.type === 'userMessage' && item.clientId === messageId),
    ) ?? null
  );
}
