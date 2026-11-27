import { z } from 'zod';
import { RC_PREFIX_RE } from '../chat/identitySchema.ts';

const path = z.string().startsWith('/');
const route = {
  peers: z.array(z.string().regex(RC_PREFIX_RE)).default([]),
  trustedAncestor: z
    .strictObject({ executable: path, argument: z.string().min(1).max(128) })
    .optional(),
};

export const RemoteTransportSchema = z.union([
  z.strictObject({
    ...route,
    kind: z.literal('stitchwire'),
    agentSocket: path.optional(),
    /** Directory for ccmux.control's descriptor, declaration and operator-supplied callers. */
    serviceDirectory: path.optional(),
  }),
  // A separately supplied implementation of the public generic adapter contract.
  z.strictObject({ ...route, socket: path.optional() }),
]);

export function stitchwireRoute(config: z.output<typeof RemoteTransportSchema> | undefined) {
  return config && 'kind' in config ? config : undefined;
}
