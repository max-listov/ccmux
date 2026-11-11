import { z } from 'zod';

/** Who put a message into the user's side of a conversation — the verdict `messageSender.ts` gives. */
export const MessageSenderSchema = z
  .object({
    verdict: z
      .enum(['person', 'session-letter', 'routed-input', 'harness', 'ccmux-keys', 'unverifiable'])
      .describe(
        "person: entered in the provider's own client — typed, pasted, dictated, sent while a turn was running — and not by ccmux. session-letter: a letter from another session, delivered by ccmux and found in its ledger. routed-input: input that came through a router or an application, whose tag says so; its author is not a verified person. harness: the harness speaking — a hook's output, a task notification, a reminder, the output of a local command. ccmux-keys: typed into the pane by `ccmux send`. unverifiable: it reads as a delivered letter or routed input, but this machine's ledger holds no such message — or the text was read cut and cannot be judged; read it whole by its id.",
      ),
    reason: z.string().max(256),
  })
  .strict();
export type MessageSender = z.infer<typeof MessageSenderSchema>;
