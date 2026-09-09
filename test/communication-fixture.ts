import type { CommunicationAuthorizationInput } from '../src/chat/communicationAuthorizationSchema.ts';

/** Synthetic consent for isolated test recipients, never a live operation grant. */
export const communicationAuthorization = {
  basis: 'user-instruction',
  whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope:
    'Contact this isolated test recipient to exercise the requested message admission behavior.',
  userAuthorizationQuote: 'Send the fixture message to the isolated test recipient.',
  sourceMessageRef: 'fixture://user/message-1',
} satisfies CommunicationAuthorizationInput;
export const communicationAuthorizationFile = `${import.meta.dir}/fixtures/communication-authorization.json`;
