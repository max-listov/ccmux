import { z } from 'zod';
import { AcceptedTurnOptionsSchema, NativeTurnOptionsSchema } from '../runtime/selectionSchema.ts';
import { ControlTargetSchema } from './schema.ts';

export const SelectionReadSchema = ControlTargetSchema.extend({
  registrationGeneration: z.uuid(),
}).strict();
export const SelectionResultSchema = z
  .object({
    protocol: z.literal(1),
    registrationGeneration: z.uuid(),
    current: AcceptedTurnOptionsSchema,
  })
  .strict();
export const SelectionUpdateSchema = SelectionReadSchema.extend({
  operationId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  options: NativeTurnOptionsSchema,
}).strict();
