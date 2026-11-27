import { serviceDescriptorFromContract } from '@stitchwire/client';
import { SERVICE_MAX_RESPONSE_BYTES } from '@stitchwire/client/contracts';
import { VERSION } from '../../util/version.ts';
import { controlContract } from '../schema/contract.ts';

/** The descriptor and the implementation are compiled from the same contract and release. */
export const wireControlDescriptor = serviceDescriptorFromContract(controlContract, {
  service: 'ccmux.control',
  revision: VERSION,
  maxInflight: 8,
  responseBytes: Object.fromEntries(
    Object.keys(controlContract.endpoints).map((id) => [id, SERVICE_MAX_RESPONSE_BYTES]),
  ) as Record<keyof typeof controlContract.endpoints, number>,
});
