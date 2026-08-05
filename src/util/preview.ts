/**
 * Shorten text for a confirmation line.
 *
 * A command that echoes back the whole thing you just gave it charges twice for the same words:
 * once to write them, once to read them back. That is invisible for `/compact` and expensive for a
 * multi-paragraph message — and an agent pays it out of the same budget it needs for the work.
 *
 * A confirmation only has to prove that the RIGHT text went to the RIGHT place, so a short body is
 * shown whole (still useful, costs nothing) and a long one is cut with its full length stated, which
 * is the part that actually tells you nothing was truncated on the way out.
 */
export const PREVIEW_LIMIT = 80;

export function preview(text: string, limit = PREVIEW_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}… (${text.length} chars)` : text;
}
