import { z } from "zod";
import { SelectionReadSchema } from "./selectionSchema.ts";
import { CompactRequestSchema, ContextOperationSchema, NativeHistoryPageSchema, NativeHistoryQuerySchema } from "../context/schema.ts";

export const ControlHistoryReadSchema = SelectionReadSchema.extend(NativeHistoryQuerySchema.shape).strict();
export const ControlHistoryResultSchema = NativeHistoryPageSchema.extend(SelectionReadSchema.shape).strict();
export const ControlCompactSchema = SelectionReadSchema.extend(CompactRequestSchema.shape).strict();
export const ControlContextOperationReadSchema = SelectionReadSchema.extend({ operationId: z.uuid() }).strict();
export const PublicContextOperationSchema = ContextOperationSchema.omit({ markerBefore: true }).strip();
export const ControlContextOperationResultSchema = SelectionReadSchema.extend({ operation: PublicContextOperationSchema.nullable() }).strict();
