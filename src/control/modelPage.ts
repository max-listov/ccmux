import { createHash } from 'node:crypto';
import { AppError } from 'stitchkit';
import type { ControlModel, ControlModelCatalog, ControlModelsRead } from './schema/model.ts';

/**
 * One page of a model catalog, and one place that decides what a page is — for every runtime.
 *
 * A session's read and a host's read answer from the same list, and Claude's and OpenCode's catalogs
 * answer the same control call; paging any of them differently would hand a caller two cursor
 * vocabularies for what it asks as one question. The OpenCode reader carried a copy of this, down to
 * the error text.
 */
export function pageModelCatalog(
  models: readonly ControlModel[],
  input: ControlModelsRead,
  source: ControlModelCatalog['source'],
  target?: ControlModelCatalog['target'],
): ControlModelCatalog {
  const visible = input.includeHidden ? models : models.filter((model) => !model.hidden);
  const digest = createHash('sha256').update(JSON.stringify(visible)).digest('hex').slice(0, 16);
  let offset = 0;
  if (input.cursor) {
    const [revision, start] = input.cursor.split(':');
    if (revision !== digest || !start || !/^\d+$/.test(start) || Number(start) > visible.length)
      throw new AppError('INVALID_CURSOR', 'Native catalog cursor requires a fresh baseline', 409);
    offset = Number(start);
  }
  const limit = input.limit ?? 64;
  return {
    ...(target === undefined ? {} : { target }),
    source,
    data: visible.slice(offset, offset + limit),
    nextCursor: offset + limit < visible.length ? `${digest}:${offset + limit}` : null,
  };
}
