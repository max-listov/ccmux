import { CHAT_CREDENTIAL_ENV, rotateChatCredential } from '../../chat/auth.ts';
import { selfAddress } from '../../fleet/address.ts';
import type { MachineConfig, Session } from '../../types.ts';

/**
 * Who a process inside a managed session is, as its environment says it.
 *
 * `CCMUX_SESSION` is the session's name on its machine — what the session's own `ccmux` calls
 * recognise themselves by. `CCMUX_ADDRESS` is `<machine>:<name>`, the one name every other ccmux
 * command, every machine of the fleet and `ccmux whois` use for the same session: a program inside
 * the session that reports who it is reports this, instead of composing an address from a hostname
 * that is not the machine's fleet name. The chat credential is the capability that proves the
 * process was started by the supervisor.
 *
 * All three are set here and nowhere else. They are cleared before they are set, because the
 * environment a launch is built from is the supervisor's own — and a supervisor started from inside
 * a managed session carries that session's identity, which the next one must not inherit.
 */
export const SESSION_ENV = 'CCMUX_SESSION';
export const ADDRESS_ENV = 'CCMUX_ADDRESS';
export const IDENTITY_ENV_KEYS: readonly string[] = [CHAT_CREDENTIAL_ENV, SESSION_ENV, ADDRESS_ENV];

type Env = Record<string, string | undefined>;

/** No identity at all: for a process ccmux starts that is not a session. */
export function clearIdentity<E extends Env>(env: E): E {
  for (const key of IDENTITY_ENV_KEYS) delete env[key];
  return env;
}

/** The session's name and address, without the capability — what a launch recipe describes. */
export function pinIdentity<E extends Env>(
  env: E,
  m: MachineConfig,
  session: Pick<Session, 'name'>,
): E {
  clearIdentity(env);
  Object.assign(env, {
    [SESSION_ENV]: session.name,
    [ADDRESS_ENV]: selfAddress(m, session.name),
  });
  return env;
}

/** The identity of a runtime that is starting now: the pin and a freshly rotated capability. */
export function grantIdentity<E extends Env>(env: E, m: MachineConfig, session: Session): E {
  pinIdentity(env, m, session);
  Object.assign(env, { [CHAT_CREDENTIAL_ENV]: rotateChatCredential(m, session) });
  return env;
}
