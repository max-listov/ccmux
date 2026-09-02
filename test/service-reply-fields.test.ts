import { expect, test } from 'bun:test';
import { z } from 'zod';
import { issueFields } from '../src/control/serviceClient.ts';

const issuesOf = (schema: z.ZodType, value: unknown) => {
  const parsed = schema.safeParse(value);
  if (parsed.success) throw new Error('fixture parsed cleanly — nothing to report');
  return [...new Set(parsed.error.issues.flatMap(issueFields))];
};

test('a client older than the daemon is told which field it does not know', () => {
  // The shape of a real version skew: a strict result schema meets a field added since. The
  // unrecognized-key issue stops its path at the OBJECT, so reporting the path alone says
  // "evidence" — enough to know something is wrong, not enough to know it is a version behind.
  // A consumer hit exactly this and could not tell "update your package" from "the service is
  // broken"; answering that cost a round trip through a person.
  const older = z
    .object({
      outcome: z.string(),
      evidence: z.object({ state: z.string() }).strict().nullable(),
    })
    .strict();
  expect(
    issuesOf(older, {
      outcome: 'available',
      evidence: { state: 'queued', hold: { kind: 'menu' } },
    }),
  ).toEqual(['evidence.hold']);
});

test('ordinary mismatches keep their own path', () => {
  const schema = z.object({ outcome: z.string(), count: z.number() }).strict();
  expect(issuesOf(schema, { outcome: 'available', count: 'seven' })).toEqual(['count']);
  // A failure with no path at all is named rather than reported as an empty string, which would
  // read as "no field" — the one answer that is never true.
  expect(issuesOf(z.string(), 7)).toEqual(['(root)']);
});

test('field names only, never the values that were there', () => {
  // A value can carry someone's message body. The same rule the request side follows: a mismatch is
  // identified by where it is, not by what was in it.
  const schema = z.object({ body: z.number() }).strict();
  const reported = issuesOf(schema, { body: 'a private sentence someone wrote' });
  expect(reported).toEqual(['body']);
  expect(reported.join(' ')).not.toContain('private');
});
