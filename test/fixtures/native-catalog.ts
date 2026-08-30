import { dirname } from 'node:path';
import { z } from 'zod';
import { ownedCodexSocket, privateRuntimeDirectory } from '../../src/agent/codex/ownedPaths.ts';
import type { MachineConfig, Session } from '../../src/types.ts';

export function nativeCatalogFixture(m: MachineConfig, session: Session) {
  const socket = ownedCodexSocket(m, session.name);
  privateRuntimeDirectory(dirname(socket));
  const RequestSchema = z.object({
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string(),
  });
  return Bun.serve({
    unix: socket,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(ws, value) {
        const request = RequestSchema.parse(JSON.parse(String(value)));
        if (request.id === undefined) return;
        const model = session.modelSelection?.model ?? 'model-a';
        const result =
          request.method === 'initialize'
            ? { userAgent: 'codex/0.151.0' }
            : request.method === 'config/read'
              ? { config: { model_provider: 'openai' } }
              : {
                  data: [
                    {
                      id: model,
                      model,
                      displayName: model,
                      description: 'fixture',
                      hidden: false,
                      isDefault: true,
                      inputModalities: ['text', 'image'],
                      serviceTiers: [],
                      supportedReasoningEfforts: [
                        { reasoningEffort: 'medium', description: 'fixture' },
                      ],
                      defaultReasoningEffort: 'medium',
                    },
                  ],
                  nextCursor: null,
                };
        ws.send(JSON.stringify({ id: request.id, result }));
      },
    },
  });
}
