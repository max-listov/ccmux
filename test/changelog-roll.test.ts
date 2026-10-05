import { expect, test } from 'bun:test';
import { rollChangelogText } from '../scripts/changelog.ts';

test('a rolled release is separated from the previous one by a blank line', () => {
  const src = '# Changelog\n\n## [Unreleased]\n\n- new thing\n\n## [0.1.0] — 2026-01-01\n\n- old\n';
  expect(rollChangelogText(src, '0.2.0', 'Headline', '2026-02-02')).toBe(
    '# Changelog\n\n## [Unreleased]\n\n## [0.2.0] — 2026-02-02\n\nHeadline\n\n- new thing\n\n## [0.1.0] — 2026-01-01\n\n- old\n',
  );
});

test('the first release in a file and an empty Unreleased behave', () => {
  expect(rollChangelogText('## [Unreleased]\n\n- a\n', '0.1.0', '', 'd')).toBe(
    '## [Unreleased]\n\n## [0.1.0] — d\n\n- a\n',
  );
  expect(rollChangelogText('## [Unreleased]\n\n## [0.1.0] — d\n', '0.2.0', '', 'e')).toBeNull();
});
