import type { NativeAccount } from '../../../runtime/projectionSchema.ts';

/**
 * What the runtime reports about the account a session runs on.
 *
 * `tokenSource` and `apiKeySource` are deliberately absent from what this reads: they name WHERE a
 * credential comes from, which is a step toward the credential and answers nothing about who is
 * spending. The question this exists for is "which sessions share an account", and the label is
 * what answers it.
 */
export interface ReportedAccount {
  email?: string | undefined;
  organization?: string | undefined;
  subscriptionType?: string | undefined;
  apiProvider?: string | undefined;
}

const clip = (value: string | undefined, max: number): string | null => {
  const trimmed = (value ?? '').trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
};

export function nativeAccount(reported: ReportedAccount): NativeAccount {
  return {
    // The email when there is one, else the organization: a label nobody recognises groups nothing,
    // and an invented one would group sessions that do not share an account.
    label: clip(reported.email, 256) ?? clip(reported.organization, 256),
    organization: clip(reported.organization, 256),
    subscription: clip(reported.subscriptionType, 128),
    provider: clip(reported.apiProvider, 64),
  };
}

/** True when the runtime said nothing at all — which is not the same as running on no account. */
export function accountIsEmpty(account: NativeAccount): boolean {
  return (
    account.label === null &&
    account.organization === null &&
    account.subscription === null &&
    account.provider === null
  );
}
