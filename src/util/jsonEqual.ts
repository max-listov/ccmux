/**
 * Whether two JSON values are the same: equal primitives, arrays equal element by element, objects
 * with the same keys and equal values, key order ignored.
 *
 * For values that came out of `JSON.parse` or a schema over it. It runs anywhere — the client package
 * root uses it and loads in a browser, where `node:util`'s `isDeepStrictEqual` does not exist.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
}
