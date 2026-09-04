import { z } from 'zod';
import { RC_PREFIX_RE } from '../config/schema.ts';

/** Authenticated local transports may preserve the caller node at the CCMux Unix boundary. */
export const CCMUX_CONTROL_CALLER_HEADER = 'x-ccmux-caller';

export const ControlTransportCallerSchema = z.string().max(128).regex(RC_PREFIX_RE);
