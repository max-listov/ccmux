import { z } from 'zod';

/**
 * What one control operation does to the owner's state, said by the operation itself.
 *
 * `read` and `write` are the two words a declared-service transport classifies by: a grant to read a
 * service admits every `read` operation without naming it, so what counts as reading is decided here,
 * by the owner of the operation, and a transport only projects it.
 *
 * Every operation declares one (`test/control-service.test.ts`); one that says nothing does not
 * compile. There is no default because the failure this replaced was a silent one: a hand-kept list
 * of reads beside the contract, written at one release, which declared every operation added after
 * it a write — and the descriptor holding it was never updated at all.
 */
export const ServiceEffectSchema = z.enum(['read', 'write']);
export type ServiceEffect = z.infer<typeof ServiceEffectSchema>;

/** The `meta` every control operation carries. */
export type ControlEndpointMeta = { readonly service: ServiceEffect };

/** Changes nothing on the owner; a caller granted to read the service may call it. */
export const SERVICE_READ = { service: 'read' } as const satisfies ControlEndpointMeta;
/** Changes the owner's state; a caller needs a grant naming this operation. */
export const SERVICE_WRITE = { service: 'write' } as const satisfies ControlEndpointMeta;
