import type { CommunicationAuthorization } from '../src/chat/communicationAuthorizationSchema.ts';

/** Synthetic consent for isolated test recipients, never a live operation grant. */
export const communicationAuthorization: CommunicationAuthorization = {
  whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope:
    'Contact this isolated test recipient to exercise the requested message admission behavior.',
  userAuthorizationQuote: 'Send the fixture message to the isolated test recipient.',
  sourceMessageRef: 'fixture://user/message-1',
};
export const communicationAuthorizationFile = `${import.meta.dir}/fixtures/communication-authorization.json`;
