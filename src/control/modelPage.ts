import { createHash } from 'node:crypto';
import type { ControlModel, ControlModelCatalog, ControlModelsRead } from './schema/model.ts';
import { refusals } from './schema/refusals.ts';

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
  const content = source.profile === undefined ? visible : [source.profile, visible];
  const digest = createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
  let offset = 0;
  if (input.cursor) {
    const [revision, start] = input.cursor.split(':');
    if (revision !== digest || !start || !/^\d+$/.test(start) || Number(start) > visible.length)
      throw refusals.errors.STALE_CURSOR({
        message: 'Native catalog cursor requires a fresh baseline',
      });
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
