import type { ClientFetch } from 'stitchkit';
import { CCMUX_CONTROL_CALLER_HEADER } from '../src/control/transportBoundary.ts';

/** Bind the public contract client to one authenticated local CCMux Unix socket. */
export function localControlFetch(
  socket: string,
  caller: string,
  inspect?: (value: unknown) => void,
): ClientFetch {
  return async (input, init) => {
    if (typeof init?.body === 'string') inspect?.(init.body);
    const response = await fetch(String(input), {
      unix: socket,
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers)),
        [CCMUX_CONTROL_CALLER_HEADER]: caller,
      },
    });
    if (inspect !== undefined) inspect(await response.clone().text());
    return response;
  };
}
