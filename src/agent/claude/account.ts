import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import type { NativeAccount } from '../../runtime/projectionSchema.ts';

/**
 * Who a Claude profile is signed in as, read from the profile's own global config file.
 *
 * Only the sign-in address is read and only it is kept: the file also holds tokens-adjacent state,
 * organisation ids and a great deal else, none of which belongs in a status projection, a log or an
 * error. A file that cannot be read or parsed right now (Claude rewrites it as it works) leaves the
 * last good answer standing instead of reporting the account gone, and its parse error is never
 * reported — the runtime quotes a fragment of the input in it.
 *
 * Cached by modification time and size, so the fleet's per-poll projection costs a stat per profile.
 * The subscription is left unknown: the file names an organisation type, but that vocabulary is not
 * the one the native runtime reports, and mapping one onto the other would be an invention.
 */
/** Only the sign-in address of the file is declared; everything else in it is neither read nor kept. */
const LoginFileSchema = z.object({
  oauthAccount: z.object({ emailAddress: z.string().optional() }).optional(),
});

const cache = new Map<string, { stamp: string; email: string | null }>();

export function profileAccount(globalConfigFile: string): NativeAccount | null {
  let stamp: string;
  try {
    const stat = statSync(globalConfigFile);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
  const cached = cache.get(globalConfigFile);
  if (cached === undefined || cached.stamp !== stamp) {
    try {
      const parsed = LoginFileSchema.safeParse(JSON.parse(readFileSync(globalConfigFile, 'utf8')));
      const address = parsed.data?.oauthAccount?.emailAddress?.trim() ?? '';
      cache.set(globalConfigFile, { stamp, email: address === '' ? null : address.slice(0, 256) });
    } catch {
      // Keep the previous answer (if any) under its old stamp, so the next call tries again.
    }
  }
  const email = cache.get(globalConfigFile)?.email ?? null;
  return email === null
    ? null
    : { label: email, organization: null, subscription: null, provider: 'firstParty' };
}
