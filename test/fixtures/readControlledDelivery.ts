import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { MessageOperationReadSchema } from '../../src/chat/messageOperationSchema.ts';
import { createControlClient } from '../../src/control/transport/client.ts';

const path = Bun.argv[2];
if (!path) throw new Error('Usage: bun test/fixtures/readControlledDelivery.ts <consumer.json>');
const manifest = z
  .object({
    client: z.object({ socket: z.string(), session: z.string(), credential: z.string() }).strict(),
    operation: MessageOperationReadSchema,
  })
  .strict()
  .parse(JSON.parse(readFileSync(path, 'utf8')));
const client = createControlClient(manifest.client);
try {
  console.log(
    JSON.stringify({
      observedAt: new Date().toISOString(),
      sessions: await client['session.list'](),
      operation: await client['message.operation'](manifest.operation),
      content: await client['native.read']({ target: manifest.operation.target, cursor: null }),
    }),
  );
} finally {
  await client.close();
}
