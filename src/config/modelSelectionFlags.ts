import type { z } from 'zod';
import type { ModelSelectionSchema } from './schema.ts';

export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

export function modelSelectionFlags(selection: ModelSelection | undefined): string[] {
  return selection === undefined
    ? []
    : [
        '-c',
        `model=${JSON.stringify(selection.model)}`,
        '-c',
        `model_provider=${JSON.stringify(selection.provider)}`,
      ];
}
