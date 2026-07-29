// Model id → display label. A pure TRANSFORM, never a lookup table: a new Claude family (Fable,
// Mythos, whatever ships next) must render correctly with ZERO code change. This is the whole point
// of reading the model from jsonl (source of truth) instead of scraping it from the statusline
// against a family whitelist — the whitelist silently dropped every family it hadn't been taught.
//
//   claude-fable-5           → "Fable 5"
//   claude-opus-4-8          → "Opus 4.8"
//   claude-sonnet-4-5        → "Sonnet 4.5"
//   claude-haiku-4-5-2025…   → "Haiku 4.5"   (8-digit snapshot date dropped)
// Anything that doesn't fit the <family>-<numeric-version> shape — codex `gpt-5.6-sol`, a bare
// `opus` alias — falls back to the raw id with the provider prefix stripped: always correct, never
// invented.

const PROVIDER_PREFIX = /^claude-/;
const SNAPSHOT = /^\d{8}$/; // a YYYYMMDD model-snapshot suffix — dropped from the label

export function prettyModel(id: string | null): string | null {
  if (id === null) return null;
  const bare = id.trim().replace(PROVIDER_PREFIX, "");
  if (bare === "") return null;
  const parts = bare.split("-");
  const family = parts[0];
  const head = family?.[0];
  if (family === undefined || head === undefined || !/^[a-z]+$/.test(family)) return bare;
  const version = parts.slice(1).filter((p) => !SNAPSHOT.test(p));
  if (version.length === 0 || !version.every((p) => /^\d+$/.test(p))) return bare; // not <family>-<nums>
  return `${head.toUpperCase()}${family.slice(1)} ${version.join(".")}`;
}
