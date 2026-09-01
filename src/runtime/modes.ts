import type { Session } from '../types.ts';

export type RuntimeMode = 'tui' | 'app-server' | 'native';

/**
 * Which execution modes each agent family has, and which of them is the structured one.
 *
 * One table, so that adding a runtime is one entry rather than a search. Spelled out at each site
 * instead, this knowledge disagrees with itself silently: a miss does not break the build, it
 * creates a session the registry then refuses, or publishes a mode name that is simply wrong.
 *
 * Deliberately free of any check against the host. Whether a runtime is INSTALLED is a different
 * question, it needs the filesystem, and this module is on the packed client's import path where
 * `node:fs` cannot go. That half lives in `availability.ts`.
 */
interface RuntimeModes {
  /** The mode in which this project speaks the runtime's own protocol. Never the terminal one. */
  native: 'app-server' | 'native';
  /** The mode in which the runtime drives its own terminal, when it has one. */
  interactive: 'tui' | null;
  /** What a control-plane create means when the caller does not say. */
  fallback: RuntimeMode;
  /**
   * The modes a control-plane create can produce, and therefore the ones the catalog offers.
   *
   * Not every mode an agent has: a codex session can run in a terminal, and one made that way at
   * the command line is perfectly valid, but nothing creates one through the control plane — so a
   * catalog row for it would offer a choice no caller of that API can make. `runtimeModeIsValid`
   * answers the wider question of what may EXIST; this answers what this API can produce.
   */
  creatable: readonly RuntimeMode[];
  /**
   * Whether the native mode still drives a terminal a person can type into.
   *
   * True only for the app-server mode, where the interactive CLI remains a client of the same
   * writer. The others take their input through this project's own mailbox and have no composer,
   * which is why `send` — which is keystrokes — has nowhere to put them.
   */
  keepsTerminal: boolean;
}

export const runtimeModes = {
  claude: {
    native: 'native',
    interactive: 'tui',
    fallback: 'tui',
    creatable: ['tui', 'native'],
    keepsTerminal: false,
  },
  codex: {
    native: 'app-server',
    interactive: 'tui',
    fallback: 'app-server',
    creatable: ['app-server'],
    keepsTerminal: true,
  },
  opencode: {
    native: 'native',
    interactive: null,
    fallback: 'native',
    creatable: ['native'],
    keepsTerminal: false,
  },
  custom: {
    native: 'native',
    interactive: null,
    fallback: 'native',
    creatable: ['native'],
    keepsTerminal: false,
  },
} satisfies Record<Session['agent'], RuntimeModes>;

/** Whether this session speaks its runtime's own protocol rather than driving a terminal. */
export function hasNativeRuntime(session: Pick<Session, 'agent' | 'runtime'>): boolean {
  return session.runtime === runtimeModes[session.agent].native;
}

/** The mode a create will actually use, so a capability check asks about the session it will make. */
export function resolveRuntimeMode(
  agent: Session['agent'],
  requested: RuntimeMode | undefined,
): RuntimeMode {
  const declared = runtimeModes[agent];
  // A request is honoured only where there is a choice to make. Everywhere else the agent has one
  // creatable mode, and a caller naming another gets the mode it has always got rather than a
  // refusal — this is the shape the control plane has always had, stated instead of implied.
  if (declared.creatable.length < 2 || requested === undefined) return declared.fallback;
  return (declared.creatable as readonly RuntimeMode[]).includes(requested)
    ? requested
    : declared.fallback;
}

/** Whether this session takes its input through a mailbox rather than through a terminal composer. */
export function hasNoComposer(session: Pick<Session, 'agent' | 'runtime'>): boolean {
  return hasNativeRuntime(session) && !runtimeModes[session.agent].keepsTerminal;
}

/** Whether an agent and a mode name each other. Used where a bad pair must be refused, not resolved. */
export function runtimeModeIsValid(agent: Session['agent'], mode: RuntimeMode): boolean {
  const declared = runtimeModes[agent];
  return mode === declared.native || mode === declared.interactive;
}
