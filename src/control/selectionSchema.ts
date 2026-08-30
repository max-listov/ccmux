import { z } from "zod";
import { ControlTargetSchema } from "./schema.ts";
import { AcceptedTurnOptionsSchema, NativeTurnOptionsSchema } from "../runtime/selectionSchema.ts";

export const SelectionReadSchema = ControlTargetSchema.extend({ registrationGeneration: z.uuid() }).strict();
export const SelectionResultSchema = z.object({
  protocol: z.literal(1), registrationGeneration: z.uuid(), current: AcceptedTurnOptionsSchema,
}).strict();
export const SelectionUpdateSchema = SelectionReadSchema.extend({
  operationId: z.uuid(), expectedRevision: z.number().int().nonnegative(), options: NativeTurnOptionsSchema,
}).strict();
