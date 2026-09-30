import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const RequestSchema = z.object({ method: z.string(), id: z.number().optional() });
/** Read-only synthetic App Server; no provider writer or model invocation. */
export function createDaemonBenchProvider(home: string, ids: string[]) {
  const directory = join(home, 'app-server-control');
  mkdirSync(directory, { recursive: true });
  return Bun.serve({
    unix: join(directory, 'app-server-control.sock'),
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(ws, bytes) {
        const request = RequestSchema.parse(JSON.parse(String(bytes)));
        if (request.id === undefined) return;
        const result =
          request.method === 'initialize'
            ? { userAgent: 'codex/0.150.0-alpha.12.2' }
            : request.method === 'thread/list'
              ? {
                  data: ids.map((id) => ({
                    id,
                    name: 'Synthetic thread',
                    cwd: home,
                    status: { type: 'idle' },
                    updatedAt: 1787900000,
                  })),
                  nextCursor: null,
                }
              : request.method === 'model/list'
                ? { data: [], nextCursor: null }
                : request.method === 'collaborationMode/list'
                  ? { data: [] }
                  : undefined;
        ws.send(
          JSON.stringify(
            result === undefined
              ? {
                  id: request.id,
                  error: { code: -32601, message: 'Read-only benchmark operation unavailable' },
                }
              : { id: request.id, result },
          ),
        );
      },
    },
  });
}
