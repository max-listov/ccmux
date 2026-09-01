import type { NativeAccount } from '../../runtime/projectionSchema.ts';

/**
 * Which account a Codex session spends on, read from what the runtime says about itself.
 *
 * An identity, never a credential — the same boundary the Claude reader keeps. `requiresOpenaiAuth`
 * and any token path are deliberately absent: they describe WHERE a credential lives and answer
 * nothing about who is spending. The label is what a person recognises the account by, and it is
 * what a fleet is grouped on when one plan window is shared by many sessions.
 */
export function codexAccount(reported: unknown): NativeAccount | null {
  const account = (reported as { account?: unknown } | null)?.account ?? reported;
  if (account === null || typeof account !== 'object') return null;
  const source = account as Record<string, unknown>;
  const clip = (value: unknown, max: number): string | null => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length === 0 ? null : text.slice(0, max);
  };
  const label = clip(source.email, 256);
  const subscription = clip(source.planType, 128);
  const provider = clip(source.type, 64);
  if (label === null && subscription === null && provider === null) return null;
  return { label, organization: null, subscription, provider };
}
