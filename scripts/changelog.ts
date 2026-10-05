/**
 * Move the `[Unreleased]` body into a dated `[X.Y.Z]` section (notes line prepended); null when
 * there is nothing to release. Every section, the new one included, ends with a blank line before
 * the next heading — the previous version dropped it, gluing each release to the one before.
 */
export function rollChangelogText(
  src: string,
  version: string,
  notes: string,
  today: string,
): string | null {
  const marker = '## [Unreleased]';
  const at = src.indexOf(marker);
  if (at === -1) return null;
  const afterHeader = at + marker.length;
  const nextSection = src.indexOf('\n## [', afterHeader);
  const bodyEnd = nextSection === -1 ? src.length : nextSection;
  const unreleased = src.slice(afterHeader, bodyEnd).trim();
  const merged = [notes, unreleased].filter((s) => s !== '').join('\n\n');
  if (merged === '') return null; // nothing to release — keep the discipline loud
  const rest = nextSection === -1 ? '' : `\n${src.slice(bodyEnd + 1)}`;
  return `${src.slice(0, at)}${marker}\n\n## [${version}] — ${today}\n\n${merged}\n${rest}`;
}
