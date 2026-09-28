import { defineContract } from 'stitchkit/contract';
import { z } from 'zod';

/**
 * The daemon's answer to a fleet reader on another machine (`peerRead.ts`), on the local control
 * socket. Kept apart from the answers so the relaying command loads only this and a client — the
 * point of the relay is not to evaluate the code that builds the rows.
 *
 * Local and internal: served beside the published control contracts, not part of them.
 */
const KnownSchema = z.array(z.string().regex(/^[0-9a-f]{16}$/)).max(4096);
const AnswerSchema = z.record(z.string(), z.unknown());

export const peerReadContract = defineContract(
  { prefix: 'ccmux-peer-read', scope: 'local' },
  {
    list: {
      method: 'POST',
      path: '/list',
      desc: "This machine's session list, packed against the rows the reader holds",
      input: z.object({ known: KnownSchema }).strict(),
      output: AnswerSchema,
    },
    'chat-log': {
      method: 'POST',
      path: '/chat-log',
      desc: "This machine's chat log, newest rows, packed against the rows the reader holds",
      input: z.object({ limit: z.number().int().min(1).max(1000), known: KnownSchema }).strict(),
      output: AnswerSchema,
    },
  },
);
