import { z } from 'zod';
import { RC_PREFIX_RE } from '../chat/identitySchema.ts';

const path = z.string().startsWith('/');

/** The machine's route to its peers: the Stitchwire agent on this machine. */
export const RemoteTransportSchema = z.strictObject({
  kind: z.literal('stitchwire'),
  peers: z.array(z.string().regex(RC_PREFIX_RE)).default([]),
  trustedAncestor: z
    .strictObject({ executable: path, argument: z.string().min(1).max(128) })
    .optional(),
  agentSocket: path.optional(),
  /** Directory for stitchmux.control's descriptor, declaration and operator-supplied callers. */
  serviceDirectory: path.optional(),
});
